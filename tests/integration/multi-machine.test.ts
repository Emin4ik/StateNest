import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { RemoteSchema, TaskSchema, DecisionSchema } from '../../src/core/schema.js';
import { randomId } from '../../src/util/ids.js';
import { now } from '../../src/util/time.js';
import { makeFakeRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();

/** Real git processes against two working copies and a bare remote. */
const GIT_TEST_TIMEOUT = 120_000;

/**
 * "I have StateNest on my home MacBook and my work laptop, and projects on
 * several VPSes. I want to see everything in one place."
 *
 * Everything here drives the real sync path against a real bare repository,
 * because the only interesting questions are the ones that involve two
 * histories meeting: does one project stay one project, does anything get
 * silently dropped, and does a genuine disagreement surface or get resolved in
 * somebody's favour without telling them.
 */
describe('multi-machine', () => {
  let bare: TempDir;
  let homeA: TempDir;
  let homeB: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    bare = await makeTempDir('sn-mm-bare-');
    homeA = await makeTempDir('sn-mm-a-');
    homeB = await makeTempDir('sn-mm-b-');
    code = await makeTempDir('sn-mm-code-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([bare.cleanup(), homeA.cleanup(), homeB.cleanup(), code.cleanup()]);
  });

  async function machine(home: string, profileName = 'personal') {
    const workspace = await Workspace.initialize({ home, profileName });
    const registry = new Registry(workspace.store);
    const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
    return { workspace, registry, sync };
  }

  async function connected(home: string, profileName = 'personal') {
    const m = await machine(home, profileName);
    await m.sync.initialise(bare.path);
    return m;
  }

  /** Everything a real profile accumulates: projects, memory, infrastructure. */
  async function populate(
    m: Awaited<ReturnType<typeof machine>>,
    name: string,
    remote: string,
  ) {
    await makeFakeRepo(join(code.path, name), { remote });
    const { project } = await m.registry.register(join(code.path, name), {
      machineId: m.workspace.machineId,
    });

    await createCheckpoint(
      m.workspace.store,
      project,
      { summary: `Worked on ${name}.`, next: [`finish ${name}`] },
      { machineId: m.workspace.machineId, source: 'cli' },
    );
    await m.workspace.store.writeTasks({
      schema_version: 1,
      project_id: project.id,
      tasks: [
        TaskSchema.parse({
          id: `t_${name}`,
          text: `ship ${name}`,
          status: 'todo',
          created_at: now(),
          updated_at: now(),
        }),
      ],
    });
    await m.workspace.store.appendDecision(
      DecisionSchema.parse({
        id: `dec_${name}`,
        project_id: project.id,
        title: `Chose an approach for ${name}`,
        reason: 'it was the simplest thing that worked',
        timestamp: now(),
        machine_id: m.workspace.machineId,
      }),
    );
    return project;
  }

  async function addServer(m: Awaited<ReturnType<typeof machine>>, name: string) {
    return m.workspace.store.saveRemote(
      RemoteSchema.parse({
        id: randomId('rmt'),
        name,
        host: `${name}.example.invalid`,
        user: 'deploy',
        environment: 'production',
        created_at: now(),
        updated_at: now(),
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Part 2: the sequence a real user follows.
  // ---------------------------------------------------------------------
  describe('the documented first-sync sequence', () => {
    it.runIf(GIT_AVAILABLE)(
      'carries a populated profile to a fresh machine, then merges one repository into one project',
      async () => {
        // --- A: populated profile, empty sync repository -------------------
        const a = await connected(homeA.path);
        const apiA = await populate(a, 'api', 'git@github.com:acme/api.git');
        await populate(a, 'site', 'git@github.com:acme/site.git');
        await addServer(a, 'prod-1');

        const firstA = await a.sync.sync({ message: 'first sync from A' });
        expect(firstA.outcome).toBe('synced');

        // --- B: fresh install, same profile name, same repository ----------
        const b = await connected(homeB.path);
        expect(b.workspace.machineId).not.toBe(a.workspace.machineId);
        expect((await b.registry.all())).toHaveLength(0);

        const firstB = await b.sync.sync({ message: 'first sync from B' });
        expect(firstB.outcome).toBe('synced');

        // B now sees A's work.
        b.registry.invalidate();
        const onB = await b.registry.all();
        expect(onB.map((p) => p.name).sort()).toEqual(['api', 'site']);
        expect(await b.workspace.store.listRemotes()).toHaveLength(1);

        const carriedTasks = await b.workspace.store.readTasks(apiA.id);
        expect(carriedTasks.tasks.map((t) => t.text)).toEqual(['ship api']);
        expect(await b.workspace.store.readDecisions(apiA.id)).toHaveLength(1);
        expect(await b.workspace.store.listCheckpointFiles(apiA.id)).toHaveLength(1);

        // B keeps its own machine identity rather than adopting A's.
        const machines = await b.workspace.store.listMachines();
        expect(machines.map((m) => m.id).sort()).toEqual(
          [a.workspace.machineId, b.workspace.machineId].sort(),
        );

        // --- The same repository, cloned on B at a different path ----------
        const bPath = join(code.path, 'elsewhere', 'api-checkout');
        await makeFakeRepo(bPath, { remote: 'git@github.com:acme/api.git' });
        const registered = await b.registry.register(bPath, { machineId: b.workspace.machineId });

        // One identity, not two.
        expect(registered.outcome).toBe('location-added');
        expect(registered.project.id).toBe(apiA.id);
        expect(registered.project.local_locations).toHaveLength(2);

        await b.sync.sync({ message: 'B registers its clone' });
        await a.sync.sync({ message: 'A picks it up' });

        // --- A sees one project with two machine locations -----------------
        a.registry.invalidate();
        const apiOnA = (await a.registry.all()).find((p) => p.id === apiA.id)!;
        expect(apiOnA.local_locations).toHaveLength(2);
        expect(new Set(apiOnA.local_locations.map((l) => l.machine_id))).toEqual(
          new Set([a.workspace.machineId, b.workspace.machineId]),
        );

        // --- Nothing duplicated, nothing lost ------------------------------
        const all = await a.registry.all();
        expect(all).toHaveLength(2);
        expect(new Set(all.map((p) => p.id)).size).toBe(2);
        expect(await a.workspace.store.listCheckpointFiles(apiA.id)).toHaveLength(1);
        expect((await a.workspace.store.readTasks(apiA.id)).tasks).toHaveLength(1);
        expect(await a.workspace.store.readDecisions(apiA.id)).toHaveLength(1);
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // ---------------------------------------------------------------------
  // Part 8: the whole picture, as a user would want to see it.
  // ---------------------------------------------------------------------
  describe('the unified picture', () => {
    it.runIf(GIT_AVAILABLE)(
      'joins projects, profiles, machines, deployments and next actions without touching any repository',
      async () => {
        const a = await connected(homeA.path);
        const b = await connected(homeB.path);

        const api = await populate(a, 'api', 'git@github.com:acme/api.git');
        const site = await populate(a, 'site', 'git@github.com:acme/site.git');

        // Two VPSes, two deployments.
        const prod = await addServer(a, 'prod-1');
        const staging = await addServer(a, 'staging-1');
        for (const [project, remote, path, env] of [
          [api, prod, '/srv/api', 'production'],
          [site, staging, '/srv/site', 'staging'],
        ] as const) {
          await a.registry.save({
            ...project,
            deployments: [
              {
                id: randomId('dep'),
                remote_id: remote.id,
                environment: env,
                path,
                created_at: now(),
                updated_at: now(),
              },
            ],
          });
        }

        await a.sync.sync({});
        await b.sync.sync({});

        // The same repository, checked out on B at a different path.
        const bPath = join(code.path, 'laptop', 'api');
        await makeFakeRepo(bPath, { remote: 'git@github.com:acme/api.git' });
        await b.registry.register(bPath, { machineId: b.workspace.machineId });
        await b.sync.sync({});
        await a.sync.sync({});

        // --- Fingerprint the source repositories before reading ------------
        //
        // Every file, including everything under .git. A byte-for-byte
        // comparison is a stronger statement than `git status` anyway: it
        // catches a stray file as readily as a modified one.
        const sources = [join(code.path, 'api'), join(code.path, 'site'), bPath];
        const fingerprint = async () => {
          const seen: string[] = [];
          const walk = async (dir: string, prefix: string) => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const full = join(dir, entry.name);
              const rel = `${prefix}/${entry.name}`;
              if (entry.isDirectory()) await walk(full, rel);
              else seen.push(`${rel}:${await readFile(full, 'utf8')}`);
            }
          };
          for (const dir of sources) await walk(dir, dir);
          return seen.sort();
        };
        const before = await fingerprint();

        // --- Build the view ------------------------------------------------
        a.registry.invalidate();
        const machines = new Map(
          (await a.workspace.store.listMachines()).map((m) => [m.id, m.name]),
        );
        const remotes = new Map((await a.workspace.store.listRemotes()).map((r) => [r.id, r.name]));

        const rows = [];
        for (const project of await a.registry.all()) {
          const tasks = await a.workspace.store.readTasks(project.id);
          rows.push({
            project: project.name,
            profile: a.workspace.profile.name,
            machines: project.local_locations.map(
              (l) => `${machines.get(l.machine_id) ?? l.machine_id}:${l.path}`,
            ),
            deployments: project.deployments.map(
              (d) => `${remotes.get(d.remote_id) ?? d.remote_id}${d.path ? ` ${d.path}` : ''}`,
            ),
            lastActivity: project.last_activity_at,
            nextAction: tasks.tasks.find((t) => t.status === 'todo')?.text ?? null,
          });
        }

        // Every column the user asked to see is present and populated.
        expect(rows).toHaveLength(2);
        const apiRow = rows.find((r) => r.project === 'api')!;
        expect(apiRow.profile).toBe('personal');
        expect(apiRow.machines).toHaveLength(2);
        // Identity, not display name: two machines can legitimately carry the
        // same name - both of these are named after the same hostname - and it
        // is the id that decides they are different computers.
        const apiProject = (await a.registry.all()).find((p) => p.name === 'api')!;
        expect(new Set(apiProject.local_locations.map((l) => l.machine_id)).size).toBe(2);
        expect(new Set(apiProject.local_locations.map((l) => l.path)).size).toBe(2);
        expect(apiRow.deployments).toEqual(['prod-1 /srv/api']);
        expect(apiRow.lastActivity).toBeTruthy();
        expect(apiRow.nextAction).toBe('ship api');

        const siteRow = rows.find((r) => r.project === 'site')!;
        expect(siteRow.deployments).toEqual(['staging-1 /srv/site']);

        // --- And nothing in any source repository moved --------------------
        expect(await fingerprint()).toEqual(before);
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // ---------------------------------------------------------------------
  // Profile isolation: two profiles, two private repositories, no bleed.
  // ---------------------------------------------------------------------
  describe('sync is strictly per profile', () => {
    it.runIf(GIT_AVAILABLE)(
      'gives each profile its own remote, and neither carries the other\'s data',
      async () => {
        const second = await makeTempDir('sn-mm-bare2-');
        try {
          await execFileAsync('git', [
            'init', '--bare', '--quiet', '--initial-branch=main', second.path,
          ]);

          const personal = await machine(homeA.path, 'personal');
          const work = await machine(homeA.path, 'work');

          // Same StateNest home, same machine - two profiles, two repositories.
          expect(personal.workspace.profilePaths.root).not.toBe(work.workspace.profilePaths.root);
          await personal.sync.initialise(bare.path);
          await work.sync.initialise(second.path);

          await populate(personal, 'hobby', 'git@github.com:me/hobby.git');
          await populate(work, 'billing', 'git@github.com:acme/billing.git');

          expect((await personal.sync.sync({})).outcome).toBe('synced');
          expect((await work.sync.sync({})).outcome).toBe('synced');

          // Each remote must contain only its own profile's project.
          const namesIn = async (repo: string) => {
            const { stdout } = await execFileAsync('git', [
              '--git-dir', repo, 'ls-tree', '-r', '--name-only', 'main',
            ]);
            return stdout;
          };
          const personalTree = await namesIn(bare.path);
          const workTree = await namesIn(second.path);

          expect(personalTree).toContain('projects/');
          expect(personalTree).not.toContain('billing');
          expect(workTree).not.toContain('hobby');

          // And the profiles' sync settings are independent records.
          expect(personal.workspace.profile.name).toBe('personal');
          expect(work.workspace.profile.name).toBe('work');
        } finally {
          await second.cleanup();
        }
      },
      GIT_TEST_TIMEOUT,
    );
  });

  // ---------------------------------------------------------------------
  // Part 3: the cases worth knowing about before trusting it with real data.
  // ---------------------------------------------------------------------
  describe('dangerous first-sync and conflict cases', () => {
    it.runIf(GIT_AVAILABLE)(
      '1. empty remote, populated local: pushes, loses nothing',
      async () => {
        const a = await connected(homeA.path);
        await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        const result = await a.sync.sync({});
        expect(result.outcome).toBe('synced');
        expect((await a.registry.all())).toHaveLength(1);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      '2. populated remote, empty local: adopts remote history without deleting it back',
      async () => {
        const a = await connected(homeA.path);
        await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        await a.sync.sync({});

        const b = await connected(homeB.path);
        const first = await b.sync.sync({});
        expect(first.outcome).toBe('synced');
        b.registry.invalidate();
        expect((await b.registry.all()).map((p) => p.name)).toEqual(['alpha']);

        // The critical part: B's next push must not present A's projects as
        // deletions. A re-syncs and still has everything.
        await b.sync.sync({});
        await a.sync.sync({});
        a.registry.invalidate();
        expect((await a.registry.all()).map((p) => p.name)).toEqual(['alpha']);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      '3. both sides already populated with different data: both survive',
      async () => {
        const a = await connected(homeA.path);
        await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        await a.sync.sync({});

        // B is not fresh: it registered its own project before ever syncing.
        const b = await connected(homeB.path);
        await populate(b, 'beta', 'git@github.com:acme/beta.git');

        const firstB = await b.sync.sync({});
        expect(['synced', 'conflict']).toContain(firstB.outcome);
        expect(firstB.outcome).toBe('synced');

        b.registry.invalidate();
        expect((await b.registry.all()).map((p) => p.name).sort()).toEqual(['alpha', 'beta']);

        await a.sync.sync({});
        a.registry.invalidate();
        expect((await a.registry.all()).map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      '4. both machines edit different records: both edits survive',
      async () => {
        const a = await connected(homeA.path);
        const alpha = await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        await a.sync.sync({});
        const b = await connected(homeB.path);
        await b.sync.sync({});

        await a.workspace.store.appendDecision(
          DecisionSchema.parse({
            id: 'dec_from_a',
            project_id: alpha.id,
            title: 'A decided something',
            timestamp: now(),
            machine_id: a.workspace.machineId,
          }),
        );
        b.registry.invalidate();
        await createCheckpoint(
          b.workspace.store,
          (await b.registry.all())[0]!,
          { summary: 'B did some work.' },
          { machineId: b.workspace.machineId, source: 'cli' },
        );

        await a.sync.sync({});
        const fromB = await b.sync.sync({});
        expect(fromB.outcome).toBe('synced');
        await a.sync.sync({});

        expect(await a.workspace.store.readDecisions(alpha.id)).toHaveLength(2);
        expect(await a.workspace.store.listCheckpointFiles(alpha.id)).toHaveLength(2);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      '5. both machines edit the SAME record: conflict is reported, nothing is lost',
      async () => {
        const a = await connected(homeA.path);
        const alpha = await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        await a.sync.sync({});
        const b = await connected(homeB.path);
        await b.sync.sync({});

        // The same mutable file, edited differently on both sides.
        const write = async (m: Awaited<ReturnType<typeof machine>>, text: string) =>
          m.workspace.store.writeTasks({
            schema_version: 1,
            project_id: alpha.id,
            tasks: [
              TaskSchema.parse({
                id: 't_same',
                text,
                status: 'todo',
                created_at: now(),
                updated_at: now(),
              }),
            ],
          });

        await write(a, 'A says do this');
        await a.sync.sync({});
        await write(b, 'B says do that');
        const result = await b.sync.sync({});

        expect(result.outcome).toBe('conflict');
        expect(result.conflicts.length).toBeGreaterThan(0);
        expect(result.message).toContain('Nothing was lost');

        // Both versions are still on disk, in the conflicted file, for the
        // user to resolve. Neither side was silently chosen.
        const conflicted = await readFile(
          join(b.workspace.profilePaths.root, result.conflicts[0]!),
          'utf8',
        );
        expect(conflicted).toContain('A says do this');
        expect(conflicted).toContain('B says do that');
        expect(conflicted).toContain('<<<<<<<');
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      '8. an interrupted rebase is reported, not worked around',
      async () => {
        const a = await connected(homeA.path);
        const alpha = await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        await a.sync.sync({});
        const b = await connected(homeB.path);
        await b.sync.sync({});

        const write = async (m: Awaited<ReturnType<typeof machine>>, text: string) =>
          m.workspace.store.writeState(alpha.id, `# Focus\n\n${text}\n`);

        await write(a, 'A state');
        await a.sync.sync({});
        await write(b, 'B state');
        const conflict = await b.sync.sync({});
        expect(conflict.outcome).toBe('conflict');

        // A second sync while the rebase is still in progress must not pretend
        // everything is fine, and must not throw away the half-finished state.
        const again = await b.sync.sync({});
        expect(again.outcome).not.toBe('synced');
        expect(again.outcome).not.toBe('up-to-date');

        // Local data is still readable throughout.
        expect((await b.registry.all()).length).toBeGreaterThan(0);
      },
      GIT_TEST_TIMEOUT,
    );

    it.runIf(GIT_AVAILABLE)(
      '10. the same repository twice on one machine stays one project after sync',
      async () => {
        const a = await connected(homeA.path);
        const alpha = await populate(a, 'alpha', 'git@github.com:acme/alpha.git');
        const second = join(code.path, 'copies', 'alpha');
        await makeFakeRepo(second, { remote: 'git@github.com:acme/alpha.git' });
        const dup = await a.registry.register(second, { machineId: a.workspace.machineId });

        expect(dup.outcome).toBe('location-added');
        expect(dup.project.id).toBe(alpha.id);

        await a.sync.sync({});
        const b = await connected(homeB.path);
        await b.sync.sync({});
        b.registry.invalidate();

        const onB = await b.registry.all();
        expect(onB).toHaveLength(1);
        expect(onB[0]!.local_locations).toHaveLength(2);
        // Both are on A's machine, not two machines.
        expect(new Set(onB[0]!.local_locations.map((l) => l.machine_id))).toEqual(
          new Set([a.workspace.machineId]),
        );
      },
      GIT_TEST_TIMEOUT,
    );
  });
});
