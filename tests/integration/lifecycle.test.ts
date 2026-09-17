import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { buildRecent, buildResumeBrief, renderSessionContext } from '../../src/core/context.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { scanForProjects } from '../../src/discovery/scanner.js';
import { search } from '../../src/search/search.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * The end-to-end journey the brief defines as the MVP: set up, discover
 * projects, record what happened, and be able to pick any of it back up.
 *
 * Every test here runs against a real temporary home directory. Nothing is
 * mocked, because the failure modes worth catching in this layer - a path
 * built wrong, a file written where nothing reads it - are precisely the ones
 * a mock would hide.
 */
describe('project lifecycle', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-home-');
    code = await makeTempDir('pb-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function setup() {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    return { workspace, registry: new Registry(workspace.store) };
  }

  it('initialises a usable home', async () => {
    const { workspace } = await setup();

    expect(workspace.profile.name).toBe('personal');
    expect(workspace.machineId).toMatch(/^machine_/);
    await expect(readFile(join(home.path, 'config.yaml'), 'utf8')).resolves.toContain(
      'schema_version',
    );
    // The machine identity lives outside every profile so sync cannot reach it.
    await expect(readFile(join(home.path, 'machine.json'), 'utf8')).resolves.toContain('machine_id');
  });

  it('gives the same machine the same id on a second run', async () => {
    const first = await setup();
    const second = await Workspace.open({ home: home.path });
    expect(second.machineId).toBe(first.workspace.machineId);
  });

  it('discovers repositories and registers them', async () => {
    const { workspace, registry } = await setup();

    await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
    await makeFakeRepo(join(code.path, 'gadget'), { remote: 'https://github.com/acme/gadget.git' });
    await makeFakeRepo(join(code.path, 'local-only'), {});

    const scan = await scanForProjects([code.path]);
    expect(scan.candidates).toHaveLength(3);

    for (const candidate of scan.candidates) {
      await registry.register(candidate.path, { machineId: workspace.machineId });
    }

    const projects = await registry.all();
    expect(projects.map((project) => project.name).sort()).toEqual([
      'gadget',
      'local-only',
      'widget',
    ]);
  });

  it('does not descend into a repository once it finds one', async () => {
    await makeFakeRepo(join(code.path, 'outer'), { remote: 'git@github.com:acme/outer.git' });
    await makeFakeRepo(join(code.path, 'outer', 'vendored'), {
      remote: 'git@github.com:other/vendored.git',
    });

    const scan = await scanForProjects([code.path]);
    expect(scan.candidates.map((candidate) => candidate.path)).toEqual([join(code.path, 'outer')]);
  });

  it('skips node_modules even when it contains repositories', async () => {
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    await makeFakeRepo(join(code.path, 'node_modules', 'dep'), {
      remote: 'git@github.com:npm/dep.git',
    });

    const scan = await scanForProjects([code.path]);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]?.path).toBe(join(code.path, 'app'));
  });

  describe('identity across machines', () => {
    it('derives the same project id from the same remote', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
      const first = await registry.register(join(code.path, 'widget'), {
        machineId: workspace.machineId,
      });

      // A second machine, a different path, the same repository.
      const otherHome = await makeTempDir('pb-home2-');
      const otherCode = await makeTempDir('pb-code2-');
      try {
        const otherWorkspace = await Workspace.initialize({ home: otherHome.path });
        const otherRegistry = new Registry(otherWorkspace.store);
        await makeFakeRepo(join(otherCode.path, 'checkout-elsewhere'), {
          remote: 'https://github.com/Acme/Widget.git',
        });
        const second = await otherRegistry.register(join(otherCode.path, 'checkout-elsewhere'), {
          machineId: otherWorkspace.machineId,
        });

        expect(second.project.id).toBe(first.project.id);
        expect(second.project.repository?.identity).toBe('github.com/acme/widget');
      } finally {
        await otherHome.cleanup();
        await otherCode.cleanup();
      }
    });

    it('merges a second machine into one project with two locations', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
      await registry.register(join(code.path, 'widget'), { machineId: workspace.machineId });

      // The other machine's record, as it would arrive through a synced repo.
      await makeFakeRepo(join(code.path, 'widget-elsewhere'), {
        remote: 'git@github.com:acme/widget.git',
      });
      const result = await registry.register(join(code.path, 'widget-elsewhere'), {
        machineId: 'machine_workstation',
      });

      expect(result.outcome).toBe('location-added');
      expect((await registry.all())).toHaveLength(1);
      expect(result.project.local_locations).toHaveLength(2);
      expect(result.project.local_locations.map((l) => l.machine_id).sort()).toEqual(
        [workspace.machineId, 'machine_workstation'].sort(),
      );
    });

    it('keeps repositories without a remote separate', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'one'), {});
      await makeFakeRepo(join(code.path, 'two'), {});

      const first = await registry.register(join(code.path, 'one'), {
        machineId: workspace.machineId,
      });
      const second = await registry.register(join(code.path, 'two'), {
        machineId: workspace.machineId,
      });

      expect(first.project.id).not.toBe(second.project.id);
      expect(first.project.repository).toBeNull();
    });

    it('re-registering the same directory does not create a duplicate', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });

      await registry.register(join(code.path, 'widget'), { machineId: workspace.machineId });
      const again = await registry.register(join(code.path, 'widget'), {
        machineId: workspace.machineId,
      });

      expect(again.outcome).toBe('location-updated');
      expect(await registry.all()).toHaveLength(1);
    });
  });

  describe('checkpoints and resuming', () => {
    it('records a checkpoint and reads it back in a resume brief', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'rts'), { remote: 'git@github.com:emin/world-war.git' });
      const { project } = await registry.register(join(code.path, 'rts'), {
        machineId: workspace.machineId,
      });

      await createCheckpoint(
        workspace.store,
        project,
        {
          summary: 'Replaced the mandatory match timer with unlimited matches.',
          completed: ['unlimited match duration', 'pause for AI matches'],
          blockers: ['AI cannot rebuild a destroyed refinery'],
          next: ['fix the refinery rebuild logic'],
        },
        { machineId: workspace.machineId, source: 'cli' },
      );

      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
      });

      expect(brief.recentlyCompleted).toContain('unlimited match duration');
      expect(brief.blockers).toContain('AI cannot rebuild a destroyed refinery');
      expect(brief.nextActions).toContain('fix the refinery rebuild logic');
      expect(brief.hereLocation?.path).toBe(join(code.path, 'rts'));
    });

    it('stores each checkpoint as its own dated file', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });

      const one = await createCheckpoint(
        workspace.store,
        project,
        { summary: 'first' },
        { machineId: workspace.machineId, source: 'cli', timestamp: '2026-09-17T10:00:00Z' },
      );
      const two = await createCheckpoint(
        workspace.store,
        project,
        { summary: 'second' },
        { machineId: workspace.machineId, source: 'cli', timestamp: '2026-09-18T11:30:00Z' },
      );

      expect(one.filePath).toContain(join('2026', '09', '17'));
      expect(two.filePath).toContain(join('2026', '09', '18'));
      expect(one.filePath).not.toBe(two.filePath);

      const checkpoints = await workspace.store.listCheckpoints(project.id);
      expect(checkpoints).toHaveLength(2);
      // Newest first.
      expect(checkpoints[0]?.summary).toBe('second');
    });

    it('keeps the session-start brief small', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });

      // Far more history than a session brief should ever include.
      for (let index = 0; index < 40; index++) {
        await createCheckpoint(
          workspace.store,
          project,
          {
            summary: `Checkpoint ${index}: `.padEnd(400, 'detail about the work that was done. '),
            completed: Array.from({ length: 10 }, (_, n) => `completed item ${index}-${n}`),
            next: Array.from({ length: 10 }, (_, n) => `next item ${index}-${n}`),
          },
          {
            machineId: workspace.machineId,
            source: 'cli',
            timestamp: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T10:00:00Z`,
          },
        );
      }

      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
        checkpointLimit: 3,
      });
      const context = renderSessionContext(brief, { machineName: 'test-machine' });

      expect(context.length).toBeLessThanOrEqual(4_000);
      expect(context).toContain('Project: app');
    });
  });

  describe('recent activity', () => {
    it('orders projects by when they were last touched', async () => {
      const { workspace, registry } = await setup();

      for (const [name, day] of [
        ['oldest', '01'],
        ['newest', '20'],
        ['middle', '10'],
      ] as const) {
        await makeFakeRepo(join(code.path, name), { remote: `git@github.com:acme/${name}.git` });
        const { project } = await registry.register(join(code.path, name), {
          machineId: workspace.machineId,
        });
        await createCheckpoint(
          workspace.store,
          project,
          { summary: `work on ${name}` },
          {
            machineId: workspace.machineId,
            source: 'cli',
            timestamp: `2026-09-${day}T10:00:00Z`,
          },
        );
      }

      const entries = await buildRecent(workspace.store, await registry.all());
      expect(entries.map((entry) => entry.project.name)).toEqual(['newest', 'middle', 'oldest']);
      expect(entries[0]?.summary).toBe('work on newest');
    });
  });

  describe('search', () => {
    it('finds a phrase recorded in a checkpoint months earlier', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'rts'), { remote: 'git@github.com:emin/rts.git' });
      const { project } = await registry.register(join(code.path, 'rts'), {
        machineId: workspace.machineId,
      });

      await createCheckpoint(
        workspace.store,
        project,
        { summary: 'Economy pass', completed: ['refinery income correction'] },
        { machineId: workspace.machineId, source: 'cli', timestamp: '2026-03-02T09:00:00Z' },
      );

      const hits = await search(workspace.store, await registry.all(), 'refinery');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => hit.excerpt.includes('refinery income correction'))).toBe(true);
    });

    it('requires every term to match', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });
      await createCheckpoint(
        workspace.store,
        project,
        { summary: 'Fixed the refinery logic' },
        { machineId: workspace.machineId, source: 'cli' },
      );

      expect(await search(workspace.store, await registry.all(), 'refinery logic')).not.toHaveLength(
        0,
      );
      expect(
        await search(workspace.store, await registry.all(), 'refinery submarine'),
      ).toHaveLength(0);
    });
  });

  describe('corruption resilience', () => {
    it('keeps working when one project file is unreadable', async () => {
      const { workspace, registry } = await setup();

      for (const name of ['good-one', 'good-two', 'broken']) {
        await makeFakeRepo(join(code.path, name), { remote: `git@github.com:acme/${name}.git` });
        await registry.register(join(code.path, name), { machineId: workspace.machineId });
      }

      const broken = (await registry.all()).find((project) => project.name === 'broken')!;
      await writeFile(
        workspace.profilePaths.projectFile(broken.id),
        'this: is: not: valid: yaml: [\n',
      );

      const reopened = await Workspace.open({ home: home.path });
      const projects = await new Registry(reopened.store).all();

      expect(projects.map((project) => project.name).sort()).toEqual(['good-one', 'good-two']);
      expect(reopened.store.getIssues()).toHaveLength(1);
      expect(reopened.store.getIssues()[0]?.reason).toMatch(/yaml|schema/i);
    });

    it('never deletes a file it could not parse', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });

      const file = workspace.profilePaths.projectFile(project.id);
      await writeFile(file, 'broken: [');

      const reopened = await Workspace.open({ home: home.path });
      await new Registry(reopened.store).all();

      await expect(readFile(file, 'utf8')).resolves.toBe('broken: [');
    });

    it('survives a checkpoint with unreadable frontmatter', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });

      const good = await createCheckpoint(
        workspace.store,
        project,
        { summary: 'a real checkpoint' },
        { machineId: workspace.machineId, source: 'cli', timestamp: '2026-09-17T10:00:00Z' },
      );
      await writeFile(
        good.filePath.replace(/\d{6}_cp_\w+\.md$/, '120000_cp_broken.md'),
        '---\nnot: [valid\n---\n\nbody\n',
      );

      const checkpoints = await workspace.store.listCheckpoints(project.id);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.summary).toBe('a real checkpoint');
      expect(workspace.store.getIssues().length).toBeGreaterThan(0);
    });

    it('rebuilds after the cache directory is deleted', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      await registry.register(join(code.path, 'app'), { machineId: workspace.machineId });

      // The cache is explicitly disposable; losing it must lose nothing real.
      await rm(workspace.paths.cacheDir, { recursive: true, force: true });

      const reopened = await Workspace.open({ home: home.path });
      expect(await new Registry(reopened.store).all()).toHaveLength(1);
    });
  });
});

/**
 * Symlinked paths.
 *
 * Found in real use: on macOS `/tmp` is a symlink to `/private/tmp`, so the CLI
 * invoked from one and a Claude Code hook invoked from the other registered the
 * same working tree twice on the same machine. `pb resume` then showed the
 * project as if it existed on two computers.
 */
describe('a directory reached through a symlink is one location', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-link-home-');
    code = await makeTempDir('pb-link-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('does not create a second location for the same directory', async () => {
    const { symlink } = await import('node:fs/promises');
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);

    const real = join(code.path, 'real', 'widget');
    await makeFakeRepo(real, { remote: 'git@github.com:acme/widget.git' });

    const linked = join(code.path, 'linked');
    await symlink(join(code.path, 'real'), linked, 'dir');

    const first = await registry.register(real, { machineId: workspace.machineId });
    const second = await registry.register(join(linked, 'widget'), {
      machineId: workspace.machineId,
    });

    expect(second.outcome).toBe('location-updated');
    expect(second.project.id).toBe(first.project.id);
    expect(second.project.local_locations).toHaveLength(1);
  });

  it('identifies a project through a symlinked path', async () => {
    const { symlink } = await import('node:fs/promises');
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);

    // A repository with no remote, so identification must fall back to path.
    const real = join(code.path, 'real', 'scratch');
    await makeFakeRepo(real, {});
    await registry.register(real, { machineId: workspace.machineId });

    const linked = join(code.path, 'via-link');
    await symlink(join(code.path, 'real'), linked, 'dir');

    const found = await registry.identify(join(linked, 'scratch'), workspace.machineId);
    expect(found.project?.name).toBe('scratch');
  });
});
