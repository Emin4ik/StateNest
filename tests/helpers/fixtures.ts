import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * A disposable directory.
 *
 * Every test that touches the filesystem gets its own, so tests can run in
 * parallel and a failure never leaves state that makes the next run behave
 * differently.
 */
export interface TempDir {
  path: string;
  cleanup: () => Promise<void>;
}

export async function makeTempDir(prefix = 'statenest-test-'): Promise<TempDir> {
  // `realpath` because the system temp directory is itself a symlink on macOS
  // (`/var` -> `/private/var`). StateNest resolves paths before recording
  // them, so a test comparing against the unresolved form would fail for a
  // reason that has nothing to do with what it is testing.
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    path,
    cleanup: () => removeTree(path),
  };
}

/**
 * Delete a directory tree, retrying the errors that mean "not yet".
 *
 * `rm -rf` is not atomic, and a git process that has just exited can still
 * hold a pack file open for a moment: on macOS that surfaces as ENOTEMPTY
 * while unlinking `objects/pack`, and on Windows as EBUSY or EPERM, routinely,
 * because the filesystem refuses to unlink an open handle at all.
 *
 * Node's own `rm` retries only on Windows and only for some codes, so cleanup
 * failures show up as unrelated tests failing after the one that actually
 * finished fine. Retrying here keeps a teardown race from being reported as a
 * product bug.
 */
export async function removeTree(path: string): Promise<void> {
  const transient = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES', 'ENOTDIR']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !transient.has(code)) {
        // A leftover temp directory is not worth failing a green run over; the
        // OS reaps it. Anything else is a real error and should surface.
        if (transient.has(code)) return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * A repository skeleton written directly to disk, with no `git` process.
 *
 * Fast enough to use freely in unit tests, and it exercises exactly the
 * filesystem parsing that the scan path relies on.
 */
export async function makeFakeRepo(
  path: string,
  options: {
    remote?: string;
    remoteName?: string;
    branch?: string;
    head?: string;
    extraRemotes?: Record<string, string>;
    bare?: boolean;
  } = {},
): Promise<string> {
  const gitDir = join(path, '.git');
  await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true });

  const branch = options.branch ?? 'main';
  const head = options.head ?? 'a'.repeat(40);

  const configLines = ['[core]', '\trepositoryformatversion = 0'];
  if (options.bare) configLines.push('\tbare = true');

  const remotes: Record<string, string> = { ...options.extraRemotes };
  if (options.remote) remotes[options.remoteName ?? 'origin'] = options.remote;

  for (const [name, url] of Object.entries(remotes)) {
    configLines.push(`[remote "${name}"]`, `\turl = ${url}`, `\tfetch = +refs/heads/*:refs/remotes/${name}/*`);
  }

  await writeFile(join(gitDir, 'config'), `${configLines.join('\n')}\n`);
  await writeFile(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  await writeFile(join(gitDir, 'refs', 'heads', branch), `${head}\n`);
  return path;
}

/** True when a real `git` binary is available, so tests can skip rather than fail. */
export async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'StateNest Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'StateNest Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * A real git repository with a real commit.
 *
 * Used where the behaviour under test is git's, not ours - dirty-state
 * detection, worktrees, packed refs - because a hand-written fixture would
 * only prove that our parser agrees with our own fixture.
 */
export async function makeRealRepo(
  path: string,
  options: { remote?: string; branch?: string; files?: Record<string, string> } = {},
): Promise<string> {
  await mkdir(path, { recursive: true });
  const branch = options.branch ?? 'main';
  const run = (args: string[]) =>
    execFileAsync('git', args, {
      cwd: path,
      timeout: 15_000,
      env: { ...process.env, ...GIT_ENV },
    });

  await run(['init', '--quiet', `--initial-branch=${branch}`]);
  await run(['config', 'user.name', 'StateNest Test']);
  await run(['config', 'user.email', 'test@example.invalid']);
  await run(['config', 'commit.gpgsign', 'false']);

  const files = options.files ?? { 'README.md': '# fixture\n' };
  for (const [name, contents] of Object.entries(files)) {
    const filePath = join(path, name);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, contents);
  }

  await run(['add', '-A']);
  await run(['commit', '--quiet', '-m', 'initial commit']);

  if (options.remote) await run(['remote', 'add', 'origin', options.remote]);
  return path;
}

export async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = join(root, relative);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, contents);
  }
}

/**
 * An isolated StateNest home for one test.
 *
 * `STATENEST_HOME` is honoured by `createPaths`, so pointing it at a temp
 * directory is all it takes to guarantee a test can never touch the real one.
 */
export async function makeTempBrainHome(): Promise<TempDir> {
  return makeTempDir('statenest-home-');
}
