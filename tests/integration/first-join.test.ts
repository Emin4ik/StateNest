import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import { preserveMachineLocations } from '../../src/core/adoption.js';
import { runHook } from '../../src/integrations/claude/handlers.js';
import { performAutoSync } from '../../src/sync/auto-sync.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { DecisionSchema, TaskSchema } from '../../src/core/schema.js';
import { now } from '../../src/util/time.js';
import { makeRealRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();
const GIT_TEST_TIMEOUT = 120_000;

/**
 * Joining a profile that already exists, and still being on the map.
 *
 * A second computer has local files but no commits, so its first sync adopts
 * the remote history and materialises the remote files over the top. That is
 * correct for shared state. It was also overwriting the one thing the joining
 * machine had just legitimately discovered: that it holds this project, here.
 *
 * The symptom was mild enough to look like a cosmetic quirk — `statenest where`
 * simply did not list the new machine until its *second* session — which is
 * exactly why it is worth a test. The project, its history and its injected
 * context were all correct, so nothing obviously broke.
 */
describe('first join', () => {
  let bare: TempDir;
  let homeA: TempDir;
  let homeB: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    bare = await makeTempDir('sn-join-bare-');
    homeA = await makeTempDir('sn-join-a-');
    homeB = await makeTempDir('sn-join-b-');
    code = await makeTempDir('sn-join-code-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([bare.cleanup(), homeA.cleanup(), homeB.cleanup(), code.cleanup()]);
  });

  async function machine(home: string) {
    const workspace = await Workspace.initialize({ home, profileName: 'personal' });
    const sync = new ProfileSync(
      workspace.profilePaths,
      workspace.paths.home,
      preserveMachineLocations(workspace.store, workspace.machineId),
    );
    await sync.initialise(bare.path);
    await workspace.saveProfile({
      ...workspace.profile,
      sync: { ...workspace.profile.sync, enabled: true, remote: bare.path, branch: 'main' },
    });
    return { workspace, sync, registry: new Registry(workspace.store) };
  }

  const sessionStart = async (home: string, cwd: string, sessionId: string) => {
    const previous = process.env['STATENEST_HOME'];
    process.env['STATENEST_HOME'] = home;
    try {
      return await runHook(
        'session-start',
        JSON.stringify({
          hook_event_name: 'SessionStart',
          cwd,
          session_id: sessionId,
          source: 'startup',
        }),
      );
    } finally {
      if (previous === undefined) delete process.env['STATENEST_HOME'];
      else process.env['STATENEST_HOME'] = previous;
    }
  };

  const gitIn = async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 20_000 });
    return stdout.trim();
  };

  /** Machine A: an established profile with a project and real history. */
  async function establishA(): Promise<{ projectId: string; pathA: string }> {
    const a = await machine(homeA.path);
    const pathA = join(code.path, 'a', 'harbour');
    await makeRealRepo(pathA, { remote: 'git@github.com:acme/harbour.git' });

    const { project } = await a.registry.register(pathA, { machineId: a.workspace.machineId });

    await createCheckpoint(
      a.workspace.store,
      project,
      { summary: 'Replaced the greedy allocator.', completed: ['cost-based allocation'] },
      { machineId: a.workspace.machineId, source: 'manual', repo: null },
    );
    await a.workspace.store.writeTasks({
      schema_version: 1,
      project_id: project.id,
      tasks: [
        TaskSchema.parse({
          id: 't_fixtures',
          text: 're-run the winter fixtures',
          status: 'todo',
          created_at: now(),
          updated_at: now(),
        }),
      ],
    });
    await a.workspace.store.appendDecision(
      DecisionSchema.parse({
        id: 'dec_alloc',
        project_id: project.id,
        timestamp: now(),
        title: 'Use cost-based berth allocation',
        reason: 'greedy starved small vessels',
        alternatives: ['round-robin'],
        machine_id: a.workspace.machineId,
      }),
    );

    const pushed = await a.sync.sync({});
    expect(pushed.outcome).toBe('synced');
    return { projectId: project.id, pathA };
  }

  it.runIf(GIT_AVAILABLE)(
    "records the joining machine's location on its very first session",
    async () => {
      const { projectId, pathA } = await establishA();

      // --- Machine B: fresh, same remote, a clone at a different path -------
      const b = await machine(homeB.path);
      const pathB = join(code.path, 'b', 'harbour-elsewhere');
      await makeRealRepo(pathB, { remote: 'git@github.com:acme/harbour.git' });

      const machineA = (await Workspace.open({ home: homeA.path })).machineId;
      const machineB = b.workspace.machineId;
      expect(machineB).not.toBe(machineA);

      // No add. No scan. One session, and the sync it schedules by itself.
      //
      // The sync is driven directly rather than through the detached runner the
      // hook would spawn: in-process there is no StateNest binary to re-invoke.
      // What matters here is the adoption, which is identical either way.
      await sessionStart(homeB.path, pathB, 'b-first');
      await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

      // --- the assertion this test exists for -------------------------------
      const after = await Workspace.open({ home: homeB.path });
      const projects = await new Registry(after.store).all();
      expect(projects).toHaveLength(1);

      const project = projects[0]!;
      expect(project.id).toBe(projectId);
      expect(project.repository?.identity).toBe('github.com/acme/harbour');

      const byMachine = new Map(
        project.local_locations.map((location) => [location.machine_id, location.path]),
      );
      expect(byMachine.size).toBe(2);
      expect(byMachine.get(machineA)).toContain('harbour');
      expect(byMachine.get(machineB)).toContain('harbour-elsewhere');
      // Different paths, as a real second machine would have.
      expect(byMachine.get(machineA)).not.toBe(byMachine.get(machineB));
      expect(pathA).not.toBe(pathB);

      // --- nothing of A's was lost ------------------------------------------
      expect(await after.store.listCheckpointFiles(projectId)).toHaveLength(1);
      expect((await after.store.readTasks(projectId)).tasks).toHaveLength(1);
      expect(await after.store.readDecisions(projectId)).toHaveLength(1);

      // --- and the profile is clean -----------------------------------------
      expect(await gitIn(after.profilePaths.root, ['status', '--porcelain'])).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'propagates the new location back to the machine that was already there',
    async () => {
      const { projectId } = await establishA();

      const machineB = (await machine(homeB.path)).workspace.machineId;
      const pathB = join(code.path, 'b', 'harbour-elsewhere');
      await makeRealRepo(pathB, { remote: 'git@github.com:acme/harbour.git' });

      await sessionStart(homeB.path, pathB, 'b-first');
      await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

      // A syncs and learns about B without anyone intervening.
      const a = await Workspace.open({ home: homeA.path });
      const syncA = new ProfileSync(
        a.profilePaths,
        a.paths.home,
        preserveMachineLocations(a.store, a.machineId),
      );
      await syncA.sync({});

      const seenFromA = await new Registry(
        (await Workspace.open({ home: homeA.path })).store,
      ).byId(projectId);
      expect(seenFromA?.local_locations.map((l) => l.machine_id)).toContain(machineB);
      expect(seenFromA?.local_locations).toHaveLength(2);
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'stays clean and idempotent across alternating syncs afterwards',
    async () => {
      const { projectId } = await establishA();

      await machine(homeB.path);
      const pathB = join(code.path, 'b', 'harbour-elsewhere');
      await makeRealRepo(pathB, { remote: 'git@github.com:acme/harbour.git' });
      await sessionStart(homeB.path, pathB, 'b-first');
      await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

      const a = await Workspace.open({ home: homeA.path });
      const syncA = new ProfileSync(
        a.profilePaths,
        a.paths.home,
        preserveMachineLocations(a.store, a.machineId),
      );

      for (let round = 0; round < 3; round++) {
        const resultA = await syncA.sync({});
        expect(['synced', 'up-to-date']).toContain(resultA.outcome);
        expect(await gitIn(a.profilePaths.root, ['status', '--porcelain'])).toBe('');

        const resultB = await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });
        expect(['synced', 'up-to-date']).toContain(resultB.result?.outcome);
        const current = await Workspace.open({ home: homeB.path });
        expect(await gitIn(current.profilePaths.root, ['status', '--porcelain'])).toBe('');
      }

      // Still one project, still two locations, nothing duplicated by repetition.
      for (const home of [homeA.path, homeB.path]) {
        const workspace = await Workspace.open({ home });
        const projects = await new Registry(workspace.store).all();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.id).toBe(projectId);
        expect(projects[0]?.local_locations).toHaveLength(2);
      }
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'keeps a second clone on the joining machine as a second location, not a second project',
    async () => {
      const { projectId } = await establishA();

      const b = await machine(homeB.path);
      const first = join(code.path, 'b', 'harbour-one');
      const second = join(code.path, 'b', 'harbour-two');
      await makeRealRepo(first, { remote: 'git@github.com:acme/harbour.git' });
      await makeRealRepo(second, { remote: 'git@github.com:acme/harbour.git' });

      // Both discovered before B has ever synced, so both must survive adoption.
      await sessionStart(homeB.path, first, 'b-1');
      await sessionStart(homeB.path, second, 'b-2');
      await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

      const after = await Workspace.open({ home: homeB.path });
      const projects = await new Registry(after.store).all();
      expect(projects).toHaveLength(1);
      expect(projects[0]?.id).toBe(projectId);

      const mine = projects[0]!.local_locations.filter(
        (location) => location.machine_id === b.workspace.machineId,
      );
      expect(mine).toHaveLength(2);
      expect(await gitIn(after.profilePaths.root, ['status', '--porcelain'])).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );

  it.runIf(GIT_AVAILABLE)(
    'leaves a project that exists only on the joining machine untouched',
    async () => {
      await establishA();

      await machine(homeB.path);
      const onlyHere = join(code.path, 'b', 'refinery');
      await makeRealRepo(onlyHere, { remote: 'git@github.com:acme/refinery.git' });
      await sessionStart(homeB.path, onlyHere, 'b-local');
      await performAutoSync({ home: homeB.path, debounceMs: 0, force: true });

      const after = await Workspace.open({ home: homeB.path });
      const names = (await new Registry(after.store).all()).map((p) => p.name).sort();
      // A's project arrived; B's own was not discarded by adoption.
      expect(names).toEqual(['harbour', 'refinery']);
      expect(await gitIn(after.profilePaths.root, ['status', '--porcelain'])).toBe('');
    },
    GIT_TEST_TIMEOUT,
  );
});
