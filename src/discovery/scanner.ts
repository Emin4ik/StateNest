import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  HOME_RELATIVE_SKIPS,
  PROJECT_MARKERS,
  SYSTEM_PATH_PREFIXES,
  isAlwaysExcludedDir,
} from './exclusions.js';
import { errnoCode } from '../util/errors.js';
import { normalizeSeparators, pathKey } from '../util/paths.js';

export interface ScanOptions {
  /** How deep below each root to descend. */
  maxDepth?: number;
  /** Extra directory names to skip, from `discovery.exclude` in config. */
  exclude?: readonly string[];
  /**
   * Also report directories that look like projects but are not git
   * repositories. Off by default: a stray `package.json` in an examples folder
   * is far more common than a real project that is not under version control.
   */
  includeNonGit?: boolean;
  /**
   * Keep descending after finding a repository, to pick up nested ones.
   * Off by default - one git repository is one project. See docs/adr/0004.
   */
  nested?: boolean;
  /** Concurrent directory reads. Enough to saturate an SSD, few enough to be polite. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (visited: number, found: number) => void;
}

export interface Candidate {
  /** Absolute path to the project root. */
  path: string;
  isGitRepo: boolean;
  /** Marker file that identified a non-git project, if any. */
  marker: string | null;
  /** Ecosystem guessed from the marker; refined later by detectProjectType. */
  markerType: string | null;
  depth: number;
}

export interface ScanStats {
  directoriesVisited: number;
  directoriesPruned: number;
  permissionErrors: number;
  durationMs: number;
  /** True when the scan stopped early because it was aborted. */
  aborted: boolean;
}

export interface ScanResult {
  candidates: Candidate[];
  stats: ScanStats;
  /** Roots that could not be scanned at all, with the reason. */
  unreadableRoots: { path: string; reason: string }[];
}

interface Visit {
  candidate: Candidate | null;
  children: { path: string; depth: number }[];
  permissionError: boolean;
  pruned: number;
}

/**
 * Find project roots under the given directories.
 *
 * The walk is breadth-first with bounded concurrency, prunes hard at known-bad
 * directory names, and stops descending as soon as it finds a repository.
 * Those three properties are what make scanning a whole home directory take
 * about a second rather than a minute: the expensive part of this problem is
 * not reading directories, it is reading the wrong ones.
 */
export async function scanForProjects(
  roots: readonly string[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const startedAt = Date.now();
  const maxDepth = options.maxDepth ?? 8;
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const extraExclusions = new Set(options.exclude ?? []);
  const home = homedir();

  const candidates: Candidate[] = [];
  const unreadableRoots: { path: string; reason: string }[] = [];
  const seenCandidates = new Set<string>();
  // Symlinked directories are followed once. Without this, a single link back
  // up the tree turns a scan into an infinite walk.
  const visitedRealPaths = new Set<string>();

  const stats: ScanStats = {
    directoriesVisited: 0,
    directoriesPruned: 0,
    permissionErrors: 0,
    durationMs: 0,
    aborted: false,
  };

  async function visit(path: string, depth: number): Promise<Visit> {
    const empty: Visit = { candidate: null, children: [], permissionError: false, pruned: 0 };

    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      const code = errnoCode(error);
      return { ...empty, permissionError: code === 'EACCES' || code === 'EPERM' };
    }

    let isGitRepo = false;
    let marker: string | null = null;
    let markerType: string | null = null;
    const subdirectories: string[] = [];
    const fileNames = new Set<string>();
    const dirNames = new Set<string>();

    for (const entry of entries) {
      if (entry.name === '.git') {
        // Either a directory (normal clone) or a file (worktree/submodule).
        isGitRepo = true;
        continue;
      }
      if (entry.isDirectory()) {
        dirNames.add(entry.name);
        subdirectories.push(entry.name);
      } else if (entry.isFile()) {
        fileNames.add(entry.name);
      } else if (entry.isSymbolicLink()) {
        // Resolve lazily: only if we would otherwise descend into it.
        subdirectories.push(entry.name);
      }
    }

    if (!isGitRepo && options.includeNonGit) {
      for (const candidateMarker of PROJECT_MARKERS) {
        if (fileNames.has(candidateMarker.file) || dirNames.has(candidateMarker.file)) {
          marker = candidateMarker.file;
          markerType = candidateMarker.type;
          break;
        }
      }
    }

    const found: Candidate | null =
      isGitRepo || marker !== null
        ? { path, isGitRepo, marker, markerType, depth }
        : null;

    // Stop at a repository root. A repository's own subdirectories are part of
    // that project, not separate ones, and descending into a large monorepo is
    // pure cost. `nested: true` opts back in for submodule-heavy setups.
    const shouldDescend = depth < maxDepth && (!isGitRepo || options.nested === true);
    if (!shouldDescend) {
      return { candidate: found, children: [], permissionError: false, pruned: 0 };
    }

    const children: { path: string; depth: number }[] = [];
    let pruned = 0;

    for (const name of subdirectories) {
      if (shouldPrune(name)) {
        pruned++;
        continue;
      }
      const childPath = join(path, name);
      if (isSystemPath(childPath) || isHomeNoiseDir(childPath, home)) {
        pruned++;
        continue;
      }
      children.push({ path: childPath, depth: depth + 1 });
    }

    return { candidate: found, children, permissionError: false, pruned };
  }

  function shouldPrune(name: string): boolean {
    if (isAlwaysExcludedDir(name) || extraExclusions.has(name)) return true;
    // Hidden directories are skipped unless a user explicitly scans one as a
    // root: `~/.config` and friends hold no projects but plenty of entries.
    return name.startsWith('.') && name !== '.';
  }

  /**
   * Guard against symlink cycles.
   *
   * `realpath` costs a syscall, so it is only paid when a directory could
   * actually be a link - which, on the paths that matter, is rare.
   */
  async function claimPath(path: string): Promise<boolean> {
    let real = path;
    try {
      real = await realpath(path);
    } catch {
      // Broken link or a permission problem; `visit` will report it properly.
    }
    const key = pathKey(real);
    if (visitedRealPaths.has(key)) return false;
    visitedRealPaths.add(key);
    return true;
  }

  let frontier: { path: string; depth: number }[] = [];

  for (const root of roots) {
    const absolute = resolve(root);
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) {
        unreadableRoots.push({ path: absolute, reason: 'not a directory' });
        continue;
      }
      if (await claimPath(absolute)) frontier.push({ path: absolute, depth: 0 });
    } catch (error) {
      unreadableRoots.push({ path: absolute, reason: describeFsError(error) });
    }
  }

  outer: while (frontier.length > 0) {
    const nextFrontier: { path: string; depth: number }[] = [];

    for (let offset = 0; offset < frontier.length; offset += concurrency) {
      if (options.signal?.aborted) {
        stats.aborted = true;
        break outer;
      }

      const batch = frontier.slice(offset, offset + concurrency);
      const visits = await Promise.all(
        batch.map(async (entry) => {
          stats.directoriesVisited++;
          return visit(entry.path, entry.depth);
        }),
      );

      for (const result of visits) {
        if (result.permissionError) stats.permissionErrors++;
        stats.directoriesPruned += result.pruned;

        if (result.candidate) {
          const key = pathKey(result.candidate.path);
          if (!seenCandidates.has(key)) {
            seenCandidates.add(key);
            candidates.push(result.candidate);
          }
        }

        for (const child of result.children) {
          if (await claimPath(child.path)) nextFrontier.push(child);
        }
      }

      options.onProgress?.(stats.directoriesVisited, candidates.length);
    }

    frontier = nextFrontier;
  }

  stats.durationMs = Date.now() - startedAt;
  return { candidates, stats, unreadableRoots };
}

function describeFsError(error: unknown): string {
  switch (errnoCode(error)) {
    case 'ENOENT':
      return 'does not exist';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'ENOTDIR':
      return 'not a directory';
    case 'ELOOP':
      return 'symbolic link loop';
    default:
      return 'could not be read';
  }
}

export function isSystemPath(path: string): boolean {
  const normalized = normalizeSeparators(path).toLowerCase();
  return SYSTEM_PATH_PREFIXES.some((prefix) => {
    const lower = prefix.toLowerCase();
    return normalized === lower || normalized.startsWith(`${lower}/`);
  });
}

/**
 * Directories directly under the home that are never worth walking.
 *
 * `~/Library` on macOS and the cloud-sync folders matter most: a recursive
 * walk of a placeholder-backed Dropbox or OneDrive folder can trigger
 * on-demand downloads of everything in it.
 */
export function isHomeNoiseDir(path: string, home: string): boolean {
  const normalizedHome = normalizeSeparators(home).replace(/\/+$/, '').toLowerCase();
  const normalized = normalizeSeparators(path).toLowerCase();
  return HOME_RELATIVE_SKIPS.some((name) => normalized === `${normalizedHome}/${name.toLowerCase()}`);
}
