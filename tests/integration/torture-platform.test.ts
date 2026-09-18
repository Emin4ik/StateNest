import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { pathKey, pathsEqual, isPathInside, contractHome, normalizeSeparators, isCaseInsensitiveFs } from '../../src/util/paths.js';
import { isUnsafeMemberPath } from '../../src/storage/archive.js';
import { remoteIdentity, normalizeRemoteUrl } from '../../src/git/remote-url.js';
import { safeDirName } from '../../src/util/ids.js';
import { createPaths, sanitizeIdForPath, sanitizeProfileName } from '../../src/core/paths.js';
import { detectOs, isWsl, suggestMachineName } from '../../src/machines/identity.js';
import { git } from '../../src/git/exec.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Cross-platform behaviour.
 *
 * Project Brain targets macOS, Linux, Windows and WSL. CI runs the whole suite
 * on the first three, but a green matrix only proves the tests that exist pass
 * there. These exercise the platform-dependent logic *directly*, by passing the
 * platform in, so Windows path semantics are verified on every machine rather
 * than only when a Windows runner happens to be green.
 */
describe('Windows path semantics', () => {
  it('treats drive-letter paths case-insensitively', () => {
    expect(pathsEqual('C:\\Users\\Test User\\Projects', 'c:/users/test user/projects', 'win32')).toBe(
      true,
    );
  });

  it('normalizes backslashes for comparison', () => {
    expect(normalizeSeparators('C:\\Users\\Test User\\code')).toBe('C:/Users/Test User/code');
    expect(pathKey('C:\\A\\B', 'win32')).toBe(pathKey('C:/a/b', 'win32'));
  });

  it('handles a path containing spaces', () => {
    const path = 'C:\\Users\\Test User\\My Projects\\project one';
    expect(pathKey(path, 'win32')).toContain('my projects');
    expect(isPathInside(`${path}\\sub`, path, 'win32')).toBe(true);
  });

  it('does not treat a sibling directory as nested', () => {
    expect(isPathInside('C:\\Users\\Test2', 'C:\\Users\\Test', 'win32')).toBe(false);
  });

  it('reports case sensitivity per platform', () => {
    expect(isCaseInsensitiveFs('win32')).toBe(true);
    expect(isCaseInsensitiveFs('darwin')).toBe(true);
    expect(isCaseInsensitiveFs('linux')).toBe(false);
  });

  it('rejects Windows absolute and UNC paths inside an archive', () => {
    for (const member of [
      'C:\\Windows\\system32\\evil.dll',
      'C:/Windows/system32/evil.dll',
      '\\\\server\\share\\evil',
      '..\\..\\escape',
      'dir\\..\\..\\escape',
    ]) {
      expect(isUnsafeMemberPath(member), member).toBe(true);
    }
  });

  it('never produces a directory name Windows would refuse', () => {
    for (const name of ['con', 'PRN', 'aux', 'NUL', 'COM1', 'lpt9', 'con.txt']) {
      const safe = safeDirName(name);
      expect(['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']).not.toContain(safe);
    }
  });

  it('never produces a path segment with a character Windows forbids', () => {
    // < > : " | ? * and control characters are all illegal in Windows names.
    for (const name of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\tb']) {
      const safe = safeDirName(name);
      expect(safe).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('sanitizes an id into something writable on every platform', () => {
    for (const id of ['prj_normal', '../escape', 'a/b', 'a\\b', 'con', '..', 'a:b']) {
      const safe = sanitizeIdForPath(id);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe).not.toContain(':');
      expect(safe.startsWith('.')).toBe(false);
    }
  });

  it('keeps a profile name inside the profiles directory', () => {
    for (const name of ['../escape', 'a/b', '..', 'C:\\evil']) {
      expect(sanitizeProfileName(name)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('macOS specifics', () => {
  it('treats a case-different path as the same directory', () => {
    expect(pathsEqual('/Users/Emin/Code', '/users/emin/code', 'darwin')).toBe(true);
  });

  it('keeps the /tmp to /private/tmp regression covered', async () => {
    // The original bug: one directory registered as two locations because the
    // CLI and a hook reached it by different names.
    const home = await makeTempDir('pb-plat-home-');
    const code = await makeTempDir('pb-plat-code-');
    try {
      const workspace = await Workspace.initialize({ home: home.path });
      const registry = new Registry(workspace.store);
      const { symlink } = await import('node:fs/promises');

      const real = join(code.path, 'real', 'app');
      await makeFakeRepo(real, { remote: 'git@github.com:acme/app.git' });
      await symlink(join(code.path, 'real'), join(code.path, 'alias'), 'dir');

      await registry.register(real, { machineId: workspace.machineId });
      const second = await registry.register(join(code.path, 'alias', 'app'), {
        machineId: workspace.machineId,
      });

      expect(second.project.local_locations).toHaveLength(1);
    } finally {
      await home.cleanup();
      await code.cleanup();
    }
  });
});

describe('Linux specifics', () => {
  it('treats case-different paths as different directories', () => {
    expect(pathsEqual('/home/alice/Code', '/home/alice/code', 'linux')).toBe(false);
  });

  it('needs none of GitHub CLI, systemd or a desktop environment', async () => {
    // The core path shells out to exactly one external program: git. Nothing
    // else is spawned, so nothing else can be a hidden requirement.
    const { readFile } = await import('node:fs/promises');
    const { readdir } = await import('node:fs/promises');

    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts')) sources.push(await readFile(path, 'utf8'));
      }
    };
    await walk(join(import.meta.dirname, '..', '..', 'src'));

    const joined = sources.join('\n');
    for (const forbidden of ['systemctl', 'gh ', 'xdg-settings', 'dbus', 'osascript']) {
      // `gh` and friends must not be required anywhere in the core path.
      const uses = joined.includes(`execFileAsync('${forbidden.trim()}'`) ||
        joined.includes(`spawn('${forbidden.trim()}'`);
      expect(uses, `${forbidden} must not be spawned`).toBe(false);
    }
  });
});

describe('WSL semantics', () => {
  it('detects WSL separately from plain Linux', () => {
    // Only meaningful on Linux; elsewhere it must simply be false.
    if (process.platform !== 'linux') {
      expect(isWsl()).toBe(false);
    }
    expect(['macos', 'linux', 'windows', 'wsl', 'unknown']).toContain(detectOs());
  });

  it('gives WSL and Windows separate machine identities, by construction', () => {
    // Machine identity lives in `machine.json` under the home directory, and
    // WSL has a different home from the Windows side. Two homes, two ids: the
    // same repository seen from both therefore appears as one project with two
    // locations, which is the honest description of the situation.
    const wslHome = createPaths(undefined, {
      PROJECT_BRAIN_HOME: '/home/alice/.project-brain',
    });
    const windowsHome = createPaths(undefined, {
      PROJECT_BRAIN_HOME: 'C:/Users/alice/.project-brain',
    });
    expect(wslHome.machineIdentityFile).not.toBe(windowsHome.machineIdentityFile);
  });

  it('identifies a /mnt/c path as a distinct location, not a distinct project', () => {
    // A repository at /mnt/c/code/app under WSL and C:\code\app under Windows
    // is one project - identity comes from the git remote, not the path.
    expect(remoteIdentity('git@github.com:acme/app.git')).toBe(
      remoteIdentity('https://github.com/acme/app'),
    );
    // But the two paths are different locations.
    expect(pathsEqual('/mnt/c/code/app', 'C:/code/app', 'linux')).toBe(false);
  });
});

describe('optional dependencies', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-opt-home-');
    code = await makeTempDir('pb-opt-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('reports a missing git clearly rather than crashing', async () => {
    const previous = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent';
      const result = await git(['--version'], { cwd: code.path });
      expect(result.ok).toBe(false);
      expect(result.failure).toBe('not-installed');
    } finally {
      process.env.PATH = previous;
    }
  });

  it('still registers a project when git is unavailable', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });

    const previous = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent';
      // Registration reads `.git` from the filesystem, so it never needs the
      // binary at all - the point of the two-tier design.
      const result = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });
      expect(result.project.repository?.identity).toBe('github.com/acme/app');
    } finally {
      process.env.PATH = previous;
    }
  });

  it('works with no ssh config present', async () => {
    const { readSshConfig } = await import('../../src/remotes/ssh-config.js');
    await expect(readSshConfig(join(home.path, 'no-such-ssh-config'))).resolves.toEqual([]);
  });

  it('works with no git remote configured', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'local-only'), {});

    const result = await registry.register(join(code.path, 'local-only'), {
      machineId: workspace.machineId,
    });
    expect(result.project.repository).toBeNull();
    expect(result.project.name).toBe('local-only');
  });

  it('reports a missing tar as a missing tool, not a corrupt archive', async () => {
    const { inspectArchive } = await import('../../src/storage/archive.js');
    const previous = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent';
      await expect(inspectArchive(join(home.path, 'x.tar.gz'))).rejects.toThrow(
        /need the `tar` command/,
      );
    } finally {
      process.env.PATH = previous;
    }
  });

  it('needs no network for any read command', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await registry.register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    const { buildRecent, buildResumeBrief } = await import('../../src/core/context.js');
    const { search } = await import('../../src/search/search.js');

    // None of these touch the network; the git calls they make are all local.
    await expect(registry.all()).resolves.toHaveLength(1);
    await expect(
      buildResumeBrief(workspace.store, project, { machineId: workspace.machineId }),
    ).resolves.toBeTruthy();
    await expect(buildRecent(workspace.store, [project])).resolves.toBeTruthy();
    await expect(search(workspace.store, [project], 'app')).resolves.toBeTruthy();
  });
});

describe('machine naming', () => {
  it('produces a usable name from an awkward hostname', () => {
    for (const hostname of [
      'Emins-MacBook-Pro.local',
      'DESKTOP-4F8J2K1',
      'ip-10-0-1-23.eu-west-1.compute.internal',
      'my machine',
      '.....',
      '',
    ]) {
      const name = suggestMachineName(hostname);
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('display paths across platforms', () => {
  it('collapses a Windows home directory', () => {
    const shown = contractHome('C:\\Users\\Test\\code\\app', 'C:\\Users\\Test');
    expect(shown.startsWith('~')).toBe(true);
  });

  it('leaves a path outside the home alone', () => {
    expect(contractHome('/opt/app', '/home/alice')).toBe('/opt/app');
    expect(contractHome('D:\\data\\app', 'C:\\Users\\Test')).toBe('D:\\data\\app');
  });
});

describe('remote URLs from every platform', () => {
  it('handles a Windows local path remote without treating it as a host', () => {
    const result = normalizeRemoteUrl('C:\\repos\\widget');
    expect(result?.scheme).toBe('local');
    expect(result?.host).toBe('');
    expect(result?.stableAcrossMachines).toBe(false);
  });

  it('handles a UNC path remote', () => {
    const result = normalizeRemoteUrl('\\\\fileserver\\share\\widget.git');
    expect(result?.stableAcrossMachines).toBe(false);
  });

  it('handles a WSL path remote', () => {
    const result = normalizeRemoteUrl('/mnt/c/repos/widget.git');
    expect(result?.scheme).toBe('local');
    expect(result?.stableAcrossMachines).toBe(false);
  });
});
