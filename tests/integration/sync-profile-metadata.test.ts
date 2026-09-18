import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import {
  readMachineLocalState,
  recordSyncCompleted,
  updateMachineLocalState,
} from '../../src/core/machine-local.js';
import { createPaths } from '../../src/core/paths.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { readFile } from 'node:fs/promises';
import { makeFakeRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();
const GIT_TEST_TIMEOUT = 120_000;

/**
 * A successful sync must leave its own repository clean.
 *
 * From a real two-machine incident on v0.1.1: `statenest sync` reported
 * "Synced: 49 file(s) sent", and `statenest sync status` immediately reported
 * "local  uncommitted changes". The CLI wrote `last_sync_at` into profile.yaml
 * *after* ProfileSync had already committed and pushed the profile directory,
 * so every successful sync dirtied the repository it had just cleaned - and
 * every machine wrote a different timestamp into the same synced file, which
 * manufactured a conflict in profile.yaml even though no user data disagreed.
 *
 * profile.yaml is a control file: once it holds conflict markers, most
 * commands stop working. Manufacturing conflicts there is much worse than
 * manufacturing them anywhere else.
 */
describe('sync leaves the profile repository clean', () => {
  let bare: TempDir;
  let homeA: TempDir;
  let homeB: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    bare = await makeTempDir('sn-clean-bare-');
    homeA = await makeTempDir('sn-clean-a-');
    homeB = await makeTempDir('sn-clean-b-');
    code = await makeTempDir('sn-clean-code-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([bare.cleanup(), homeA.cleanup(), homeB.cleanup(), code.cleanup()]);
  });

  async function machine(home: string) {
    const workspace = await Workspace.initialize({ home, profileName: 'personal' });
    const registry = new Registry(workspace.store);
    const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
    await sync.initialise(bare.path);
    return { workspace, registry, sync };
  }

  type Machine = Awaited<ReturnType<typeof machine>>;

  /** Exactly what `statenest sync` does, including the bookkeeping write. */
  async function syncLikeTheCli(m: Machine, message?: string) {
    const result = await m.sync.sync(message === undefined ? {} : { message });
    if (result.outcome === 'synced' || result.outcome === 'up-to-date') {
      await recordSyncCompleted(m.workspace.paths, m.workspace.profile.name, m.workspace.profile);
    }
    return result;
  }

  async function porcelain(m: Machine): Promise<string> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: m.workspace.profilePaths.root,
    });
    return stdout.trim();
  }

  async function project(m: Machine, name: string, remote: string) {
    await makeFakeRepo(join(code.path, name), { remote });
    return (await m.registry.register(join(code.path, name), { machineId: m.workspace.machineId }))
      .project;
  }

  it.runIf(GIT_AVAILABLE)(
    'is clean immediately after the first push',
    async () => {
      const a = await machine(homeA.path);
      await project(a, 'api', 'git@github.com:acme/api.git');

      const result = await syncLikeTheCli(a, 'first');
      expect(result.outcome).toBe('synced');

      // The symptom the user saw: "Synced: N files sent" followed by
      // "local uncommitted changes".
      expect(await porcelain(a)).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'is clean after a second machine adopts the remote history',
    async () => {
      const a = await machine(homeA.path);
      await project(a, 'api', 'git@github.com:acme/api.git');
      await syncLikeTheCli(a);

      const b = await machine(homeB.path);
      const first = await syncLikeTheCli(b);
      expect(first.outcome).toBe('synced');
      expect(await porcelain(b)).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'is clean after an up-to-date sync and after one that both pulls and pushes',
    async () => {
      const a = await machine(homeA.path);
      await project(a, 'api', 'git@github.com:acme/api.git');
      await syncLikeTheCli(a);

      const b = await machine(homeB.path);
      await syncLikeTheCli(b);
      await project(b, 'web', 'git@github.com:acme/web.git');
      const pushed = await syncLikeTheCli(b);
      expect(pushed.outcome).toBe('synced');
      expect(await porcelain(b)).toBe('');

      // A pulls B's work and has nothing of its own to send.
      const pulled = await syncLikeTheCli(a);
      expect(pulled.outcome).toBe('synced');
      expect(await porcelain(a)).toBe('');

      // Nothing changed anywhere: up-to-date.
      const idle = await syncLikeTheCli(a);
      expect(idle.outcome).toBe('up-to-date');
      expect(await porcelain(a)).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'survives repeated alternating syncs without ever conflicting on profile.yaml',
    async () => {
      const a = await machine(homeA.path);
      const b = await machine(homeB.path);
      await project(a, 'api', 'git@github.com:acme/api.git');
      await syncLikeTheCli(a);
      await syncLikeTheCli(b);

      // Six alternating rounds. The real incident needed only two.
      for (let round = 0; round < 3; round += 1) {
        await project(a, `a-${round}`, `git@github.com:acme/a-${round}.git`);
        const fromA = await syncLikeTheCli(a);
        expect(fromA.outcome, `A round ${round}`).toBe('synced');
        expect(await porcelain(a), `A dirty after round ${round}`).toBe('');

        await project(b, `b-${round}`, `git@github.com:acme/b-${round}.git`);
        const fromB = await syncLikeTheCli(b);
        expect(fromB.outcome, `B round ${round}`).toBe('synced');
        expect(await porcelain(b), `B dirty after round ${round}`).toBe('');
      }

      // Both machines converge on the same set of projects.
      await syncLikeTheCli(a);
      await syncLikeTheCli(b);
      await syncLikeTheCli(a);
      a.registry.invalidate();
      b.registry.invalidate();

      const namesA = (await a.registry.all()).map((p) => p.name).sort();
      const namesB = (await b.registry.all()).map((p) => p.name).sort();
      expect(namesA).toEqual(namesB);
      expect(namesA).toHaveLength(7);
    },
    GIT_TEST_TIMEOUT,
  );
});

describe('machine-local state', () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('sn-local-');
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it('carries forward values an older version wrote into profile.yaml', async () => {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });

    // Exactly what a v0.1.1 profile looks like on disk.
    await workspace.saveProfile({
      ...workspace.profile,
      project_roots: ['~/Documents', '~/Projects'],
      sync: { ...workspace.profile.sync, last_sync_at: '2026-09-18T11:09:39Z' },
    });
    const upgraded = await Workspace.open({ home: home.path, profile: 'personal' });

    const state = await readMachineLocalState(
      upgraded.paths,
      upgraded.profile.name,
      upgraded.profile,
    );
    expect(state.project_roots).toEqual(['~/Documents', '~/Projects']);
    expect(state.last_sync_at).toBe('2026-09-18T11:09:39Z');
  });

  it('is idempotent: once written locally, the local file wins', async () => {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await workspace.saveProfile({
      ...workspace.profile,
      project_roots: ['~/old'],
      sync: { ...workspace.profile.sync, last_sync_at: '2020-01-01T00:00:00Z' },
    });

    await updateMachineLocalState(
      workspace.paths,
      'personal',
      workspace.profile,
      (state) => ({ ...state, project_roots: ['~/new'] }),
    );

    // The stale profile copy must not come back.
    for (let i = 0; i < 3; i += 1) {
      const state = await readMachineLocalState(workspace.paths, 'personal', workspace.profile);
      expect(state.project_roots).toEqual(['~/new']);
    }
  });

  it('lives outside the profile directory, where sync cannot reach it', () => {
    const paths = createPaths(home.path);
    expect(paths.localStateFor('personal').startsWith(paths.profilesDir)).toBe(false);
    expect(paths.localStateFor('personal').startsWith(paths.localDir)).toBe(true);
  });

  it('never writes machine-local fields back into the shared profile', async () => {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const before = await readFile(workspace.profilePaths.profileFile, 'utf8');

    await recordSyncCompleted(workspace.paths, 'personal', workspace.profile);
    await updateMachineLocalState(workspace.paths, 'personal', workspace.profile, (state) => ({
      ...state,
      project_roots: ['~/code'],
    }));

    expect(await readFile(workspace.profilePaths.profileFile, 'utf8')).toBe(before);
  });
});

describe('a real two-machine merge, structurally', () => {
  let bare: TempDir;
  let homeA: TempDir;
  let homeB: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    bare = await makeTempDir('sn-merge-bare-');
    homeA = await makeTempDir('sn-merge-a-');
    homeB = await makeTempDir('sn-merge-b-');
    code = await makeTempDir('sn-merge-code-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([bare.cleanup(), homeA.cleanup(), homeB.cleanup(), code.cleanup()]);
  });

  it.runIf(GIT_AVAILABLE)(
    'merges two populated machines into one registry, and stays clean and idempotent',
    async () => {
      // The shape of the real incident - 44 projects meeting 18 - at a size a
      // test can afford. What matters is the structure: unique projects on
      // each side, shared repositories, and two projects whose names collide
      // but whose remotes do not.
      const mkMachine = async (home: string) => {
        const workspace = await Workspace.initialize({ home, profileName: 'personal' });
        const registry = new Registry(workspace.store);
        const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
        await sync.initialise(bare.path);
        return { workspace, registry, sync };
      };
      const syncCli = async (m: Awaited<ReturnType<typeof mkMachine>>) => {
        const r = await m.sync.sync({});
        if (r.outcome === 'synced' || r.outcome === 'up-to-date') {
          await recordSyncCompleted(m.workspace.paths, m.workspace.profile.name, m.workspace.profile);
        }
        return r;
      };
      const porcelainOf = async (m: Awaited<ReturnType<typeof mkMachine>>) =>
        (
          await execFileAsync('git', ['status', '--porcelain'], {
            cwd: m.workspace.profilePaths.root,
          })
        ).stdout.trim();
      const register = async (
        m: Awaited<ReturnType<typeof mkMachine>>,
        dir: string,
        remote: string,
      ) => {
        await makeFakeRepo(join(code.path, dir), { remote });
        return (await m.registry.register(join(code.path, dir), {
          machineId: m.workspace.machineId,
        })).project;
      };

      const a = await mkMachine(homeA.path);
      const b = await mkMachine(homeB.path);

      // A: six of its own, plus two it shares with B.
      for (let i = 0; i < 6; i += 1) {
        await register(a, `a-only-${i}`, `git@github.com:acme/a-only-${i}.git`);
      }
      const shared = await register(a, 'shared', 'git@github.com:acme/shared.git');
      await register(a, 'work/threads', 'git@github.com:work-org/threads.git');

      // A checkpoint, a task and a decision, so memory has to survive too.
      await createCheckpoint(
        a.workspace.store,
        shared,
        { summary: 'A did something worth remembering.', next: ['finish it'] },
        { machineId: a.workspace.machineId, source: 'cli' },
      );

      await syncCli(a);
      expect(await porcelainOf(a)).toBe('');

      // B joins, then registers its own - including the same repository at a
      // different path, and a project whose display name collides with A's.
      await syncCli(b);
      expect(await porcelainOf(b)).toBe('');

      for (let i = 0; i < 3; i += 1) {
        await register(b, `b-only-${i}`, `git@github.com:acme/b-only-${i}.git`);
      }
      await register(b, 'elsewhere/shared', 'git@github.com:acme/shared.git');
      await register(b, 'personal/threads', 'git@github.com:personal-org/threads.git');

      await syncCli(b);
      expect(await porcelainOf(b)).toBe('');
      await syncCli(a);
      expect(await porcelainOf(a)).toBe('');

      a.registry.invalidate();
      b.registry.invalidate();
      const onA = await a.registry.all();
      const onB = await b.registry.all();

      // 6 a-only + 3 b-only + 1 shared + 2 threads = 12 distinct identities.
      expect(onA).toHaveLength(12);
      expect(onB).toHaveLength(12);
      expect(new Set(onA.map((p) => p.id))).toEqual(new Set(onB.map((p) => p.id)));

      // The same repository is one project with two locations, on two machines.
      const sharedOnA = onA.find((p) => p.id === shared.id)!;
      expect(sharedOnA.local_locations).toHaveLength(2);
      expect(new Set(sharedOnA.local_locations.map((l) => l.machine_id)).size).toBe(2);

      // Same display name, different remotes: still two projects.
      const threads = onA.filter((p) => p.name === 'threads');
      expect(threads).toHaveLength(2);
      expect(new Set(threads.map((p) => p.repository?.identity)).size).toBe(2);

      // Memory survived the merge.
      expect(await a.workspace.store.listCheckpointFiles(shared.id)).toHaveLength(1);
      expect(await b.workspace.store.listCheckpointFiles(shared.id)).toHaveLength(1);

      // Machines stay distinct.
      expect((await a.workspace.store.listMachines()).length).toBe(2);

      // Idempotent: a third and fourth sync change nothing and conflict on
      // nothing.
      expect((await syncCli(a)).outcome).toBe('up-to-date');
      expect(await porcelainOf(a)).toBe('');
      expect((await syncCli(b)).outcome).toBe('up-to-date');
      expect(await porcelainOf(b)).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );
});
