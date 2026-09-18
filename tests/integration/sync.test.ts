import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { makeFakeRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);

/**
 * Resolved once at module scope. Vitest evaluates the module body before the
 * suite runs, so this is where an `await` belongs - inside `describe` it is a
 * parse error.
 *
 * Tests that need a real git binary skip rather than fail, so the suite stays
 * meaningful in a container that does not have one.
 */
const GIT_AVAILABLE = await hasGit();

/**
 * Sync is exercised against a real local bare repository rather than a mock.
 *
 * The behaviours that matter here - what git does on a rebase, what it writes
 * on a conflict, whether a file actually arrives on a second machine - are
 * git's, and a mock would only prove our assumptions agree with themselves.
 */
describe('profile sync', () => {
  let home: TempDir;
  let code: TempDir;
  let bare: TempDir;
  beforeEach(async () => {
    home = await makeTempDir('pb-sync-home-');
    code = await makeTempDir('pb-sync-code-');
    bare = await makeTempDir('pb-sync-bare-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([home.cleanup(), code.cleanup(), bare.cleanup()]);
  });

  async function setupProfile(homeDir: string, profile = 'personal') {
    const workspace = await Workspace.initialize({ home: homeDir, profileName: profile });
    const registry = new Registry(workspace.store);
    const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
    return { workspace, registry, sync };
  }

  it('reports "not configured" before init, and never touches anything', async () => {
    const { sync } = await setupProfile(home.path);
    const result = await sync.sync();
    expect(result.outcome).toBe('not-configured');
    expect(await sync.isInitialised()).toBe(false);
  });

  it.runIf(GIT_AVAILABLE)('sets up without contacting the remote', async () => {
    const { sync } = await setupProfile(home.path);
    await sync.initialise(bare.path);

    const status = await sync.status();
    expect(status.initialised).toBe(true);
    expect(status.remote).toContain('pb-sync-bare-');
  });

  it.runIf(GIT_AVAILABLE)('pushes a project and a checkpoint to the remote', async () => {
    const { workspace, registry, sync } = await setupProfile(home.path);
    await sync.initialise(bare.path);

    await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
    const { project } = await registry.register(join(code.path, 'widget'), {
      machineId: workspace.machineId,
    });
    await createCheckpoint(
      workspace.store,
      project,
      { summary: 'Finished the widget preprocessing pass.' },
      { machineId: workspace.machineId, source: 'cli' },
    );

    const result = await sync.sync({ message: 'test sync' });
    expect(result.outcome).toBe('synced');
    expect(result.changed).toBeGreaterThan(0);

    const listing = await execFileAsync('git', ['-C', bare.path, 'ls-tree', '-r', '--name-only', 'main']);
    expect(listing.stdout).toContain('project.yaml');
    expect(listing.stdout).toContain('.gitattributes');
  });

  it.runIf(GIT_AVAILABLE)('carries a project to a second machine', async () => {
    const { workspace, registry, sync } = await setupProfile(home.path);
    await sync.initialise(bare.path);

    await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
    const { project: original } = await registry.register(join(code.path, 'widget'), {
      machineId: workspace.machineId,
    });
    await sync.sync();

    // A completely separate machine clones the same data repository.
    const secondHome = await makeTempDir('pb-sync-home2-');
    try {
      const second = await setupProfile(secondHome.path);
      await second.sync.initialise(bare.path);
      const pulled = await second.sync.sync();

      expect(['synced', 'up-to-date']).toContain(pulled.outcome);

      const projects = await new Registry(second.workspace.store).all();
      expect(projects).toHaveLength(1);
      expect(projects[0]?.id).toBe(original.id);
      expect(projects[0]?.name).toBe('widget');

      // The two machines are genuinely different identities.
      expect(second.workspace.machineId).not.toBe(workspace.machineId);
    } finally {
      await secondHome.cleanup();
    }
  });

  it.runIf(GIT_AVAILABLE)('merges checkpoints written independently on two machines', async () => {
    const first = await setupProfile(home.path);
    await first.sync.initialise(bare.path);

    await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
    const { project } = await first.registry.register(join(code.path, 'widget'), {
      machineId: first.workspace.machineId,
    });
    await first.sync.sync();

    const secondHome = await makeTempDir('pb-sync-home3-');
    try {
      const second = await setupProfile(secondHome.path);
      await second.sync.initialise(bare.path);
      await second.sync.sync();

      // Each machine records a different checkpoint, offline, at the same time.
      await createCheckpoint(
        first.workspace.store,
        project,
        { summary: 'work done on the laptop' },
        {
          machineId: first.workspace.machineId,
          source: 'cli',
          timestamp: '2026-09-17T10:00:00Z',
        },
      );
      const secondProject = (await new Registry(second.workspace.store).all())[0]!;
      await createCheckpoint(
        second.workspace.store,
        secondProject,
        { summary: 'work done on the workstation' },
        {
          machineId: second.workspace.machineId,
          source: 'cli',
          timestamp: '2026-09-17T11:00:00Z',
        },
      );

      await first.sync.sync();
      const secondResult = await second.sync.sync();

      // Immutable one-file-per-checkpoint means this is a clean merge, not a
      // conflict - which is the entire reason for that layout.
      expect(secondResult.outcome).not.toBe('conflict');

      await first.sync.sync();
      const checkpoints = await first.workspace.store.listCheckpoints(project.id);
      expect(checkpoints.map((c) => c.summary).sort()).toEqual([
        'work done on the laptop',
        'work done on the workstation',
      ]);
    } finally {
      await secondHome.cleanup();
    }
  });

  describe('a credential stops the push', () => {
    it.runIf(GIT_AVAILABLE)('blocks before anything is committed', async () => {
      const { workspace, registry, sync } = await setupProfile(home.path);
      await sync.initialise(bare.path);

      await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
      const { project } = await registry.register(join(code.path, 'widget'), {
        machineId: workspace.machineId,
      });

      const token = `ghp_${'Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye'.repeat(2).slice(0, 36)}`;
      await workspace.store.writeState(project.id, `# Notes\n\ndeploy token ${token}\n`);

      const result = await sync.sync();

      expect(result.outcome).toBe('blocked-by-secrets');
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.blockers.join('\n')).not.toContain(token);

      // Nothing reached git at all - not the remote, and not even local history.
      const listing = await execFileAsync('git', ['-C', bare.path, 'ls-tree', '-r', '--name-only', 'main']).catch(
        () => ({ stdout: '' }),
      );
      expect(listing.stdout).toBe('');

      const log = await execFileAsync('git', ['-C', workspace.profilePaths.root, 'log', '--oneline']).catch(
        () => ({ stdout: '' }),
      );
      expect(log.stdout.trim()).toBe('');
    });

    it.runIf(GIT_AVAILABLE)('syncs normally once the credential is removed', async () => {
      const { workspace, registry, sync } = await setupProfile(home.path);
      await sync.initialise(bare.path);

      await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
      const { project } = await registry.register(join(code.path, 'widget'), {
        machineId: workspace.machineId,
      });

      const token = `ghp_${'Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye'.repeat(2).slice(0, 36)}`;
      await workspace.store.writeState(project.id, `token ${token}\n`);
      expect((await sync.sync()).outcome).toBe('blocked-by-secrets');

      await workspace.store.writeState(project.id, '# Current focus\n\nPreprocessing pass.\n');
      expect((await sync.sync()).outcome).toBe('synced');
    });
  });

  describe('it refuses to operate outside the StateNest home', () => {
    it('throws when constructed against a directory outside the home', async () => {
      const { workspace } = await setupProfile(home.path);
      const foreign = { ...workspace.profilePaths, root: code.path };

      expect(() => new ProfileSync(foreign, workspace.paths.home)).toThrow(
        /outside the StateNest home/i,
      );
    });

    it.runIf(GIT_AVAILABLE)('never creates a commit in a scanned source repository', async () => {
      const { workspace, registry, sync } = await setupProfile(home.path);
      await sync.initialise(bare.path);

      const projectPath = join(code.path, 'widget');
      await makeFakeRepo(projectPath, { remote: 'git@github.com:acme/widget.git' });
      await registry.register(projectPath, { machineId: workspace.machineId });
      await sync.sync();

      // The fixture repo has no commits and must still have none.
      const log = await execFileAsync('git', ['-C', projectPath, 'log', '--oneline']).catch(
        (error: { stderr?: string }) => ({ stdout: '', stderr: error.stderr ?? '' }),
      );
      expect(log.stdout.trim()).toBe('');

      // And its HEAD is exactly what the fixture wrote.
      const head = await readFile(join(projectPath, '.git', 'HEAD'), 'utf8');
      expect(head.trim()).toBe('ref: refs/heads/main');
    });
  });

  it.runIf(GIT_AVAILABLE)('writes a .gitattributes that keeps decisions mergeable', async () => {
    const { workspace, sync } = await setupProfile(home.path);
    await sync.initialise(bare.path);

    const attributes = await readFile(join(workspace.profilePaths.root, '.gitattributes'), 'utf8');
    expect(attributes).toContain('decisions.md merge=union');
    expect(attributes).toContain('eol=lf');
  });
});
