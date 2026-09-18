import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../src/util/fs-atomic.js';
import { assertWritable, isWriteGuardArmed } from '../../src/util/write-guard.js';
import { createPaths, resolveBrainHome } from '../../src/core/paths.js';

/**
 * Tests for the test isolation itself.
 *
 * Everything else in this suite trusts that it is running in a sandbox. That
 * assumption deserves its own verification: if isolation silently stopped
 * working, every other test would keep passing while quietly operating on the
 * developer's real data.
 */
describe('test isolation', () => {
  it('runs with a home inside the temp directory', () => {
    const home = realpathSync(homedir());
    expect(home.startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it('defaults STATENEST_HOME into the sandbox, not a real home', () => {
    const resolved = resolveBrainHome();
    expect(resolved.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(createPaths().home.startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it('points git and Claude Code config at the sandbox', () => {
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'CLAUDE_CONFIG_DIR']) {
      const value = process.env[key];
      expect(value, `${key} must be set`).toBeTruthy();
      expect(value!.startsWith(realpathSync(tmpdir())), `${key} = ${value}`).toBe(true);
    }
  });

  it('has the write guard armed', () => {
    expect(isWriteGuardArmed()).toBe(true);
  });

  describe('the write guard actually blocks', () => {
    it('rejects a path outside the allowed roots', () => {
      // A path that is absolute, plausible, and emphatically not in the sandbox.
      expect(() => assertWritable('/etc/statenest-should-never-write-here')).toThrow(
        /Refusing to write outside the allowed root/,
      );
    });

    it('rejects a write to a real home path', async () => {
      // This is the exact accident the guard exists to prevent: code that
      // resolved a path from the *real* home and tried to write there.
      const dangerous = join('/Users', 'someone', '.statenest', 'config.yaml');
      await expect(writeFileAtomic(dangerous, 'nope')).rejects.toThrow(
        /Refusing to write outside the allowed root/,
      );
    });

    it('allows writes inside the sandbox', async () => {
      const safe = join(tmpdir(), `pb-guard-allows-${process.pid}.txt`);
      await writeFileAtomic(safe, 'fine');
      await expect(readFile(safe, 'utf8')).resolves.toBe('fine');
    });

    it('does not fire a prefix false positive on a sibling directory', () => {
      // `/tmp/sandbox-evil` must not be permitted just because `/tmp/sandbox`
      // is: the check is on path segments, not string prefixes.
      const root = realpathSync(tmpdir());
      expect(() => assertWritable(`${root}-evil/file`)).toThrow();
    });
  });
});

/**
 * Two spellings of one directory.
 *
 * The first Windows CI run failed 290 tests because the guard compared the
 * runner's `TEMP` (`C:\Users\RUNNER~1\...`, an 8.3 short name) against
 * `os.tmpdir()` (`C:\Users\runneradmin\...`). Same directory, different
 * spelling, so a prefix comparison said "outside the allowed root" and every
 * legitimate write was refused.
 *
 * `realpathSync.native` expands short names and returns the filesystem's own
 * casing; the comparison folds case on Windows only, because Linux genuinely
 * distinguishes `/tmp/A` from `/tmp/a` and folding there would make the guard
 * weaker than the filesystem it protects.
 */
describe('the write guard compares paths the way the filesystem does', () => {
  it('permits a write through a differently-cased spelling of the root', async () => {
    const { assertWritable } = await import('../../src/util/write-guard.js');
    const root = process.env['STATENEST_WRITE_ROOT']!.split(process.platform === 'win32' ? ';' : ':')[0]!;

    const target = join(root, 'case-check', 'file.txt');
    expect(() => assertWritable(target)).not.toThrow();

    if (process.platform === 'win32' || process.platform === 'darwin') {
      // On a case-insensitive filesystem the same path in another case is the
      // same file, and must be treated as such.
      const swapped = target.replace(/[a-z]/, (c) => c.toUpperCase());
      expect(() => assertWritable(swapped)).not.toThrow();
    }
  });

  it('still refuses a path that only shares a name prefix with a root', async () => {
    const { assertWritable } = await import('../../src/util/write-guard.js');
    // The armed roots include the whole temp directory, so a sibling *of that*
    // is the only way to test the prefix boundary: `<tmp>-elsewhere` starts
    // with the same characters as `<tmp>` but is not inside it.
    const outside = `${realpathSync(tmpdir())}-elsewhere${sep}file.txt`;
    expect(() => assertWritable(outside)).toThrow();
  });
});
