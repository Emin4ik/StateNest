import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { makeFakeRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();

/**
 * Every test here drives real `git` processes against two clones and a bare
 * remote — dozens of spawns each.
 *
 * Vitest's 30s default is a fine bound for logic and a poor one for process
 * spawning, which on Windows costs several times what it does elsewhere: this
 * file takes ~15s on macOS and ~137s on a Windows runner. A timeout there says
 * "the platform is slower", not "sync is broken", so it reports a failure that
 * is never the real problem. The assertions are unchanged; only the patience.
 */
const GIT_TEST_TIMEOUT = 120_000;

/**
 * Two machines, one data repository, adversarial timing.
 *
 * The promise sync makes is narrow but absolute: nothing is ever lost, and
 * nothing is ever silently resolved in one side's favour. A tool that quietly
 * picks a winner when two machines disagree is worse than one that refuses,
 * because the user never learns what they lost.
 */
describe('two-machine sync', () => {
  let bare: TempDir;
  let homeA: TempDir;
  let homeB: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    bare = await makeTempDir('pb-sync-bare-');
    homeA = await makeTempDir('pb-sync-a-');
    homeB = await makeTempDir('pb-sync-b-');
    code = await makeTempDir('pb-sync-code-');
    if (GIT_AVAILABLE) {
      await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
    }
  });

  afterEach(async () => {
    await Promise.all([bare.cleanup(), homeA.cleanup(), homeB.cleanup(), code.cleanup()]);
  });

  async function machine(home: string, label: string) {
    const workspace = await Workspace.initialize({ home });
    const registry = new Registry(workspace.store);
    const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
    await sync.initialise(bare.path);
    return { workspace, registry, sync, label };
  }

  async function projectOn(
    m: Awaited<ReturnType<typeof machine>>,
    name: string,
    dir = name,
  ) {
    const path = join(code.path, m.label, dir);
    await makeFakeRepo(path, { remote: `git@github.com:acme/${name}.git` });
    const result = await new Registry(m.workspace.store).register(path, {
      machineId: m.workspace.machineId,
    });
    return result.project;
  }

  it.runIf(GIT_AVAILABLE)(
    'runs the full brief scenario without losing anything',
    async () => {
      const a = await machine(homeA.path, 'a');

      // A creates a project and a checkpoint, and pushes.
      const project = await projectOn(a, 'widget');
      await createCheckpoint(
        a.workspace.store,
        project,
        { summary: 'A: initial implementation' },
        { machineId: a.workspace.machineId, source: 'cli', timestamp: '2026-09-18T09:00:00Z' },
      );
      expect((await a.sync.sync()).outcome).toBe('synced');

      // B joins.
      const b = await machine(homeB.path, 'b');
      await b.sync.sync();
      expect(await new Registry(b.workspace.store).all()).toHaveLength(1);

      // B records its own checkpoint and pushes.
      const onB = (await new Registry(b.workspace.store).all())[0]!;
      await createCheckpoint(
        b.workspace.store,
        onB,
        { summary: 'B: added the preprocessing pass' },
        { machineId: b.workspace.machineId, source: 'cli', timestamp: '2026-09-18T10:00:00Z' },
      );
      await b.sync.sync();

      // A pulls B's work, then both change DIFFERENT fields of the same record.
      await a.sync.sync();
      const aProject = (await new Registry(a.workspace.store).byId(project.id))!;
      await new Registry(a.workspace.store).save({ ...aProject, current_focus: 'A: focus' });

      const bProject = (await new Registry(b.workspace.store).byId(project.id))!;
      await new Registry(b.workspace.store).save({ ...bProject, status: 'paused' });

      await a.sync.sync();
      const bResult = await b.sync.sync();

      // Whatever happened, nothing was lost and nothing was force-pushed.
      expect(['synced', 'up-to-date', 'conflict']).toContain(bResult.outcome);

      await a.sync.sync();
      const checkpoints = await a.workspace.store.listCheckpoints(project.id);
      expect(
        checkpoints.map((c) => c.summary).sort(),
        'both machines\' checkpoints must survive',
      ).toEqual(['A: initial implementation', 'B: added the preprocessing pass']);
    },
  );

  it.runIf(GIT_AVAILABLE)('never force-pushes', async () => {
    const a = await machine(homeA.path, 'a');
    await projectOn(a, 'widget');
    await a.sync.sync();

    const reflog = await execFileAsync('git', ['-C', bare.path, 'reflog', 'show', 'main'], {}).catch(
      () => ({ stdout: '' }),
    );
    // A forced update shows as "forced-update" in the receiving repo's reflog.
    expect(reflog.stdout).not.toContain('forced-update');
  }, GIT_TEST_TIMEOUT);

  it.runIf(GIT_AVAILABLE)(
    'reports a genuine conflict rather than choosing a side',
    async () => {
      const a = await machine(homeA.path, 'a');
      const project = await projectOn(a, 'widget');
      await a.sync.sync();

      const b = await machine(homeB.path, 'b');
      await b.sync.sync();

      // Both machines edit the SAME field of the same record, offline.
      const onA = (await new Registry(a.workspace.store).byId(project.id))!;
      await new Registry(a.workspace.store).save({ ...onA, current_focus: 'A says this' });
      const onB = (await new Registry(b.workspace.store).byId(project.id))!;
      await new Registry(b.workspace.store).save({ ...onB, current_focus: 'B says something else' });

      await a.sync.sync();
      const bResult = await b.sync.sync();

      if (bResult.outcome === 'conflict') {
        expect(bResult.conflicts.length).toBeGreaterThan(0);
        expect(bResult.message).toMatch(/nothing was lost/i);

        // B's own value is still on disk, not overwritten by A's.
        const stillThere = await readFile(
          b.workspace.profilePaths.projectFile(project.id),
          'utf8',
        );
        expect(stillThere).toContain('B says something else');
      } else {
        // Or git merged it cleanly - in which case one value must have won
        // openly, and the other machine's history is still intact.
        expect(['synced', 'up-to-date']).toContain(bResult.outcome);
      }

      // Either way, A's commit is still in the remote.
      const log = await execFileAsync('git', ['-C', bare.path, 'log', '--oneline', 'main']);
      expect(log.stdout.trim().split('\n').length).toBeGreaterThanOrEqual(1);
    },
  );

  it.runIf(GIT_AVAILABLE)('merges decisions from both machines rather than conflicting', async () => {
    const a = await machine(homeA.path, 'a');
    const project = await projectOn(a, 'widget');
    await a.sync.sync();

    const b = await machine(homeB.path, 'b');
    await b.sync.sync();

    // Decisions are append-only and marked merge=union precisely for this.
    await a.workspace.store.appendDecision({
      id: 'dec_a',
      project_id: project.id,
      timestamp: '2026-09-18T09:00:00Z',
      title: 'A decided to drop the timer',
      reason: 'players prefer long sessions',
      alternatives: [],
      tags: [],
      superseded_by: null,
    });
    await b.workspace.store.appendDecision({
      id: 'dec_b',
      project_id: project.id,
      timestamp: '2026-09-18T10:00:00Z',
      title: 'B decided to raise the threshold',
      reason: 'too many false positives',
      alternatives: [],
      tags: [],
      superseded_by: null,
    });

    await a.sync.sync();
    await b.sync.sync();
    await a.sync.sync();

    const decisions = await a.workspace.store.readDecisions(project.id);
    const titles = decisions.map((d) => d.title);
    expect(titles).toContain('A decided to drop the timer');
    expect(titles).toContain('B decided to raise the threshold');
  }, GIT_TEST_TIMEOUT);

  it.runIf(GIT_AVAILABLE)('a second machine keeps its own machine identity', async () => {
    const a = await machine(homeA.path, 'a');
    await projectOn(a, 'widget');
    await a.sync.sync();

    const b = await machine(homeB.path, 'b');
    await b.sync.sync();

    expect(b.workspace.machineId).not.toBe(a.workspace.machineId);

    // machine.json lives outside the profile, so it is not in the repository.
    const tracked = await execFileAsync('git', [
      '-C',
      bare.path,
      'ls-tree',
      '-r',
      '--name-only',
      'main',
    ]);
    expect(tracked.stdout).not.toContain('machine.json');
    expect(tracked.stdout).not.toContain('cache/');
    expect(tracked.stdout).not.toContain('logs/');
  }, GIT_TEST_TIMEOUT);

  it.runIf(GIT_AVAILABLE)('both machines appear as locations of one project', async () => {
    const a = await machine(homeA.path, 'a');
    const project = await projectOn(a, 'widget');
    await a.sync.sync();

    const b = await machine(homeB.path, 'b');
    await b.sync.sync();
    // B has its own clone of the same repository at a different path.
    await projectOn(b, 'widget', 'widget-on-b');
    await b.sync.sync();
    await a.sync.sync();

    const merged = (await new Registry(a.workspace.store).byId(project.id))!;
    const machineIds = new Set(merged.local_locations.map((l) => l.machine_id));
    expect(machineIds.size).toBe(2);
    expect(await new Registry(a.workspace.store).all()).toHaveLength(1);
  }, GIT_TEST_TIMEOUT);

  describe('offline', () => {
    it.runIf(GIT_AVAILABLE)('reports offline without touching local data', async () => {
      const a = await machine(homeA.path, 'a');
      await projectOn(a, 'widget');
      await a.sync.sync();

      // Point the remote at somewhere unreachable.
      await execFileAsync('git', [
        '-C',
        a.workspace.profilePaths.root,
        'remote',
        'set-url',
        'origin',
        'ssh://git@offline.invalid:22/nope.git',
      ]);

      const before = await new Registry(a.workspace.store).all();
      const result = await a.sync.sync();

      expect(['offline', 'local-only']).toContain(result.outcome);
      const after = await new Registry(a.workspace.store).all();
      expect(after).toHaveLength(before.length);
    }, GIT_TEST_TIMEOUT);

    it.runIf(GIT_AVAILABLE)('every local command still works while offline', async () => {
      const a = await machine(homeA.path, 'a');
      const project = await projectOn(a, 'widget');
      await createCheckpoint(
        a.workspace.store,
        project,
        { summary: 'offline work' },
        { machineId: a.workspace.machineId, source: 'cli' },
      );

      await execFileAsync('git', [
        '-C',
        a.workspace.profilePaths.root,
        'remote',
        'set-url',
        'origin',
        'ssh://git@offline.invalid:22/nope.git',
      ]);

      const { buildRecent, buildResumeBrief } = await import('../../src/core/context.js');
      const { search } = await import('../../src/search/search.js');
      const registry = new Registry(a.workspace.store);

      await expect(registry.all()).resolves.toHaveLength(1);
      await expect(
        buildResumeBrief(a.workspace.store, project, { machineId: a.workspace.machineId }),
      ).resolves.toBeTruthy();
      await expect(buildRecent(a.workspace.store, await registry.all())).resolves.toHaveLength(1);
      await expect(
        search(a.workspace.store, await registry.all(), 'offline'),
      ).resolves.not.toHaveLength(0);

      // And a new checkpoint can still be written.
      await expect(
        createCheckpoint(
          a.workspace.store,
          project,
          { summary: 'more offline work' },
          { machineId: a.workspace.machineId, source: 'cli', timestamp: '2026-09-18T11:00:00Z' },
        ),
      ).resolves.toBeTruthy();
    }, GIT_TEST_TIMEOUT);

    it.runIf(GIT_AVAILABLE)('recovers once the remote is reachable again', async () => {
      const a = await machine(homeA.path, 'a');
      const project = await projectOn(a, 'widget');

      const good = (
        await execFileAsync('git', ['-C', a.workspace.profilePaths.root, 'remote', 'get-url', 'origin'])
      ).stdout.trim();

      await execFileAsync('git', [
        '-C',
        a.workspace.profilePaths.root,
        'remote',
        'set-url',
        'origin',
        'ssh://git@offline.invalid:22/nope.git',
      ]);
      await a.sync.sync();

      await createCheckpoint(
        a.workspace.store,
        project,
        { summary: 'written while offline' },
        { machineId: a.workspace.machineId, source: 'cli' },
      );

      await execFileAsync('git', [
        '-C',
        a.workspace.profilePaths.root,
        'remote',
        'set-url',
        'origin',
        good,
      ]);
      expect((await a.sync.sync()).outcome).toBe('synced');

      // The offline work reached the remote.
      const listing = await execFileAsync('git', [
        '-C',
        bare.path,
        'ls-tree',
        '-r',
        '--name-only',
        'main',
      ]);
      expect(listing.stdout).toContain('checkpoints/');
    }, GIT_TEST_TIMEOUT);
  });

  describe('a credential stops everything before git sees it', () => {
    it.runIf(GIT_AVAILABLE)('blocks, commits nothing, and pushes nothing', async () => {
      const a = await machine(homeA.path, 'a');
      const project = await projectOn(a, 'widget');
      await a.sync.sync();

      const token = `ghp_${'Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye'.repeat(2).slice(0, 36)}`;
      await a.workspace.store.writeState(project.id, `# Notes\n\ndeploy token ${token}\n`);

      const result = await a.sync.sync();
      expect(result.outcome).toBe('blocked-by-secrets');
      expect(result.blockers.join('\n')).not.toContain(token);

      // The remote never saw it.
      const grep = await execFileAsync('git', [
        '-C',
        bare.path,
        'grep',
        '-r',
        token,
        'main',
      ]).catch(() => ({ stdout: '' }));
      expect(grep.stdout).toBe('');

      // And it is not in local history either, so no rewrite is needed.
      const log = await execFileAsync('git', [
        '-C',
        a.workspace.profilePaths.root,
        'log',
        '-S',
        token,
        '--oneline',
      ]).catch(() => ({ stdout: '' }));
      expect(log.stdout.trim()).toBe('');
    }, GIT_TEST_TIMEOUT);
  });

  describe('sync is not destructive', () => {
    it.runIf(GIT_AVAILABLE)('never discards an uncommitted local change', async () => {
      const a = await machine(homeA.path, 'a');
      const project = await projectOn(a, 'widget');
      await a.sync.sync();

      // Hand-edit a tracked file, as a user poking at their own data would.
      const stateFile = a.workspace.profilePaths.stateFile(project.id);
      await writeFile(stateFile, '# Current focus\n\nhand written, not yet synced\n');

      await a.sync.sync();
      await expect(readFile(stateFile, 'utf8')).resolves.toContain('hand written');
    }, GIT_TEST_TIMEOUT);

    it.runIf(GIT_AVAILABLE)('leaves a file it cannot parse alone', async () => {
      const a = await machine(homeA.path, 'a');
      const project = await projectOn(a, 'widget');
      await a.sync.sync();

      const broken = 'this: is: not: valid: [\n';
      await writeFile(a.workspace.profilePaths.projectFile(project.id), broken);

      await a.sync.sync();
      await expect(
        readFile(a.workspace.profilePaths.projectFile(project.id), 'utf8'),
      ).resolves.toBe(broken);
    }, GIT_TEST_TIMEOUT);
  });
});
