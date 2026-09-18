import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errnoCode } from '../util/errors.js';

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when git could not be run at all, as opposed to exiting non-zero. */
  failure: 'not-installed' | 'timeout' | 'error' | null;
}

/**
 * Environment for every git invocation.
 *
 * StateNest only ever *reads* repository state, but a stray credential
 * prompt in a SessionStart hook would hang Claude Code's startup with no
 * visible cause. Disabling every interactive prompt makes that impossible.
 */
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
  GIT_OPTIONAL_LOCKS: '0',
  // Stable, parseable output regardless of the user's locale.
  LC_ALL: 'C',
  // A pager would never exit.
  GIT_PAGER: 'cat',
  PAGER: 'cat',
} as const;

/**
 * Run a git command.
 *
 * Arguments are always passed as an array to `execFile`, never interpolated
 * into a shell string. A repository path containing a space, a quote, or a
 * `;` is therefore just a path, not a command injection.
 */
export async function git(
  args: string[],
  options: { cwd: string; timeoutMs?: number; maxBufferBytes?: number } = { cwd: process.cwd() },
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: options.maxBufferBytes ?? 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    });
    return { ok: true, stdout, stderr, failure: null };
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') {
      return { ok: false, stdout: '', stderr: 'git is not installed', failure: 'not-installed' };
    }
    if (code === 'ETIMEDOUT') {
      return { ok: false, stdout: '', stderr: 'git timed out', failure: 'timeout' };
    }
    const shaped = error as { stdout?: string; stderr?: string };
    // A non-zero exit is normal and expected (for example, "not a git
    // repository"). It is a result, not a failure to run git.
    return {
      ok: false,
      stdout: shaped.stdout ?? '',
      stderr: shaped.stderr ?? String(error),
      failure: 'error',
    };
  }
}

let gitVersionCache: string | null | undefined;

/** The installed git version, or null when git is unavailable. Cached per process. */
export async function gitVersion(): Promise<string | null> {
  if (gitVersionCache !== undefined) return gitVersionCache;
  const result = await git(['--version'], { cwd: process.cwd(), timeoutMs: 3_000 });
  const match = /git version (\S+)/.exec(result.stdout);
  gitVersionCache = match?.[1] ?? null;
  return gitVersionCache;
}

/** Test seam: forget the cached git version. */
export function resetGitVersionCache(): void {
  gitVersionCache = undefined;
}
