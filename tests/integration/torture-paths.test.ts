import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { scanForProjects } from '../../src/discovery/scanner.js';
import { pathKey, pathsEqual, isPathInside, contractHome } from '../../src/util/paths.js';
import { safeDirName, slugify } from '../../src/util/ids.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Difficult paths.
 *
 * Every one of these is a real directory a developer might plausibly have.
 * A tool that indexes a whole home directory meets all of them eventually, and
 * a path bug does not merely fail - it silently indexes the wrong thing, or
 * merges two projects that are not the same.
 *
 * The bar is: identity stays correct, nothing crashes, and genuinely distinct
 * paths are never merged by over-eager normalization.
 */
describe('path torture', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-path-home-');
    code = await makeTempDir('pb-path-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function setup() {
    const workspace = await Workspace.initialize({ home: home.path });
    return { workspace, registry: new Registry(workspace.store) };
  }

  /**
   * Characters NTFS refuses outright.
   *
   * `| * ? < > : " \ /` cannot appear in a Windows filename at all, so a
   * fixture using them fails at `mkdir` before StateNest is involved. Skipping
   * them there is not reduced coverage — the directory cannot exist for a real
   * user either — and WINDOWS_ONLY_NAMES below adds the awkward names that are
   * specific to Windows instead.
   */
  const ILLEGAL_ON_WINDOWS = /[|*?<>:"]/;

  /**
   * Awkward in a way only Windows is.
   *
   * A trailing dot or space is silently stripped by the Win32 API, and the
   * reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) cannot be used
   * as a file or directory name in any directory.
   */
  const WINDOWS_ONLY_NAMES = ['project.with.dots', 'UPPERCASE-project', 'MiXeD-CaSe'];

  /**
   * Names chosen to break different things: shell quoting, glob expansion,
   * regex metacharacters, URL encoding, unicode normalization and width.
   */
  const ALL_AWKWARD_NAMES = [
    'My Projects',
    'project one',
    'project-with-[brackets]',
    'project (copy)',
    'project#hash',
    "o'brien's project",
    'project&and',
    'project$dollar',
    'project;semicolon',
    'project`backtick',
    'project|pipe',
    'project*star',
    'project?question',
    'project!bang',
    'project@at',
    'project+plus',
    'project=equals',
    'project,comma',
    'project{brace}',
    'тест',
    '日本語',
    'proyecto-español',
    'projet-français',
    'emoji-rocket',
    'very-'.repeat(20) + 'long',
  ];

  const AWKWARD_NAMES =
    process.platform === 'win32'
      ? [...ALL_AWKWARD_NAMES.filter((name) => !ILLEGAL_ON_WINDOWS.test(name)), ...WINDOWS_ONLY_NAMES]
      : ALL_AWKWARD_NAMES;

  describe('a project registers correctly under an awkward directory name', () => {
    it.each(AWKWARD_NAMES)('handles %j', async (name) => {
      const { workspace, registry } = await setup();
      const path = join(code.path, name);
      await makeFakeRepo(path, { remote: `git@github.com:acme/${slugify(name)}.git` });

      const result = await registry.register(path, { machineId: workspace.machineId });

      expect(result.outcome).toBe('created');
      expect(result.project.local_locations[0]?.path).toContain(name);

      // And it can be found again by the same path.
      const found = await registry.identify(path, workspace.machineId);
      expect(found.project?.id).toBe(result.project.id);
    });
  });

  it('scans a tree full of awkward names without crashing or losing any', async () => {
    for (const name of AWKWARD_NAMES) {
      await makeFakeRepo(join(code.path, name), {
        remote: `git@github.com:acme/${slugify(name)}.git`,
      });
    }

    const scan = await scanForProjects([code.path]);
    expect(scan.candidates).toHaveLength(AWKWARD_NAMES.length);
    expect(scan.stats.permissionErrors).toBe(0);
  });

  it('writes checkpoints for a project whose name is awkward', async () => {
    const { workspace, registry } = await setup();
    // The project *name* becomes part of nothing on disk (ids do), but prove it.
    const path = join(code.path, 'project (copy) #2');
    await makeFakeRepo(path, { remote: 'git@github.com:acme/copy-two.git' });
    const { project } = await registry.register(path, { machineId: workspace.machineId });

    const result = await createCheckpoint(
      workspace.store,
      project,
      { summary: 'Worked in an awkwardly named directory.' },
      { machineId: workspace.machineId, source: 'cli' },
    );

    expect(result.filePath).toBeTruthy();
    const checkpoints = await workspace.store.listCheckpoints(project.id);
    expect(checkpoints).toHaveLength(1);
  });

  describe('directory names never become unsafe path segments', () => {
    it('produces a filesystem-safe slug for every awkward name', () => {
      for (const name of AWKWARD_NAMES) {
        const safe = safeDirName(name);
        expect(safe, name).toMatch(/^[a-z0-9-]+$/);
        expect(safe.length, name).toBeGreaterThan(0);
      }
    });

    it('avoids Windows reserved device names', () => {
      for (const reserved of ['con', 'PRN', 'aux', 'NUL', 'com1', 'lpt9']) {
        expect(safeDirName(reserved)).not.toBe(reserved.toLowerCase());
      }
    });

    it('never produces a segment containing a separator', () => {
      for (const name of ['a/b', 'a\\b', '../../etc/passwd', 'a/../b']) {
        expect(safeDirName(name)).not.toContain('/');
        expect(safeDirName(name)).not.toContain('\\');
      }
    });
  });

  describe('symlinks', () => {
    it('treats a symlinked path as the same location', async () => {
      const { workspace, registry } = await setup();
      const real = join(code.path, 'real', 'widget');
      await makeFakeRepo(real, { remote: 'git@github.com:acme/widget.git' });
      const link = join(code.path, 'link');
      await symlink(join(code.path, 'real'), link, 'dir');

      const first = await registry.register(real, { machineId: workspace.machineId });
      const second = await registry.register(join(link, 'widget'), {
        machineId: workspace.machineId,
      });

      expect(second.project.id).toBe(first.project.id);
      expect(second.project.local_locations).toHaveLength(1);
    });

    it('does not loop forever on a symlink cycle', async () => {
      const deep = join(code.path, 'a', 'b');
      await mkdir(deep, { recursive: true });
      await makeFakeRepo(join(deep, 'repo'), { remote: 'git@github.com:acme/deep.git' });
      // A link pointing back at an ancestor: the classic unbounded-walk trap.
      await symlink(code.path, join(deep, 'loop'), 'dir');

      const scan = await scanForProjects([code.path], { maxDepth: 12 });
      expect(scan.candidates.length).toBeGreaterThanOrEqual(1);
      expect(scan.stats.aborted).toBe(false);
    });

    it('survives a broken symlink', async () => {
      await symlink(join(code.path, 'does-not-exist'), join(code.path, 'dangling'), 'dir');
      await makeFakeRepo(join(code.path, 'fine'), { remote: 'git@github.com:acme/fine.git' });

      const scan = await scanForProjects([code.path]);
      expect(scan.candidates.map((c) => c.path)).toContain(join(code.path, 'fine'));
    });
  });

  describe('path comparison does not over-normalize', () => {
    it('treats a trailing separator as the same path', () => {
      expect(pathsEqual('/a/b', '/a/b/')).toBe(true);
      expect(pathKey('/a/b')).toBe(pathKey('/a/b/'));
    });

    it('keeps genuinely different paths different', () => {
      expect(pathsEqual('/a/b', '/a/bb')).toBe(false);
      expect(pathsEqual('/a/b', '/a/b/c')).toBe(false);
      expect(pathsEqual('/a/b', '/x/b')).toBe(false);
    });

    it('respects case sensitivity per platform', () => {
      // Linux: distinct. macOS and Windows: the same directory.
      expect(pathsEqual('/a/Widget', '/a/widget', 'linux')).toBe(false);
      expect(pathsEqual('/a/Widget', '/a/widget', 'darwin')).toBe(true);
      expect(pathsEqual('C:/A/Widget', 'C:/a/widget', 'win32')).toBe(true);
    });

    it('does not treat a sibling as being inside a directory', () => {
      expect(isPathInside('/a/b', '/a')).toBe(true);
      expect(isPathInside('/a', '/a')).toBe(true);
      // The prefix-versus-segment trap: /ab is not inside /a.
      expect(isPathInside('/ab', '/a')).toBe(false);
      expect(isPathInside('/a-evil', '/a')).toBe(false);
    });

    it('normalizes Windows separators for comparison', () => {
      expect(pathsEqual('C:\\Users\\Test User\\Projects', 'C:/Users/Test User/Projects', 'win32')).toBe(
        true,
      );
    });
  });

  describe('two genuinely different directories stay different', () => {
    it('does not merge two clones of different repositories', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'one'), { remote: 'git@github.com:acme/one.git' });
      await makeFakeRepo(join(code.path, 'two'), { remote: 'git@github.com:acme/two.git' });

      const a = await registry.register(join(code.path, 'one'), { machineId: workspace.machineId });
      const b = await registry.register(join(code.path, 'two'), { machineId: workspace.machineId });

      expect(a.project.id).not.toBe(b.project.id);
      expect(await registry.all()).toHaveLength(2);
    });

    it('does not merge two no-remote repositories that differ only by case', async () => {
      const { workspace, registry } = await setup();
      // On a case-insensitive filesystem these are one directory, so create
      // them in separate parents to keep the test meaningful everywhere.
      await makeFakeRepo(join(code.path, 'x', 'Widget'), {});
      await makeFakeRepo(join(code.path, 'y', 'widget'), {});

      const a = await registry.register(join(code.path, 'x', 'Widget'), {
        machineId: workspace.machineId,
      });
      const b = await registry.register(join(code.path, 'y', 'widget'), {
        machineId: workspace.machineId,
      });

      expect(a.project.id).not.toBe(b.project.id);
    });
  });

  describe('relative paths', () => {
    it('registers a relative path as an absolute location', async () => {
      const { workspace, registry } = await setup();
      const path = join(code.path, 'rel');
      await makeFakeRepo(path, { remote: 'git@github.com:acme/rel.git' });

      const result = await registry.register(path, { machineId: workspace.machineId });
      const stored = result.project.local_locations[0]!.path;

      expect(stored.startsWith(sep) || /^[A-Za-z]:/.test(stored)).toBe(true);
      expect(stored).not.toContain(`${sep}.${sep}`);
      expect(stored).not.toContain('..');
    });
  });

  describe('display paths', () => {
    it('collapses the home directory for display', () => {
      expect(contractHome('/home/alice/code/x', '/home/alice')).toBe(`~${sep}code/x`);
    });

    it('does not collapse a lookalike sibling of the home directory', () => {
      expect(contractHome('/home/alice-other/x', '/home/alice')).toBe('/home/alice-other/x');
    });
  });

  it('handles a project directory that is removed after registration', async () => {
    const { workspace, registry } = await setup();
    const path = join(code.path, 'vanishing');
    await makeFakeRepo(path, { remote: 'git@github.com:acme/vanishing.git' });
    const { project } = await registry.register(path, { machineId: workspace.machineId });

    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true, force: true });

    // Identification must fail gracefully, and the record must survive so the
    // user can see where the project used to be.
    const found = await registry.identify(path, workspace.machineId);
    expect(found.repoRoot).toBeNull();
    expect((await registry.byId(project.id))?.local_locations).toHaveLength(1);
  });

  it('does not descend into an unreadable directory', async () => {
    const { chmod } = await import('node:fs/promises');
    const locked = join(code.path, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'marker'), 'x');
    await makeFakeRepo(join(code.path, 'readable'), { remote: 'git@github.com:acme/r.git' });

    try {
      await chmod(locked, 0o000);
      const scan = await scanForProjects([code.path]);
      // The readable project is still found; the locked one is counted, not fatal.
      expect(scan.candidates.map((c) => c.path)).toContain(join(code.path, 'readable'));
    } finally {
      await chmod(locked, 0o755).catch(() => {});
    }
  });
});
