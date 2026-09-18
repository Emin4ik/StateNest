import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Prove isolation before a single test runs, and abort the run if it cannot.
 *
 * StateNest reads and writes a developer's home directory for a living.
 * A test suite for such a tool has exactly one unacceptable failure mode:
 * mutating the real one. Passing temp paths everywhere is not enough, because
 * a single default that falls back to `homedir()` reintroduces the risk and
 * the resulting damage looks like a clean test run.
 *
 * So this file does three things, in order, before any test executes:
 *
 * 1. Repoints HOME (and the Windows / XDG equivalents) at a throwaway
 *    directory, so `os.homedir()` itself returns somewhere disposable.
 * 2. Asserts that it worked, and calls `process.exit(1)` if it did not.
 *    Running the suite against a real home is worse than not running it.
 * 3. Arms the write guard in `src/util/write-guard.ts`, so any atomic write
 *    outside the sandbox throws at the write itself rather than succeeding.
 */

const REAL_HOME = realpathSync(homedir());

function fail(reason: string): never {
  process.stderr.write(
    `\n[test isolation] ABORTING: ${reason}\n` +
      `  real home: ${REAL_HOME}\n` +
      `  Refusing to run the suite where it could mutate a real home directory.\n\n`,
  );
  process.exit(1);
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pb-test-sandbox-')));
const fakeHome = join(sandbox, 'home');
const projects = join(sandbox, 'projects');

try {
  for (const dir of [fakeHome, projects]) mkdirSync(dir, { recursive: true });
} catch (error) {
  fail(`could not create the sandbox under ${sandbox}: ${String(error)}`);
}

// -- 1. Repoint the home --------------------------------------------------
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.XDG_CONFIG_HOME = join(fakeHome, '.config');
process.env.XDG_DATA_HOME = join(fakeHome, '.local', 'share');
process.env.XDG_STATE_HOME = join(fakeHome, '.local', 'state');
process.env.XDG_CACHE_HOME = join(fakeHome, '.cache');

// Any test that forgets to pass an explicit home lands here, not in a real one.
process.env.STATENEST_HOME = join(fakeHome, '.statenest');

// Git must not read or write the developer's real identity or config.
process.env.GIT_CONFIG_GLOBAL = join(fakeHome, '.gitconfig-test');
process.env.GIT_CONFIG_SYSTEM = join(fakeHome, '.gitconfig-system-test');
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_AUTHOR_NAME = 'StateNest Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'StateNest Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';

// Claude Code must never see the developer's real plugin or settings state.
process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude');

// -- 2. Prove it ----------------------------------------------------------
const seenHome = realpathSync(homedir());
if (seenHome === REAL_HOME) {
  fail('os.homedir() still resolves to the real home after repointing HOME');
}
if (!seenHome.startsWith(realpathSync(tmpdir()))) {
  fail(`os.homedir() resolved to ${seenHome}, which is not inside the temp directory`);
}
if (process.env.STATENEST_HOME?.startsWith(REAL_HOME)) {
  fail('STATENEST_HOME points inside the real home');
}

// -- 3. Arm the write guard ----------------------------------------------
// Both the sandbox and the OS temp dir are permitted: fixtures legitimately
// create project trees under `mkdtemp`, outside the fake home.
process.env.STATENEST_WRITE_ROOT = [sandbox, realpathSync(tmpdir())].join(
  process.platform === 'win32' ? ';' : ':',
);

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

export { REAL_HOME, sandbox, fakeHome, projects };
