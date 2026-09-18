import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.js';
import { Registry, hasLocationOnAnotherMachine, upsertLocation } from '../../src/core/registry.js';
import { projectLabels, projectQualifier } from '../../src/core/resolve.js';
import { scanForProjects } from '../../src/discovery/scanner.js';
import { Store } from '../../src/storage/store.js';
import { isBrainError } from '../../src/util/errors.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Behaviour reported from the first real-world use of v0.1.0.
 *
 * Three observations from one `statenest scan ~/Documents`: a message claiming
 * projects were "already known from another machine" on a machine that had
 * never synced, a project count that did not match the number reported as
 * created, and two rows in the listing both reading `threads`.
 */
describe('dogfood: a second copy on the same machine is not another machine', () => {
  let home: TempDir;
  let code: TempDir;
  let workspace: Workspace;
  let registry: Registry;

  beforeEach(async () => {
    home = await makeTempDir('sn-dogfood-home-');
    code = await makeTempDir('sn-dogfood-code-');
    workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    registry = new Registry(workspace.store);
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('reports location-added for a second clone on this machine', async () => {
    await makeFakeRepo(join(code.path, 'one'), { remote: 'git@github.com:acme/one.git' });
    await makeFakeRepo(join(code.path, 'copies', 'one'), { remote: 'git@github.com:acme/one.git' });

    const first = await registry.register(join(code.path, 'one'), {
      machineId: workspace.machineId,
    });
    const second = await registry.register(join(code.path, 'copies', 'one'), {
      machineId: workspace.machineId,
    });

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('location-added');

    // The outcome alone is what the old message read as "another machine".
    // It is not: both copies are here.
    expect(hasLocationOnAnotherMachine(second.project, workspace.machineId)).toBe(false);
    expect(second.project.local_locations).toHaveLength(2);
    expect(
      second.project.local_locations.every(
        (location) => location.machine_id === workspace.machineId,
      ),
    ).toBe(true);
  });

  it('still recognises a location that genuinely belongs to another machine', async () => {
    await makeFakeRepo(join(code.path, 'two'), { remote: 'git@github.com:acme/two.git' });
    const { project } = await registry.register(join(code.path, 'two'), {
      machineId: workspace.machineId,
    });

    const elsewhere = upsertLocation(project, {
      ...project.local_locations[0]!,
      machine_id: 'machine_someone_else',
      path: '/home/other/two',
    });

    expect(hasLocationOnAnotherMachine(elsewhere, workspace.machineId)).toBe(true);
    // ...and the copy on this machine is still there.
    expect(hasLocationOnAnotherMachine(project, workspace.machineId)).toBe(false);
  });
});

describe('dogfood: the project count matches what scan reported creating', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('sn-count-home-');
    code = await makeTempDir('sn-count-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('stores exactly as many projects as it says it created', async () => {
    // Deliberately awkward: two clones of one repository, two unrelated
    // repositories sharing a name, and repositories with no remote at all -
    // the shapes that make `created` and the stored total diverge if
    // registration is not careful.
    await makeFakeRepo(join(code.path, 'alpha'), { remote: 'git@github.com:acme/alpha.git' });
    await makeFakeRepo(join(code.path, 'beta'), { remote: 'git@github.com:acme/beta.git' });
    await makeFakeRepo(join(code.path, 'gamma'), { remote: 'git@github.com:acme/gamma.git' });
    await makeFakeRepo(join(code.path, 'copies', 'gamma'), {
      remote: 'git@github.com:acme/gamma.git',
    });
    await makeFakeRepo(join(code.path, 'work', 'threads'), {
      remote: 'git@github.com:acme/threads.git',
    });
    await makeFakeRepo(join(code.path, 'personal', 'threads'), {
      remote: 'git@github.com:someone/threads.git',
    });
    await makeFakeRepo(join(code.path, 'local-a'), {});
    await makeFakeRepo(join(code.path, 'local-b'), {});

    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const registry = new Registry(workspace.store);

    const before = (await new Store(workspace.store.paths).listProjects()).length;
    expect(before).toBe(0);

    const scan = await scanForProjects([code.path], { maxDepth: 8, exclude: [] });
    let created = 0;
    let locationAdded = 0;
    let locationUpdated = 0;
    for (const candidate of scan.candidates) {
      const result = await registry.register(candidate.path, { machineId: workspace.machineId });
      if (result.outcome === 'created') created += 1;
      else if (result.outcome === 'location-added') locationAdded += 1;
      else locationUpdated += 1;
    }

    // Read from disk with a fresh store, the way a separate `statenest
    // projects` process does - an in-memory count could agree while the files
    // disagreed.
    const after = (await new Store(workspace.store.paths).listProjects()).length;

    expect(created).toBeGreaterThan(0);
    expect(locationAdded).toBeGreaterThan(0);
    expect(before + created).toBe(after);
    // Every candidate is accounted for in exactly one bucket.
    expect(created + locationAdded + locationUpdated).toBe(scan.candidates.length);
  });

  it('does not create a second record when the same path is scanned twice', async () => {
    await makeFakeRepo(join(code.path, 'solo'), { remote: 'git@github.com:acme/solo.git' });
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const registry = new Registry(workspace.store);

    const first = await registry.register(join(code.path, 'solo'), {
      machineId: workspace.machineId,
    });
    const again = await registry.register(join(code.path, 'solo'), {
      machineId: workspace.machineId,
    });

    expect(first.outcome).toBe('created');
    expect(again.outcome).toBe('location-updated');
    expect((await new Store(workspace.store.paths).listProjects())).toHaveLength(1);
  });
});

describe('dogfood: two different repositories may share a name', () => {
  let home: TempDir;
  let code: TempDir;
  let workspace: Workspace;
  let registry: Registry;

  beforeEach(async () => {
    home = await makeTempDir('sn-threads-home-');
    code = await makeTempDir('sn-threads-code-');
    workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    registry = new Registry(workspace.store);

    await makeFakeRepo(join(code.path, 'work', 'threads'), {
      remote: 'git@github.com:work-org/threads.git',
    });
    await makeFakeRepo(join(code.path, 'personal', 'threads'), {
      remote: 'git@github.com:personal-org/threads.git',
    });
    await registry.register(join(code.path, 'work', 'threads'), {
      machineId: workspace.machineId,
    });
    await registry.register(join(code.path, 'personal', 'threads'), {
      machineId: workspace.machineId,
    });
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('never merges them, however identical the names', async () => {
    const projects = await registry.all();
    expect(projects).toHaveLength(2);
    expect(projects.map((project) => project.name)).toEqual(['threads', 'threads']);

    // Distinct ids, distinct identities. Identity comes from the remote, and a
    // shared display name is not evidence of a shared repository.
    const ids = new Set(projects.map((project) => project.id));
    expect(ids.size).toBe(2);
    const identities = new Set(projects.map((project) => project.repository?.identity));
    expect(identities).toEqual(
      new Set(['github.com/work-org/threads', 'github.com/personal-org/threads']),
    );
  });

  it('qualifies colliding names in a listing, and leaves unique ones alone', async () => {
    await makeFakeRepo(join(code.path, 'unique'), { remote: 'git@github.com:acme/unique.git' });
    await registry.register(join(code.path, 'unique'), { machineId: workspace.machineId });

    const projects = await registry.all();
    const labels = projectLabels(projects);

    const qualified = projects
      .filter((project) => project.name === 'threads')
      .map((project) => labels.get(project.id));
    expect(qualified).toContain('threads (work-org/threads)');
    expect(qualified).toContain('threads (personal-org/threads)');

    const unique = projects.find((project) => project.name === 'unique')!;
    expect(labels.get(unique.id)).toBe('unique');
  });

  it('gives an actionable error instead of two identical lines', async () => {
    const error = await registry.resolveOrThrow('threads').catch((caught: unknown) => caught);
    expect(isBrainError(error)).toBe(true);
    if (!isBrainError(error)) return;

    expect(error.code).toBe('AMBIGUOUS_PROJECT');
    // The old message listed "1. threads" and "2. threads" and suggested a
    // more specific name, which is impossible when the names are identical.
    expect(error.details.join('\n')).toContain('work-org/threads');
    expect(error.details.join('\n')).toContain('personal-org/threads');
    expect(error.hints.join('\n')).not.toContain('Use a longer or more specific name');
    expect(error.hints.join('\n')).toContain('work-org/threads');
  });

  it('resolves cleanly by the qualifier it suggests', async () => {
    const projects = await registry.all();
    for (const project of projects) {
      const qualifier = projectQualifier(project);
      const resolved = await registry.resolveOrThrow(qualifier);
      expect(resolved.id).toBe(project.id);
    }
  });

  it('still reports ambiguity rather than guessing', async () => {
    // The point of qualifying is to help the user choose, never to choose for
    // them.
    await expect(registry.resolveOrThrow('threads')).rejects.toThrow('matches more than one');
  });
});
