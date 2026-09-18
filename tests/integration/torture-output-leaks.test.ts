import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { buildRecent, buildResumeBrief, renderSessionContext } from '../../src/core/context.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { search } from '../../src/search/search.js';
import { startDashboard, type RunningDashboard } from '../../src/dashboard/server.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Secrets that are already on disk.
 *
 * The write path scrubs everything StateNest persists, but that only
 * protects data *this build* wrote. Text reaches `state.md`, a project record
 * or a checkpoint other ways: a hand edit, a sync from a machine running an
 * older version, or a build predating the scanner.
 *
 * This was a real leak. A credential written straight to `state.md` flowed
 * through the resume brief into the context injected into the model, and onto
 * the dashboard. Every output path is now scrubbed on the way out as well, and
 * these tests attack each of them directly rather than going through the write
 * path that would have cleaned the value first.
 */
describe('a secret already on disk never reaches an output', () => {
  let home: TempDir;
  let code: TempDir;
  let workspace: Workspace;
  let projectId: string;
  let server: RunningDashboard | null = null;

  const TOKEN = `ghp_${'Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye'.repeat(2).slice(0, 36)}`;
  const DB_URL = 'postgres://admin:Sup3rS3cretn0treal@db.internal:5432/app';

  beforeEach(async () => {
    home = await makeTempDir('pb-leak-home-');
    code = await makeTempDir('pb-leak-code-');
    workspace = await Workspace.initialize({ home: home.path });

    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'leaky'), { remote: 'git@github.com:acme/leaky.git' });
    const { project } = await registry.register(join(code.path, 'leaky'), {
      machineId: workspace.machineId,
    });
    projectId = project.id;

    // Everything below bypasses the write-path scrubber on purpose: these are
    // raw writes, exactly as an older build or a hand edit would produce.
    await workspace.store.writeState(
      project.id,
      `# Current focus\n\nDebugging auth with ${TOKEN}\n\n# Environment\n\n${DB_URL}\n`,
    );
    await registry.save({
      ...project,
      name: `app-${TOKEN}`,
      description: `connects using ${DB_URL}`,
      current_focus: `rotating ${TOKEN}`,
      notes: `note ${TOKEN}`,
      blockers: [`${TOKEN} is rejected`],
    });
    await workspace.store.writeTasks({
      schema_version: 1,
      project_id: project.id,
      tasks: [
        {
          id: 't1',
          text: `rotate ${TOKEN}`,
          status: 'todo',
          created_at: '2026-09-18T00:00:00Z',
          updated_at: '2026-09-18T00:00:00Z',
          completed_at: null,
          tags: [],
          source: 'manual',
        },
      ],
    });
    await workspace.store.appendDecision({
      id: 'dec_1',
      project_id: project.id,
      timestamp: '2026-09-18T00:00:00Z',
      title: `use ${TOKEN} for deploys`,
      reason: `because ${DB_URL} needs it`,
      alternatives: [],
      tags: [],
      superseded_by: null,
    });

    // A checkpoint file written by hand, not through createCheckpoint.
    const dir = join(workspace.profilePaths.checkpointDir(project.id), '2026', '09', '18');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '120000_cp_handwritten.md'),
      [
        '---',
        'id: cp_handwritten',
        `project_id: ${project.id}`,
        'timestamp: 2026-09-18T12:00:00Z',
        'machine_id: machine_old',
        '---',
        '',
        '# Summary',
        '',
        `Deployed using ${TOKEN}`,
        '',
        '# Next',
        '',
        `- rotate ${TOKEN}`,
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await home.cleanup();
    await code.cleanup();
  });

  async function reload() {
    const reopened = await Workspace.open({ home: home.path });
    const registry = new Registry(reopened.store);
    const project = (await registry.byId(projectId))!;
    return { workspace: reopened, registry, project };
  }

  const SECRETS = [TOKEN, 'Sup3rS3cretn0treal'];

  function expectClean(label: string, text: string) {
    for (const secret of SECRETS) {
      expect(text, `${label} leaked a credential`).not.toContain(secret);
    }
  }

  it('is absent from the resume brief', async () => {
    const { workspace: reopened, project } = await reload();
    const brief = await buildResumeBrief(reopened.store, project, {
      machineId: reopened.machineId,
      checkpointLimit: 5,
    });
    expectClean('resume brief', JSON.stringify(brief));
  });

  it('is absent from the context injected into the model', async () => {
    const { workspace: reopened, project } = await reload();
    const brief = await buildResumeBrief(reopened.store, project, {
      machineId: reopened.machineId,
    });
    expectClean('session context', renderSessionContext(brief, { machineName: 'test' }));
  });

  it('is absent from the recent feed', async () => {
    const { workspace: reopened, project } = await reload();
    expectClean('recent feed', JSON.stringify(await buildRecent(reopened.store, [project])));
  });

  it('is absent from search results', async () => {
    const { workspace: reopened, registry } = await reload();
    for (const query of ['Deployed', 'rotate', 'auth', 'app']) {
      const hits = await search(reopened.store, await registry.all(), query);
      expectClean(`search "${query}"`, JSON.stringify(hits));
    }
  });

  it('is absent from every dashboard payload', async () => {
    const { workspace: reopened } = await reload();
    server = await startDashboard(reopened, { host: '127.0.0.1', port: 0 });

    for (const path of [
      '/api/overview',
      '/api/projects',
      '/api/recent',
      `/api/project?id=${projectId}`,
      '/api/search?q=Deployed',
      '/api/search?q=rotate',
      '/api/machines',
      '/api/remotes',
    ]) {
      const body = await (await fetch(`${server.url}${path}`)).text();
      expectClean(`dashboard ${path}`, body);
    }
  });

  it('still shows the surrounding content, so redaction is not censorship', async () => {
    const { workspace: reopened, project } = await reload();
    const brief = await buildResumeBrief(reopened.store, project, {
      machineId: reopened.machineId,
    });

    expect(brief.currentFocus).toContain('rotating');
    expect(brief.currentFocus).toContain('redacted by StateNest');
    expect(brief.checkpoints[0]?.summary).toContain('Deployed using');
  });

  it('leaves the original file on disk untouched', async () => {
    // Redaction on read must not rewrite the user's data behind their back:
    // `statenest privacy audit` has to still be able to find and report it.
    const { readFile } = await import('node:fs/promises');
    const state = await readFile(workspace.profilePaths.stateFile(projectId), 'utf8');
    expect(state).toContain(TOKEN);

    const { auditProfile, hasBlockingFindings } = await import('../../src/security/audit.js');
    expect(hasBlockingFindings(await auditProfile(workspace.profilePaths))).toBe(true);
  });
});

/**
 * Reading a few recent checkpoints must cost a few directory reads, not one per
 * day the project has ever been worked on.
 *
 * This regressed silently: the walker built the complete file list and the
 * caller sliced it, so a project with two years of history made the session
 * brief six times slower than one started yesterday - and long-lived projects
 * are precisely who this tool exists for.
 */
describe('checkpoint reads do not scale with history', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-cpscale-home-');
    code = await makeTempDir('pb-cpscale-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function setup(months: number) {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'busy'), { remote: 'git@github.com:acme/busy.git' });
    const { project } = await registry.register(join(code.path, 'busy'), {
      machineId: workspace.machineId,
    });

    for (let month = 1; month <= months; month++) {
      for (let day = 1; day <= 28; day += 7) {
        await createCheckpoint(
          workspace.store,
          project,
          { summary: `checkpoint ${month}-${day}` },
          {
            machineId: workspace.machineId,
            source: 'cli',
            timestamp: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T10:00:00Z`,
          },
        );
      }
    }
    return { workspace, project };
  }

  it('reads only as many files as asked for', async () => {
    const { workspace, project } = await setup(12);

    const three = await workspace.store.listCheckpointFiles(project.id, { limit: 3 });
    expect(three).toHaveLength(3);

    const all = await workspace.store.listCheckpointFiles(project.id);
    expect(all.length).toBe(12 * 4);
  });

  it('returns the same newest entries whether limited or not', async () => {
    const { workspace, project } = await setup(12);

    const limited = await workspace.store.listCheckpoints(project.id, { limit: 3 });
    const everything = await workspace.store.listCheckpoints(project.id);

    expect(limited.map((c) => c.summary)).toEqual(everything.slice(0, 3).map((c) => c.summary));
    // Newest first.
    expect(everything[0]!.meta.timestamp > everything[1]!.meta.timestamp).toBe(true);
  });

  it('costs roughly the same at one month and at twelve', async () => {
    const short = await setup(1);
    const shortTime = await timeIt(() =>
      short.workspace.store.listCheckpoints(short.project.id, { limit: 3 }),
    );
    await home.cleanup();

    home = await makeTempDir('pb-cpscale-home2-');
    const long = await setup(12);
    const longTime = await timeIt(() =>
      long.workspace.store.listCheckpoints(long.project.id, { limit: 3 }),
    );

    // Twelve times the history must not cost anything like twelve times the
    // work. A generous factor keeps this from flaking on a loaded machine while
    // still catching a return to O(history).
    expect(longTime).toBeLessThan(Math.max(shortTime * 4, 25));
  });

  it('still honours `since` alongside a limit', async () => {
    const { workspace, project } = await setup(6);
    const recent = await workspace.store.listCheckpoints(project.id, {
      limit: 5,
      since: '2026-05-01T00:00:00Z',
    });
    for (const checkpoint of recent) {
      expect(checkpoint.meta.timestamp >= '2026-05-01T00:00:00Z').toBe(true);
    }
  });

  it('tolerates an unreadable file without returning fewer than asked', async () => {
    const { workspace, project } = await setup(3);
    const files = await workspace.store.listCheckpointFiles(project.id);
    // Corrupt the newest one.
    await writeFile(files[0]!, '---\nnot: [valid\n---\n');

    const checkpoints = await workspace.store.listCheckpoints(project.id, { limit: 3 });
    expect(checkpoints).toHaveLength(3);
  });
});

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) await fn();
  return Number(process.hrtime.bigint() - start) / 1e6 / 10;
}
