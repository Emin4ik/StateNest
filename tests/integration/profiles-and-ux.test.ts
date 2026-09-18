import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Workspace, listProfileNames } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { createPaths } from '../../src/core/paths.js';
import { buildResumeBrief, renderSessionContext } from '../../src/core/context.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { TaskSchema } from '../../src/core/schema.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Behaviour found by using the product rather than by testing it.
 *
 * Every case here comes from dogfooding: registering this repository in an
 * isolated profile, recording real state, and then reading the output as
 * someone returning after six months. The bugs were invisible from inside the
 * test suite because the suite asserted that fields existed, not that the
 * result was useful.
 */
describe('profiles can actually be created and listed', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-prof-home-');
    code = await makeTempDir('pb-prof-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('creates the profile that was asked for, not "personal"', async () => {
    // `pb init --profile work` created a profile called "personal": the program
    // declared a global `--profile` AND the subcommand declared its own, and
    // the global one consumed the value wherever it appeared, leaving the
    // subcommand's copy on its default.
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'work' });
    expect(workspace.profile.name).toBe('work');
    expect(await listProfileNames(createPaths(home.path))).toEqual(['work']);
  });

  it('lists every profile', async () => {
    for (const name of ['personal', 'work', 'customer-a']) {
      await Workspace.initialize({ home: home.path, profileName: name });
    }
    expect(await listProfileNames(createPaths(home.path))).toEqual([
      'customer-a',
      'personal',
      'work',
    ]);
  });

  it('opens a profile that was created separately', async () => {
    await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await Workspace.initialize({ home: home.path, profileName: 'work' });

    const work = await Workspace.open({ home: home.path, profile: 'work' });
    expect(work.profile.name).toBe('work');
  });

  it('changing the default profile changes which one opens', async () => {
    const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await Workspace.initialize({ home: home.path, profileName: 'work' });

    await personal.saveConfig({ ...personal.config, default_profile: 'work' });

    const reopened = await Workspace.open({ home: home.path });
    expect(reopened.profile.name).toBe('work');
  });

  it('an environment variable still beats the configured default', async () => {
    const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await Workspace.initialize({ home: home.path, profileName: 'work' });
    await personal.saveConfig({ ...personal.config, default_profile: 'work' });

    const reopened = await Workspace.open({
      home: home.path,
      env: { ...process.env, PROJECT_BRAIN_PROFILE: 'personal' },
    });
    expect(reopened.profile.name).toBe('personal');
  });

  it('a profile created later is still isolated from the first', async () => {
    const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await makeFakeRepo(join(code.path, 'hobby'), { remote: 'git@github.com:me/hobby.git' });
    await new Registry(personal.store).register(join(code.path, 'hobby'), {
      machineId: personal.machineId,
    });

    const work = await Workspace.initialize({ home: home.path, profileName: 'work' });
    expect(await new Registry(work.store).all()).toHaveLength(0);
    expect(await new Registry(personal.store).all()).toHaveLength(1);
  });
});

describe('the resume brief answers "what was this about"', () => {
  let home: TempDir;
  let code: TempDir;
  let workspace: Workspace;

  beforeEach(async () => {
    home = await makeTempDir('pb-ux-home-');
    code = await makeTempDir('pb-ux-code-');
    workspace = await Workspace.initialize({ home: home.path });
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function project(name = 'app') {
    await makeFakeRepo(join(code.path, name), { remote: `git@github.com:acme/${name}.git` });
    const result = await new Registry(workspace.store).register(join(code.path, name), {
      machineId: workspace.machineId,
    });
    return result.project;
  }

  it('surfaces the last checkpoint summary when no focus is set', async () => {
    // The brief previously listed five things completed and four things next
    // while never saying what the work was about - the sentence existed, but
    // only behind `--full`.
    const target = await project();
    await createCheckpoint(
      workspace.store,
      target,
      {
        summary: 'Hardened for release: closed a secret leak and fixed checkpoint scaling.',
        completed: ['write guard', 'migration framework'],
      },
      { machineId: workspace.machineId, source: 'cli' },
    );

    const brief = await buildResumeBrief(workspace.store, target, {
      machineId: workspace.machineId,
    });

    expect(brief.currentFocus).toBeNull();
    expect(brief.lastSummary).toBe(
      'Hardened for release: closed a secret leak and fixed checkpoint scaling.',
    );
    expect(renderSessionContext(brief, {})).toContain('Last session');
    expect(renderSessionContext(brief, {})).toContain('Hardened for release');
  });

  it('prefers an explicit focus over the checkpoint summary', async () => {
    const target = await project();
    await createCheckpoint(
      workspace.store,
      target,
      { summary: 'a checkpoint summary' },
      { machineId: workspace.machineId, source: 'cli' },
    );
    await new Registry(workspace.store).save({
      ...target,
      current_focus: 'an explicit current focus',
    });

    const reloaded = (await new Registry(workspace.store).byId(target.id))!;
    const brief = await buildResumeBrief(workspace.store, reloaded, {
      machineId: workspace.machineId,
    });

    expect(brief.currentFocus).toBe('an explicit current focus');
    const context = renderSessionContext(brief, {});
    expect(context).toContain('an explicit current focus');
    // Not both - one statement of what is happening, not two.
    expect(context).not.toContain('Last session');
  });

  it('is null when there is genuinely nothing to say', async () => {
    const target = await project();
    const brief = await buildResumeBrief(workspace.store, target, {
      machineId: workspace.machineId,
    });
    expect(brief.lastSummary).toBeNull();
    expect(brief.currentFocus).toBeNull();
  });
});

describe('next actions are ordered by urgency, not insertion', () => {
  let home: TempDir;
  let code: TempDir;
  let workspace: Workspace;

  beforeEach(async () => {
    home = await makeTempDir('pb-order-home-');
    code = await makeTempDir('pb-order-code-');
    workspace = await Workspace.initialize({ home: home.path });
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('puts the most recent statement of intent first', async () => {
    // Dogfooding surfaced this: aspirational tasks added weeks earlier were
    // listed above the actual next step, because open tasks came first and in
    // insertion order. A person reads top-down.
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await new Registry(workspace.store).register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    await workspace.store.writeTasks({
      schema_version: 1,
      project_id: project.id,
      tasks: [
        TaskSchema.parse({
          id: 't_old',
          text: 'someday: add a second adapter',
          status: 'todo',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }),
        TaskSchema.parse({
          id: 't_new',
          text: 'recently added task',
          status: 'todo',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-01T00:00:00Z',
        }),
      ],
    });

    await createCheckpoint(
      workspace.store,
      project,
      { summary: 'stopped here', next: ['decide the package name', 'run the release check'] },
      { machineId: workspace.machineId, source: 'cli', timestamp: '2026-09-18T10:00:00Z' },
    );

    const brief = await buildResumeBrief(workspace.store, project, {
      machineId: workspace.machineId,
    });

    expect(brief.nextActions[0]).toBe('decide the package name');
    expect(brief.nextActions[1]).toBe('run the release check');
    // Newer task before the older one.
    expect(brief.nextActions.indexOf('recently added task')).toBeLessThan(
      brief.nextActions.indexOf('someday: add a second adapter'),
    );
  });

  it('excludes blocked tasks from next actions and lists them as blockers', async () => {
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await new Registry(workspace.store).register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    await workspace.store.writeTasks({
      schema_version: 1,
      project_id: project.id,
      tasks: [
        TaskSchema.parse({
          id: 't_blocked',
          text: 'publish the package',
          status: 'blocked',
          blocked_reason: 'owner undecided',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-01T00:00:00Z',
        }),
        TaskSchema.parse({
          id: 't_open',
          text: 'write the changelog',
          status: 'todo',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-01T00:00:00Z',
        }),
      ],
    });

    const brief = await buildResumeBrief(workspace.store, project, {
      machineId: workspace.machineId,
    });

    expect(brief.nextActions).toContain('write the changelog');
    expect(brief.nextActions).not.toContain('publish the package');
    expect(brief.blockers).toContain('publish the package');
  });

  it('does not repeat the same item in both lists', async () => {
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await new Registry(workspace.store).register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    await workspace.store.writeTasks({
      schema_version: 1,
      project_id: project.id,
      tasks: [
        TaskSchema.parse({
          id: 't1',
          text: 'fix the refinery logic',
          status: 'todo',
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-01T00:00:00Z',
        }),
      ],
    });
    await createCheckpoint(
      workspace.store,
      project,
      { summary: 'stopped', next: ['fix the refinery logic'] },
      { machineId: workspace.machineId, source: 'cli' },
    );

    const brief = await buildResumeBrief(workspace.store, project, {
      machineId: workspace.machineId,
    });
    const occurrences = brief.nextActions.filter((item) => item === 'fix the refinery logic');
    expect(occurrences).toHaveLength(1);
  });
});
