import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import { runHook } from '../../src/integrations/claude/handlers.js';
import { performAutoSync, scheduleAutoSync } from '../../src/sync/auto-sync.js';
import { readMachineLocalState } from '../../src/core/machine-local.js';
import { labelRecord } from '../../src/sync/record-label.js';
import { makeRealRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();
const GIT_TEST_TIMEOUT = 120_000;

/**
 * "Install it once, work normally, forget it is there."
 *
 * Everything here drives the real hook entry points and the real sync against
 * real git repositories. The point is not that each piece works in isolation -
 * other suites cover that - but that a whole ordinary day needs no StateNest
 * command at all, and that the ways it could go wrong (offline, conflicted,
 * two sessions at once, a repository that should not be touched) each fail in
 * the direction that keeps the user's data safe and their session working.
 */
describe('zero-touch', () => {
  let homeA: TempDir;
  let homeB: TempDir;
  let code: TempDir;
  let bare: TempDir;

  beforeEach(async () => {
    homeA = await makeTempDir('sn-zt-a-');
    homeB = await makeTempDir('sn-zt-b-');
    code = await makeTempDir('sn-zt-code-');
    bare = await makeTempDir('sn-zt-bare-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([homeA.cleanup(), homeB.cleanup(), code.cleanup(), bare.cleanup()]);
  });

  /** A machine with StateNest set up and nothing registered. */
  async function machine(home: string, _name: string) {
    const workspace = await Workspace.initialize({ home, profileName: 'personal' });
    return { workspace, registry: new Registry(workspace.store) };
  }

  /** Point a machine at the shared test remote, the way `setup` does. */
  async function connect(home: string) {
    const workspace = await Workspace.open({ home });
    const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
    await sync.initialise(bare.path);
    await workspace.saveProfile({
      ...workspace.profile,
      sync: { ...workspace.profile.sync, enabled: true, remote: bare.path, branch: 'main' },
    });
    return sync;
  }

  /** Exactly what Claude Code sends a SessionStart hook. */
  const sessionStart = (home: string, cwd: string, sessionId: string) =>
    withHome(home, () =>
      runHook(
        'session-start',
        JSON.stringify({ hook_event_name: 'SessionStart', cwd, session_id: sessionId, source: 'startup' }),
      ),
    );

  const postCompact = (home: string, cwd: string, sessionId: string, summary: string) =>
    withHome(home, () =>
      runHook(
        'post-compact',
        JSON.stringify({
          hook_event_name: 'PostCompact',
          cwd,
          session_id: sessionId,
          trigger: 'auto',
          compact_summary: summary,
        }),
      ),
    );

  /**
   * The hooks read the home from the environment, exactly as a real one does.
   * Restored afterwards so a failure cannot leak into another test.
   */
  async function withHome<T>(home: string, work: () => Promise<T>): Promise<T> {
    const previous = process.env['STATENEST_HOME'];
    process.env['STATENEST_HOME'] = home;
    try {
      return await work();
    } finally {
      if (previous === undefined) delete process.env['STATENEST_HOME'];
      else process.env['STATENEST_HOME'] = previous;
    }
  }

  // -------------------------------------------------------------------------
  // Automatic project recognition
  // -------------------------------------------------------------------------

  describe('automatic project recognition', () => {
    it.runIf(GIT_AVAILABLE)(
      'registers a repository with a stable remote, with no add and no scan',
      async () => {
        const { workspace, registry } = await machine(homeA.path, 'mac-a');
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });

        expect(await registry.all()).toHaveLength(0);

        await sessionStart(homeA.path, repo, 'session-1');

        const fresh = new Registry((await Workspace.open({ home: homeA.path })).store);
        const projects = await fresh.all();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.name).toBe('harbour');
        expect(projects[0]?.repository?.identity).toBe('github.com/acme/harbour');
        expect(workspace.machineId).toBeTruthy();
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'does not register a git repository that has no remote',
      async () => {
        await machine(homeA.path, 'mac-a');
        const repo = join(code.path, 'scratch');
        await makeRealRepo(repo);

        await sessionStart(homeA.path, repo, 'session-1');

        // A project with no remote gets a random id, which cannot merge with
        // the same directory on another machine. Creating those silently would
        // fill a synced profile with per-machine duplicates.
        const registry = new Registry((await Workspace.open({ home: homeA.path })).store);
        expect(await registry.all()).toHaveLength(0);
      },
      GIT_TEST_TIMEOUT,
    );

    it('does not register an ordinary directory that is not a repository', async () => {
      await machine(homeA.path, 'mac-a');
      const plain = join(code.path, 'Downloads', 'test');
      await execFileAsync('mkdir', ['-p', plain]);

      await sessionStart(homeA.path, plain, 'session-1');

      const registry = new Registry((await Workspace.open({ home: homeA.path })).store);
      expect(await registry.all()).toHaveLength(0);
    });

    it.runIf(GIT_AVAILABLE)(
      'registers only the current repository, never its neighbours or its parent',
      async () => {
        await machine(homeA.path, 'mac-a');
        // A tree that a recursive scan would happily hoover up.
        await makeRealRepo(join(code.path, 'parent'), { remote: 'git@github.com:acme/parent.git' });
        await makeRealRepo(join(code.path, 'parent', 'here'), {
          remote: 'git@github.com:acme/here.git',
        });
        await makeRealRepo(join(code.path, 'sibling'), {
          remote: 'git@github.com:acme/sibling.git',
        });

        await sessionStart(homeA.path, join(code.path, 'parent', 'here'), 'session-1');

        const registry = new Registry((await Workspace.open({ home: homeA.path })).store);
        const names = (await registry.all()).map((project) => project.name).sort();
        expect(names).toEqual(['here']);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'never modifies the source repository it registers',
      async () => {
        await machine(homeA.path, 'mac-a');
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });

        const before = await snapshotTree(repo);
        const statusBefore = await gitIn(repo, ['status', '--porcelain']);
        const headBefore = await gitIn(repo, ['rev-parse', 'HEAD']);

        await sessionStart(homeA.path, repo, 'session-1');
        await postCompact(homeA.path, repo, 'session-1', 'Did a thing. Next: do another thing.');

        expect(await snapshotTree(repo)).toEqual(before);
        expect(await gitIn(repo, ['status', '--porcelain'])).toBe(statusBefore);
        expect(await gitIn(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'links a second location instead of creating a second project',
      async () => {
        await machine(homeA.path, 'mac-a');
        const first = join(code.path, 'harbour');
        const second = join(code.path, 'harbour-again');
        await makeRealRepo(first, { remote: 'git@github.com:acme/harbour.git' });
        await makeRealRepo(second, { remote: 'git@github.com:acme/harbour.git' });

        await sessionStart(homeA.path, first, 'session-1');
        await sessionStart(homeA.path, second, 'session-2');

        const registry = new Registry((await Workspace.open({ home: homeA.path })).store);
        const projects = await registry.all();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.local_locations).toHaveLength(2);
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // Automatic sync
  // -------------------------------------------------------------------------

  describe('automatic sync', () => {
    it.runIf(GIT_AVAILABLE)(
      'a burst of writes coalesces into one sync',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });

        // Five writes, no runner: each only records that a sync is wanted.
        for (let i = 0; i < 5; i++) await scheduleAutoSync(workspace, null);

        const local = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );
        expect(local.sync_requested_at).toBeTruthy();

        const outcome = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(outcome.ran).toBe(true);
        // One pass serviced all five.
        expect(outcome.passes).toBe(1);

        // And the request is cleared, so nothing syncs again for free.
        const after = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );
        expect(after.sync_requested_at).toBeNull();
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'does nothing when nothing asked for it',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);

        const outcome = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(outcome.ran).toBe(false);
        expect(outcome.reason).toBe('nothing-pending');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'only one sync runs at a time, and the second is skipped rather than queued',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });
        await scheduleAutoSync(workspace, null);

        // Started together, against one profile.
        const [first, second] = await Promise.all([
          performAutoSync({ home: homeA.path, debounceMs: 0 }),
          performAutoSync({ home: homeA.path, debounceMs: 0 }),
        ]);

        const reasons = [first.reason, second.reason].sort();
        expect(reasons).toContain('already-running');
        expect([first.ran, second.ran].filter(Boolean)).toHaveLength(1);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'leaves the profile clean after an automatic sync',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });
        await scheduleAutoSync(workspace, null);
        await performAutoSync({ home: homeA.path, debounceMs: 0 });

        // The v0.1.2 invariant, now under automatic sync too - and the reason
        // an automatic sync cannot feed itself a fresh reason to run.
        const dirty = await gitIn(workspace.profilePaths.root, ['status', '--porcelain']);
        expect(dirty).toBe('');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'respects auto_sync being off on this machine',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });
        const { writeMachineLocalState } = await import('../../src/core/machine-local.js');
        const local = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );
        await writeMachineLocalState(workspace.paths, { ...local, auto_sync: false });

        await scheduleAutoSync(workspace, null);
        const after = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );
        expect(after.sync_requested_at).toBeNull();

        const outcome = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(outcome.reason).toBe('disabled');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'records offline without losing anything, and syncs when the remote returns',
      async () => {
        await machine(homeA.path, 'mac-a');
        const sync = await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });
        await sessionStart(homeA.path, repo, 'session-1');
        await postCompact(homeA.path, repo, 'session-1', 'Wrote the tide model. Next: fixtures.');

        // The remote goes away.
        await execFileAsync('git', ['-C', workspace.profilePaths.root, 'remote', 'set-url', 'origin', join(bare.path, 'gone')]);

        await scheduleAutoSync(workspace, null);
        const offline = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(offline.result?.outcome === 'offline' || offline.result?.outcome === 'local-only').toBe(true);

        // Local memory is untouched.
        const registry = new Registry((await Workspace.open({ home: homeA.path })).store);
        const [project] = await registry.all();
        expect(project).toBeTruthy();
        expect(await workspace.store.listCheckpointFiles(project!.id)).not.toHaveLength(0);

        // The remote comes back.
        await execFileAsync('git', ['-C', workspace.profilePaths.root, 'remote', 'set-url', 'origin', bare.path]);
        await scheduleAutoSync(workspace, null);
        const recovered = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(['synced', 'up-to-date']).toContain(recovered.result?.outcome);

        const health = (
          await readMachineLocalState(workspace.paths, workspace.profile.name, workspace.profile)
        ).sync_health;
        expect(health.state).toBe('ok');

        const dirty = await gitIn(workspace.profilePaths.root, ['status', '--porcelain']);
        expect(dirty).toBe('');
        expect(await sync.isInitialised()).toBe(true);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'refuses to push a credential, and says so without repeating the value',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });

        const secret = `AKIA${'Q'.repeat(16)}`;
        await writeFile(join(workspace.profilePaths.root, 'notes.md'), `key: ${secret}\n`);

        await scheduleAutoSync(workspace, null);
        const outcome = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(outcome.result?.outcome).toBe('blocked-by-secrets');

        const local = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );
        expect(local.sync_health.state).toBe('blocked-by-secrets');
        // The health record is what a warning is rendered from, so it must not
        // become the place the credential ends up.
        expect(JSON.stringify(local)).not.toContain(secret);

        // And nothing was sent.
        const remoteLog = await gitIn(bare.path, ['log', '--oneline']).catch(() => '');
        expect(remoteLog).toBe('');
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // Conflicts stay usable
  // -------------------------------------------------------------------------

  describe('conflicts', () => {
    it.runIf(GIT_AVAILABLE)(
      'keeps the profile readable, preserves both sides, and repairs from a choice',
      async () => {
        await machine(homeA.path, 'mac-a');
        const syncA = await connect(homeA.path);
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });
        await sessionStart(homeA.path, repo, 'a-1');
        await syncA.sync({});

        await machine(homeB.path, 'linux-b');
        const syncB = await connect(homeB.path);
        await syncB.sync({});

        const wsA = await Workspace.open({ home: homeA.path });
        const wsB = await Workspace.open({ home: homeB.path });
        const [project] = await new Registry(wsA.store).all();

        // The same mutable record, changed differently on each machine.
        await wsA.store.writeState(project!.id, '# Focus\n\nimprove late-game AI\n');
        await syncA.sync({});
        await wsB.store.writeState(project!.id, '# Focus\n\nfix pathfinding\n');
        const conflict = await syncB.sync({});

        expect(conflict.outcome).toBe('conflict');
        expect(conflict.rolledBack).toBe(true);
        expect(conflict.conflictRemoteSha).toBeTruthy();

        // B's StateNest still works. This is the whole point: a conflict in a
        // control file used to make the profile unreadable.
        const reopened = await Workspace.open({ home: homeB.path });
        expect(reopened.profile.name).toBe(wsB.profile.name);
        const visible = await new Registry(reopened.store).all();
        expect(visible).toHaveLength(1);
        expect(await reopened.store.readState(project!.id)).toContain('fix pathfinding');

        // Both sides are still there, and describable in the user's terms.
        const sides = await syncB.conflictSides(conflict.conflictRemoteSha!, conflict.conflicts);
        expect(sides[0]?.mine).toContain('fix pathfinding');
        expect(sides[0]?.theirs).toContain('improve late-game AI');
        expect(labelRecord(conflict.conflicts[0]!, () => 'harbour').title).toBe(
          'harbour — current state',
        );

        // Choosing the other machine's version resolves it for everyone.
        const repaired = await syncB.repair(
          conflict.conflictRemoteSha!,
          new Map(conflict.conflicts.map((path) => [path, 'theirs' as const])),
        );
        expect(['synced', 'up-to-date']).toContain(repaired.outcome);

        const settled = await Workspace.open({ home: homeB.path });
        expect(await settled.store.readState(project!.id)).toContain('improve late-game AI');
        expect(await gitIn(wsB.profilePaths.root, ['status', '--porcelain'])).toBe('');

        // A sees the resolution without doing anything special.
        await syncA.sync({});
        const backOnA = await Workspace.open({ home: homeA.path });
        expect(await backOnA.store.readState(project!.id)).toContain('improve late-game AI');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'keeping this machine\'s version also resolves it',
      async () => {
        await machine(homeA.path, 'mac-a');
        const syncA = await connect(homeA.path);
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });
        await sessionStart(homeA.path, repo, 'a-1');
        await syncA.sync({});

        await machine(homeB.path, 'linux-b');
        const syncB = await connect(homeB.path);
        await syncB.sync({});

        const wsA = await Workspace.open({ home: homeA.path });
        const wsB = await Workspace.open({ home: homeB.path });
        const [project] = await new Registry(wsA.store).all();

        await wsA.store.writeState(project!.id, '# Focus\n\ntheirs\n');
        await syncA.sync({});
        await wsB.store.writeState(project!.id, '# Focus\n\nmine\n');
        const conflict = await syncB.sync({});
        expect(conflict.outcome).toBe('conflict');

        const repaired = await syncB.repair(
          conflict.conflictRemoteSha!,
          new Map(conflict.conflicts.map((path) => [path, 'mine' as const])),
        );
        expect(['synced', 'up-to-date']).toContain(repaired.outcome);

        const settled = await Workspace.open({ home: homeB.path });
        expect(await settled.store.readState(project!.id)).toContain('mine');

        // And A converges on it, rather than the two machines disagreeing.
        await syncA.sync({});
        const backOnA = await Workspace.open({ home: homeA.path });
        expect(await backOnA.store.readState(project!.id)).toContain('mine');
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  describe('concurrency', () => {
    it.runIf(GIT_AVAILABLE)(
      'two sessions writing at once both survive, and one sync sends both',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const first = join(code.path, 'one');
        const second = join(code.path, 'two');
        await makeRealRepo(first, { remote: 'git@github.com:acme/one.git' });
        await makeRealRepo(second, { remote: 'git@github.com:acme/two.git' });

        await Promise.all([
          sessionStart(homeA.path, first, 's-1'),
          sessionStart(homeA.path, second, 's-2'),
        ]);
        await Promise.all([
          postCompact(homeA.path, first, 's-1', 'Session one did work. Next: more.'),
          postCompact(homeA.path, second, 's-2', 'Session two did work. Next: more.'),
        ]);

        const workspace = await Workspace.open({ home: homeA.path });
        const registry = new Registry(workspace.store);
        const projects = await registry.all();
        expect(projects.map((project) => project.name).sort()).toEqual(['one', 'two']);

        // Both checkpoints exist; neither session overwrote the other.
        for (const project of projects) {
          expect(await workspace.store.listCheckpointFiles(project.id)).not.toHaveLength(0);
        }

        await performAutoSync({ home: homeA.path, debounceMs: 0, force: true });
        expect(await gitIn(workspace.profilePaths.root, ['status', '--porcelain'])).toBe('');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'a write during a sync is not lost: it schedules the next one',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });

        await sessionStart(homeA.path, repo, 's-1');
        await performAutoSync({ home: homeA.path, debounceMs: 0, force: true });

        // A write lands after the sync completed.
        await postCompact(homeA.path, repo, 's-1', 'Landed after the sync. Next: verify.');

        const pending = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );
        expect(pending.sync_requested_at).toBeTruthy();

        const outcome = await performAutoSync({ home: homeA.path, debounceMs: 0 });
        expect(outcome.ran).toBe(true);
        expect(await gitIn(workspace.profilePaths.root, ['status', '--porcelain'])).toBe('');
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // The whole promise, end to end
  // -------------------------------------------------------------------------

  describe('two machines, no StateNest commands', () => {
    it.runIf(GIT_AVAILABLE)(
      'context follows the user from one machine to the other',
      async () => {
        // --- Machine A: set up, then just work -----------------------------
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);

        const repoA = join(code.path, 'harbour');
        await makeRealRepo(repoA, { remote: 'git@github.com:acme/harbour.git' });

        // No `statenest add`. No `statenest scan`. Claude simply opens.
        await sessionStart(homeA.path, repoA, 'a-session-1');
        // Work happens; Claude Code compacts and hands over its own summary.
        await postCompact(
          homeA.path,
          repoA,
          'a-session-1',
          'Replaced the greedy allocator with cost-based berth allocation.\n\n' +
            '- Implemented cost-based allocation\n- Next: re-run the winter fixtures\n',
        );
        // No `statenest sync`.
        await performAutoSync({ home: homeA.path, debounceMs: 0 });

        const wsA = await Workspace.open({ home: homeA.path });
        expect(await gitIn(wsA.profilePaths.root, ['status', '--porcelain'])).toBe('');

        // --- Machine B: a different computer, a clone at a different path --
        await machine(homeB.path, 'linux-b');
        await connect(homeB.path);
        await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

        const repoB = join(code.path, 'harbour-elsewhere');
        await makeRealRepo(repoB, { remote: 'git@github.com:acme/harbour.git' });

        // Again: no add, no scan, no sync.
        const injected = await sessionStart(homeB.path, repoB, 'b-session-1');

        // A's work is in front of Claude on B.
        expect(injected).toContain('cost-based berth allocation');

        const wsB = await Workspace.open({ home: homeB.path });
        const projectsB = await new Registry(wsB.store).all();
        expect(projectsB).toHaveLength(1);
        const project = projectsB[0]!;
        expect(project.repository?.identity).toBe('github.com/acme/harbour');

        // One project, two locations, two machines.
        expect(project.local_locations).toHaveLength(2);
        expect(new Set(project.local_locations.map((l) => l.machine_id)).size).toBe(2);

        // --- B works, and A picks it up ------------------------------------
        await postCompact(
          homeB.path,
          repoB,
          'b-session-1',
          'Re-ran the winter fixtures; three berths still starve.\n\n- Next: weight by vessel size\n',
        );
        await performAutoSync({ home: homeB.path, debounceMs: 0 });

        await performAutoSync({ home: homeA.path, debounceMs: 0, force: true });
        const backOnA = await sessionStart(homeA.path, repoA, 'a-session-2');
        expect(backOnA).toContain('winter fixtures');

        // Starting that session recorded activity, so there is now local work
        // to send - which is precisely what schedules the next sync. Once it
        // runs, both profiles are clean again and nothing new is outstanding:
        // the v0.1.2 invariant holds under automatic sync, and a sync cannot
        // manufacture the change that would trigger another one.
        await performAutoSync({ home: homeA.path, debounceMs: 0, force: true });
        await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

        const finalA = await Workspace.open({ home: homeA.path });
        expect(await new Registry(finalA.store).all()).toHaveLength(1);
        expect(await gitIn(finalA.profilePaths.root, ['status', '--porcelain'])).toBe('');
        expect(await gitIn(wsB.profilePaths.root, ['status', '--porcelain'])).toBe('');

        // Nothing is left pending on either machine: the loop settles.
        for (const home of [homeA.path, homeB.path]) {
          const workspace = await Workspace.open({ home });
          const local = await readMachineLocalState(
            workspace.paths,
            workspace.profile.name,
            workspace.profile,
          );
          expect(local.sync_requested_at).toBeNull();
          expect(local.sync_health.state).toBe('ok');
        }

        // And nothing touched the source repositories.
        expect(await gitIn(repoA, ['status', '--porcelain'])).toBe('');
        expect(await gitIn(repoB, ['status', '--porcelain'])).toBe('');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      'a session with no network still starts, registers and remembers',
      async () => {
        await machine(homeA.path, 'mac-a');
        await connect(homeA.path);
        const workspace = await Workspace.open({ home: homeA.path });

        // Point the remote at nothing before anything happens.
        await execFileAsync('git', [
          '-C',
          workspace.profilePaths.root,
          'remote',
          'set-url',
          'origin',
          join(bare.path, 'not-here'),
        ]);

        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });

        const started = Date.now();
        await sessionStart(homeA.path, repo, 'offline-1');
        const elapsed = Date.now() - started;

        // The session is not held up by a remote that is not answering.
        expect(elapsed).toBeLessThan(3_000);

        const registry = new Registry((await Workspace.open({ home: homeA.path })).store);
        const [project] = await registry.all();
        expect(project?.name).toBe('harbour');

        await postCompact(homeA.path, repo, 'offline-1', 'Worked offline. Next: sync later.');
        expect(await workspace.store.listCheckpointFiles(project!.id)).not.toHaveLength(0);

        // The network comes back and everything queued goes out.
        await execFileAsync('git', [
          '-C',
          workspace.profilePaths.root,
          'remote',
          'set-url',
          'origin',
          bare.path,
        ]);
        const recovered = await performAutoSync({ home: homeA.path, debounceMs: 0, force: true });
        expect(['synced', 'up-to-date']).toContain(recovered.result?.outcome);
        expect(await gitIn(workspace.profilePaths.root, ['status', '--porcelain'])).toBe('');

        // One project, not two.
        expect(await new Registry((await Workspace.open({ home: homeA.path })).store).all()).toHaveLength(1);
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // -------------------------------------------------------------------------
  // Latency
  // -------------------------------------------------------------------------

  describe('session start stays fast', () => {
    it.runIf(GIT_AVAILABLE)(
      'a known project with no sync configured is well inside the budget',
      async () => {
        await machine(homeA.path, 'mac-a');
        const repo = join(code.path, 'harbour');
        await makeRealRepo(repo, { remote: 'git@github.com:acme/harbour.git' });
        await sessionStart(homeA.path, repo, 'warm-up');

        const samples: number[] = [];
        for (let i = 0; i < 10; i++) {
          const started = Date.now();
          await sessionStart(homeA.path, repo, `timed-${i}`);
          samples.push(Date.now() - started);
        }
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples.at(-1)!;

        // The handler deadline is 2.5s; an ordinary start should be nowhere
        // near it, and this is the guard against that quietly stopping to be
        // true.
        expect(p95).toBeLessThan(1_000);
      },
      GIT_TEST_TIMEOUT,
    );
  });
});

// ---------------------------------------------------------------------------

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 20_000 });
  return stdout.trim();
}

/** Every tracked path and its size, for proving a directory was not touched. */
async function snapshotTree(root: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, key);
      else out[key] = (await stat(full)).size;
    }
  };
  await walk(root, '');
  return out;
}

// Referenced so the import is not flagged; the helper reads files in assertions.
void readFile;
