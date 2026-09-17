import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { git } from './exec.js';
import { normalizeRemoteUrl, type NormalizedRemote } from './remote-url.js';
import { pathExists, readFileOrNull } from '../util/fs-atomic.js';
import { toTimestamp, type Timestamp } from '../util/time.js';

/**
 * Repository state, read two ways.
 *
 * `readRepoFast` parses `.git` directly from the filesystem and spawns no
 * processes. Scanning a home directory means touching hundreds of repositories;
 * at roughly 5-20ms per `git` spawn, doing it properly would cost seconds of
 * wall clock for information we can read in microseconds.
 *
 * `readRepoFull` shells out to git and is used when the user is looking at one
 * project, where correctness matters more than a few milliseconds. Working-tree
 * dirtiness in particular cannot be determined without git.
 */

export interface FastRepoInfo {
  /** Absolute path to the working tree root. */
  root: string;
  /** Resolved `.git` directory for this worktree. */
  gitDir: string;
  /** Shared `.git` directory - differs from `gitDir` inside a linked worktree. */
  commonGitDir: string;
  isWorktree: boolean;
  /** Main working tree path when this is a linked worktree, else null. */
  worktreeOf: string | null;
  isBare: boolean;
  branch: string | null;
  head: string | null;
  /** Remote name -> sanitized URL. Credentials are already stripped. */
  remotes: Map<string, NormalizedRemote>;
  /** The remote used for identity: `origin` when present, else the first one. */
  primaryRemote: NormalizedRemote | null;
  /** Last time a ref moved, from filesystem mtimes. Approximate by design. */
  lastRefActivityAt: Timestamp | null;
}

export interface FullRepoInfo extends FastRepoInfo {
  dirty: boolean;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
  /** Up to `changedFileLimit` paths, relative to the repo root. */
  changedFiles: string[];
  lastCommit: CommitInfo | null;
  defaultBranch: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  authoredAt: Timestamp;
  authorName: string;
}

/**
 * Walk up from `startDir` looking for a repository root.
 *
 * Deliberately filesystem-based rather than `git rev-parse --show-toplevel`:
 * this runs on every Claude Code session start, where a process spawn is a
 * meaningful share of the latency budget.
 */
export async function findRepoRoot(startDir: string, maxDepth = 64): Promise<string | null> {
  let current = resolve(startDir);
  for (let depth = 0; depth < maxDepth; depth++) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export async function readRepoFast(root: string): Promise<FastRepoInfo | null> {
  const dotGit = join(root, '.git');
  const resolved = await resolveGitDir(dotGit);
  if (!resolved) return null;

  const { gitDir, isWorktree } = resolved;
  const commonGitDir = await resolveCommonGitDir(gitDir, isWorktree);
  const worktreeOf = isWorktree ? dirname(commonGitDir) : null;

  const config = await parseGitConfig(join(commonGitDir, 'config'));
  const remotes = new Map<string, NormalizedRemote>();
  for (const [name, url] of config.remotes) {
    const normalized = normalizeRemoteUrl(url);
    if (normalized) remotes.set(name, normalized);
  }

  const headRaw = await readFileOrNull(join(gitDir, 'HEAD'));
  const { branch, head } = await resolveHead(headRaw, gitDir, commonGitDir);

  return {
    root: resolve(root),
    gitDir,
    commonGitDir,
    isWorktree,
    worktreeOf,
    isBare: config.bare,
    branch,
    head,
    remotes,
    primaryRemote: remotes.get('origin') ?? remotes.values().next().value ?? null,
    lastRefActivityAt: await lastRefActivity(gitDir, commonGitDir),
  };
}

export interface FullRepoOptions {
  /** Cap on how many changed paths are read. Checkpoints only need a sample. */
  changedFileLimit?: number;
  timeoutMs?: number;
}

export async function readRepoFull(
  root: string,
  options: FullRepoOptions = {},
): Promise<FullRepoInfo | null> {
  const fast = await readRepoFast(root);
  if (!fast) return null;

  const timeoutMs = options.timeoutMs ?? 5_000;
  const limit = options.changedFileLimit ?? 50;

  const [statusResult, logResult, defaultBranch, tracking] = await Promise.all([
    git(['status', '--porcelain=v1', '--untracked-files=normal', '-z'], { cwd: root, timeoutMs }),
    git(['log', '-1', '--format=%H%x1f%at%x1f%an%x1f%s'], { cwd: root, timeoutMs }),
    readDefaultBranch(root, timeoutMs),
    readTracking(root, timeoutMs),
  ]);

  const status = parsePorcelainStatus(statusResult.ok ? statusResult.stdout : '', limit);

  return {
    ...fast,
    ...status,
    lastCommit: parseLogLine(logResult.ok ? logResult.stdout : ''),
    defaultBranch,
    ahead: tracking.ahead,
    behind: tracking.behind,
  };
}

// ---------------------------------------------------------------------------
// .git resolution
// ---------------------------------------------------------------------------

async function resolveGitDir(
  dotGitPath: string,
): Promise<{ gitDir: string; isWorktree: boolean } | null> {
  let info;
  try {
    info = await stat(dotGitPath);
  } catch {
    return null;
  }

  if (info.isDirectory()) return { gitDir: dotGitPath, isWorktree: false };

  // A `.git` *file* means a linked worktree or a submodule; it holds a pointer.
  const contents = await readFileOrNull(dotGitPath);
  const match = contents ? /^gitdir:\s*(.+?)\s*$/m.exec(contents) : null;
  if (!match) return null;

  const target = match[1]!;
  const gitDir = isAbsolute(target) ? target : resolve(dirname(dotGitPath), target);
  // Linked worktrees live under `<common>/worktrees/<name>`; submodules under
  // `<parent>/modules/<name>`. Only the former is another view of one project.
  const isWorktree = /[/\\]worktrees[/\\][^/\\]+$/.test(gitDir.replace(/[/\\]+$/, ''));
  return { gitDir, isWorktree };
}

async function resolveCommonGitDir(gitDir: string, isWorktree: boolean): Promise<string> {
  if (!isWorktree) return gitDir;
  const pointer = await readFileOrNull(join(gitDir, 'commondir'));
  if (!pointer) return gitDir;
  const target = pointer.trim();
  return isAbsolute(target) ? target : resolve(gitDir, target);
}

// ---------------------------------------------------------------------------
// .git/config
// ---------------------------------------------------------------------------

interface ParsedGitConfig {
  remotes: Map<string, string>;
  bare: boolean;
}

/**
 * Minimal git-config parser: enough for `[remote "x"] url = ...` and `bare`.
 *
 * Intentionally not a general INI parser. It handles the subset git actually
 * writes, and anything it does not understand is ignored rather than guessed
 * at - a misparsed remote would mean a wrong project identity.
 */
export async function parseGitConfig(configPath: string): Promise<ParsedGitConfig> {
  const remotes = new Map<string, string>();
  let bare = false;

  const raw = await readFileOrNull(configPath);
  if (!raw) return { remotes, bare };

  let section = '';
  let subsection: string | null = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = /^\[([^\s\]]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.toLowerCase();
      subsection = sectionMatch[2] !== undefined ? unescapeConfigValue(sectionMatch[2]) : null;
      continue;
    }

    const kvMatch = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1]!.toLowerCase();
    const value = stripInlineComment(kvMatch[2]!.trim());

    if (section === 'remote' && subsection && key === 'url' && !remotes.has(subsection)) {
      remotes.set(subsection, unescapeConfigValue(value));
    } else if (section === 'core' && key === 'bare') {
      bare = value.toLowerCase() === 'true';
    }
  }

  return { remotes, bare };
}

function stripInlineComment(value: string): string {
  if (value.startsWith('"')) {
    const closing = findClosingQuote(value);
    return closing === -1 ? value : value.slice(0, closing + 1);
  }
  const hash = value.search(/\s[#;]/);
  return hash === -1 ? value : value.slice(0, hash).trim();
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === '"') return i;
  }
  return -1;
}

function unescapeConfigValue(value: string): string {
  const unquoted =
    value.startsWith('"') && value.endsWith('"') && value.length >= 2
      ? value.slice(1, -1)
      : value;
  return unquoted.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      default:
        return char;
    }
  });
}

// ---------------------------------------------------------------------------
// HEAD and refs
// ---------------------------------------------------------------------------

async function resolveHead(
  headRaw: string | null,
  gitDir: string,
  commonGitDir: string,
): Promise<{ branch: string | null; head: string | null }> {
  if (!headRaw) return { branch: null, head: null };
  const head = headRaw.trim();

  const symbolic = /^ref:\s*(.+)$/.exec(head);
  if (!symbolic) {
    // Detached HEAD: the file holds the sha directly.
    return { branch: null, head: /^[0-9a-f]{7,64}$/i.test(head) ? head : null };
  }

  const ref = symbolic[1]!.trim();
  const branch = ref.replace(/^refs\/heads\//, '');

  // A ref lives either as a loose file or inside packed-refs.
  for (const base of [gitDir, commonGitDir]) {
    const loose = await readFileOrNull(join(base, ref));
    if (loose) {
      const sha = loose.trim();
      if (/^[0-9a-f]{7,64}$/i.test(sha)) return { branch, head: sha };
    }
  }

  const packed = await readFileOrNull(join(commonGitDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/, 2);
      if (name === ref && sha) return { branch, head: sha };
    }
  }

  // A newly initialised repository has a branch but no commit yet.
  return { branch, head: null };
}

/**
 * Approximate "when did a ref last move", from filesystem mtimes.
 *
 * This is a heuristic and is treated as one: it informs activity ordering, but
 * `pb` never presents it as an exact commit time.
 */
async function lastRefActivity(gitDir: string, commonGitDir: string): Promise<Timestamp | null> {
  const candidates = [
    join(gitDir, 'HEAD'),
    join(gitDir, 'index'),
    join(commonGitDir, 'refs', 'heads'),
    join(commonGitDir, 'packed-refs'),
  ];

  let newest: number | null = null;
  await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await stat(candidate);
        const time = info.mtimeMs;
        if (newest === null || time > newest) newest = time;
      } catch {
        // Missing candidates are normal (no packed-refs, no index yet).
      }
    }),
  );

  return newest === null ? null : toTimestamp(new Date(newest));
}

// ---------------------------------------------------------------------------
// Working tree status
// ---------------------------------------------------------------------------

interface StatusCounts {
  dirty: boolean;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
  changedFiles: string[];
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL separation is what makes this correct for paths containing spaces,
 * quotes or newlines, which the default line-based output mangles.
 */
export function parsePorcelainStatus(stdout: string, limit: number): StatusCounts {
  const counts: StatusCounts = {
    dirty: false,
    stagedCount: 0,
    modifiedCount: 0,
    untrackedCount: 0,
    changedFiles: [],
  };
  if (stdout === '') return counts;

  const entries = stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry === '') continue;
    // Format is `XY <path>`, so anything shorter is not a status record.
    if (entry.length < 4) continue;

    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);

    // A rename record is followed by its original path as a separate NUL field.
    if (x === 'R' || x === 'C') i++;

    if (x === '?' && y === '?') {
      counts.untrackedCount++;
    } else {
      if (x !== ' ' && x !== '?') counts.stagedCount++;
      if (y !== ' ' && y !== '?') counts.modifiedCount++;
    }

    counts.dirty = true;
    if (counts.changedFiles.length < limit) counts.changedFiles.push(path);
  }

  return counts;
}

function parseLogLine(stdout: string): CommitInfo | null {
  const line = stdout.trim();
  if (line === '') return null;
  const [sha, epoch, authorName, subject] = line.split('\u001f');
  if (!sha || !epoch) return null;
  const seconds = Number.parseInt(epoch, 10);
  if (!Number.isFinite(seconds)) return null;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: subject ?? '',
    authorName: authorName ?? '',
    authoredAt: toTimestamp(new Date(seconds * 1000)),
  };
}

async function readDefaultBranch(root: string, timeoutMs: number): Promise<string | null> {
  const symbolic = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    timeoutMs,
  });
  if (symbolic.ok) {
    const value = symbolic.stdout.trim().replace(/^origin\//, '');
    if (value !== '') return value;
  }

  // No origin/HEAD (common in repos cloned with --depth or created locally).
  const init = await git(['config', '--get', 'init.defaultBranch'], { cwd: root, timeoutMs });
  const configured = init.stdout.trim();
  return configured === '' ? null : configured;
}

async function readTracking(
  root: string,
  timeoutMs: number,
): Promise<{ ahead: number | null; behind: number | null }> {
  const result = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], {
    cwd: root,
    timeoutMs,
  });
  if (!result.ok) return { ahead: null, behind: null };
  const [behind, ahead] = result.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  return {
    ahead: Number.isFinite(ahead) ? ahead! : null,
    behind: Number.isFinite(behind) ? behind! : null,
  };
}
