import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.js';
import { Registry, projectIdForRemote, reconcileRepository } from '../../src/core/registry.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { normalizeRemoteUrl, remoteIdentity, sameRepository } from '../../src/git/remote-url.js';
import { readRepoFast } from '../../src/git/repo.js';
import { makeFakeRepo, makeRealRepo, makeTempDir, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();

/**
 * Project identity under adversarial conditions.
 *
 * Identity is the single most consequential thing this tool computes. Get it
 * wrong in one direction and one project appears as two on every machine; get
 * it wrong in the other and two unrelated repositories silently merge, taking
 * each other's history with them.
 */
describe('git remote identity', () => {
  /**
   * Forms that MUST resolve to one identity, and forms that must not.
   *
   * Grouped rather than listed flat so a new host can be added as a row and
   * every cross-comparison comes for free.
   */
  const EQUIVALENCE_GROUPS: { identity: string; forms: string[] }[] = [
    {
      identity: 'github.com/acme/widget',
      forms: [
        'git@github.com:acme/widget.git',
        'git@github.com:acme/widget',
        'https://github.com/acme/widget.git',
        'https://github.com/acme/widget',
        'https://github.com/acme/widget/',
        'https://www.github.com/acme/widget.git',
        'ssh://git@github.com/acme/widget.git',
        'ssh://git@github.com:22/acme/widget.git',
        'ssh://git@github.com:2222/acme/widget.git',
        'git://github.com/acme/widget.git',
        'git+ssh://git@github.com/acme/widget.git',
        'GIT@GitHub.COM:Acme/Widget.git',
        'https://github.com/ACME/WIDGET',
        'https://github.com./acme/widget.git',
        'https://github.com//acme//widget.git',
        '  https://github.com/acme/widget.git  ',
        'git@ssh.github.com:acme/widget.git',
      ],
    },
    {
      identity: 'gitlab.com/group/subgroup/project',
      forms: [
        'git@gitlab.com:group/subgroup/project.git',
        'https://gitlab.com/group/subgroup/project.git',
        'ssh://git@altssh.gitlab.com:443/group/subgroup/project.git',
      ],
    },
    {
      identity: 'bitbucket.org/team/repo',
      forms: [
        'git@bitbucket.org:team/repo.git',
        'https://user@bitbucket.org/team/repo.git',
        'ssh://git@altssh.bitbucket.org:443/team/repo.git',
      ],
    },
    {
      identity: 'dev.azure.com/contoso/buildsystem/widget',
      forms: [
        'git@ssh.dev.azure.com:v3/contoso/BuildSystem/widget',
        'https://dev.azure.com/contoso/BuildSystem/_git/widget',
        'https://contoso@dev.azure.com/contoso/BuildSystem/_git/widget',
      ],
    },
    {
      identity: 'git.internal.example.com/team/service',
      forms: [
        'git@git.internal.example.com:team/service.git',
        'https://git.internal.example.com/team/service.git',
        'ssh://git@git.internal.example.com:2222/team/service.git',
        'ssh://git@git.internal.example.com:7999/team/service',
      ],
    },
    {
      identity: 'bitbucket.internal.example.com/proj/repo',
      forms: [
        'https://bitbucket.internal.example.com/scm/proj/repo.git',
        'ssh://git@bitbucket.internal.example.com:7999/proj/repo.git',
      ],
    },
    {
      identity: 'codeberg.org/user/thing',
      forms: ['git@codeberg.org:user/thing.git', 'https://codeberg.org/user/thing'],
    },
  ];

  describe('equivalent forms collapse to one identity', () => {
    for (const group of EQUIVALENCE_GROUPS) {
      describe(group.identity, () => {
        it.each(group.forms)('%s', (form) => {
          expect(remoteIdentity(form)).toBe(group.identity);
        });

        it('every form derives the same project id', () => {
          const ids = new Set(group.forms.map((form) => projectIdForRemote(form)));
          expect(ids.size, [...ids].join(', ')).toBe(1);
          expect([...ids][0]).toMatch(/^prj_/);
        });
      });
    }
  });

  it('never merges two different repositories', () => {
    const identities = EQUIVALENCE_GROUPS.map((group) => group.identity);
    expect(new Set(identities).size).toBe(identities.length);

    // Every cross-group pair must stay distinct.
    for (const a of EQUIVALENCE_GROUPS) {
      for (const b of EQUIVALENCE_GROUPS) {
        if (a === b) continue;
        expect(sameRepository(a.forms[0]!, b.forms[0]!), `${a.identity} vs ${b.identity}`).toBe(false);
      }
    }
  });

  describe('lookalike repositories stay distinct', () => {
    it.each([
      ['git@github.com:acme/widget.git', 'git@github.com:acme/widgets.git'],
      ['git@github.com:acme/widget.git', 'git@github.com:acme2/widget.git'],
      ['git@github.com:acme/widget.git', 'git@gitlab.com:acme/widget.git'],
      ['git@github.com:acme/widget.git', 'git@github.com:acme/widget-2.git'],
      ['git@gitlab.com:group/sub/proj.git', 'git@gitlab.com:group/proj.git'],
      ['git@github.com:a/b.git', 'git@github.com:a/b/c.git'],
    ])('%s is not %s', (left, right) => {
      expect(sameRepository(left, right)).toBe(false);
    });
  });

  describe('credentials never reach stored data', () => {
    const SECRETS = [
      ['https://ghp_Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye@github.com/acme/widget.git', 'ghp_Kq7n0treal'],
      ['https://x-access-token:ghp_Kq7n0trealZx92Mw4@github.com/acme/widget.git', 'ghp_Kq7n0treal'],
      ['https://oauth2:glpat-Kq7n0trealZx92Mw4@gitlab.com/acme/widget.git', 'glpat-Kq7n0treal'],
      ['https://alice:hunter2@github.com/acme/widget.git', 'hunter2'],
      ['git:hunter2@github.com:acme/widget.git', 'hunter2'],
      ['ssh://alice:hunter2@git.example.com:2222/acme/widget.git', 'hunter2'],
    ] as const;

    it.each(SECRETS)('%s strips the credential', (url, secret) => {
      const normalized = normalizeRemoteUrl(url);
      expect(normalized).not.toBeNull();
      expect(JSON.stringify(normalized), 'the whole result object').not.toContain(secret);
      expect(normalized!.sanitized).not.toContain(secret);
      expect(normalized!.identity).not.toContain(secret);
    });

    it('still identifies the repository correctly after stripping', () => {
      expect(remoteIdentity(SECRETS[0][0])).toBe('github.com/acme/widget');
      expect(remoteIdentity(SECRETS[3][0])).toBe('github.com/acme/widget');
    });

    it('a token-bearing remote reaches no stored field', async () => {
      const home = await makeTempDir('pb-ident-home-');
      const code = await makeTempDir('pb-ident-code-');
      try {
        const workspace = await Workspace.initialize({ home: home.path });
        const registry = new Registry(workspace.store);
        const token = 'ghp_Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye';

        await makeFakeRepo(join(code.path, 'widget'), {
          remote: `https://x-access-token:${token}@github.com/acme/widget.git`,
        });
        await registry.register(join(code.path, 'widget'), { machineId: workspace.machineId });

        const { readFile, readdir } = await import('node:fs/promises');
        let contents = '';
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else contents += await readFile(path, 'utf8').catch(() => '');
          }
        };
        await walk(workspace.paths.home);

        expect(contents).not.toContain(token);
        expect(contents).not.toContain('x-access-token');
        expect(contents).toContain('github.com/acme/widget');
      } finally {
        await home.cleanup();
        await code.cleanup();
      }
    });
  });

  describe('remotes that are not stable identity', () => {
    it.each(['/srv/git/widget.git', 'file:///srv/git/widget.git', '../sibling', 'C:\\repos\\widget'])(
      '%s is marked unstable across machines',
      (url) => {
        expect(normalizeRemoteUrl(url)?.stableAcrossMachines).toBe(false);
      },
    );

    it('produces no derived project id for a local remote', () => {
      expect(projectIdForRemote('/srv/git/widget.git')).toBeNull();
    });
  });

  describe('multiple remotes', () => {
    it('prefers origin for identity', async () => {
      const code = await makeTempDir('pb-multi-');
      try {
        await makeFakeRepo(join(code.path, 'fork'), {
          remote: 'git@github.com:me/fork.git',
          extraRemotes: { upstream: 'git@github.com:original/project.git' },
        });
        const repo = await readRepoFast(join(code.path, 'fork'));
        expect(repo?.primaryRemote?.identity).toBe('github.com/me/fork');
        expect(repo?.remotes.size).toBe(2);
      } finally {
        await code.cleanup();
      }
    });

    it('falls back to the only remote when there is no origin', async () => {
      const code = await makeTempDir('pb-multi2-');
      try {
        await makeFakeRepo(join(code.path, 'odd'), {
          remote: 'git@github.com:acme/odd.git',
          remoteName: 'upstream',
        });
        const repo = await readRepoFast(join(code.path, 'odd'));
        expect(repo?.primaryRemote?.identity).toBe('github.com/acme/odd');
      } finally {
        await code.cleanup();
      }
    });
  });
});

describe('identity transitions', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-trans-home-');
    code = await makeTempDir('pb-trans-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function setup() {
    const workspace = await Workspace.initialize({ home: home.path });
    return { workspace, registry: new Registry(workspace.store) };
  }

  /**
   * The single most common lifecycle: start a project locally, push it to
   * GitHub later. This previously dropped the remote entirely, leaving the
   * project permanently unable to link across machines.
   */
  describe('a local-only project that later gains a remote', () => {
    it('records the repository', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'grows');
      await makeFakeRepo(path, {});
      await new Registry(workspace.store).register(path, { machineId: workspace.machineId });

      await makeFakeRepo(path, { remote: 'git@github.com:acme/grows.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      expect(after.identityChange).toBe('gained-remote');
      expect(after.project.repository?.identity).toBe('github.com/acme/grows');
    });

    it('adopts the derived id so it merges with the same repository elsewhere', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'grows');
      await makeFakeRepo(path, {});
      await new Registry(workspace.store).register(path, { machineId: workspace.machineId });

      await makeFakeRepo(path, { remote: 'git@github.com:acme/grows.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      expect(after.project.id).toBe(projectIdForRemote('git@github.com:acme/grows.git'));
    });

    it('preserves checkpoints written while it was local-only', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'grows');
      await makeFakeRepo(path, {});
      const before = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });
      await createCheckpoint(
        workspace.store,
        before.project,
        { summary: 'work done before there was a remote' },
        { machineId: workspace.machineId, source: 'cli' },
      );

      await makeFakeRepo(path, { remote: 'git@github.com:acme/grows.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      const checkpoints = await workspace.store.listCheckpoints(after.project.id);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.summary).toBe('work done before there was a remote');
    });

    it('leaves exactly one project, which a clone on another machine joins', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'grows');
      await makeFakeRepo(path, {});
      await new Registry(workspace.store).register(path, { machineId: workspace.machineId });
      await makeFakeRepo(path, { remote: 'git@github.com:acme/grows.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      // Another machine clones the same repository, by a different URL form.
      await makeFakeRepo(join(code.path, 'elsewhere'), {
        remote: 'https://github.com/Acme/Grows.git',
      });
      const joined = await new Registry(workspace.store).register(join(code.path, 'elsewhere'), {
        machineId: 'machine_other',
      });

      expect(joined.outcome).toBe('location-added');
      expect(joined.project.id).toBe(after.project.id);
      expect(await new Registry(workspace.store).all()).toHaveLength(1);
    });
  });

  /**
   * A transfer is the opposite case: the project may already be known to other
   * machines under its old identity, so re-identifying it would either
   * duplicate it or merge it with something unrelated.
   */
  describe('a repository transferred to a new owner', () => {
    it('keeps the project id', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'moved');
      await makeFakeRepo(path, { remote: 'git@github.com:ownerA/project.git' });
      const before = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      await makeFakeRepo(path, { remote: 'git@github.com:ownerB/project.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      expect(after.identityChange).toBe('remote-changed');
      expect(after.project.id).toBe(before.project.id);
    });

    it('records the new identity and remembers the old one', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'moved');
      await makeFakeRepo(path, { remote: 'git@github.com:ownerA/project.git' });
      await new Registry(workspace.store).register(path, { machineId: workspace.machineId });

      await makeFakeRepo(path, { remote: 'git@github.com:ownerB/project.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      expect(after.project.repository?.identity).toBe('github.com/ownerb/project');
      expect(after.project.repository?.previous_identities).toContain('github.com/ownera/project');
    });

    it('still resolves for a machine that has not updated its remote', async () => {
      const { workspace } = await setup();
      const path = join(code.path, 'moved');
      await makeFakeRepo(path, { remote: 'git@github.com:ownerA/project.git' });
      await new Registry(workspace.store).register(path, { machineId: workspace.machineId });
      await makeFakeRepo(path, { remote: 'git@github.com:ownerB/project.git' });
      const after = await new Registry(workspace.store).register(path, {
        machineId: workspace.machineId,
      });

      // A colleague's machine, still pointing at the old URL.
      await makeFakeRepo(join(code.path, 'stale'), {
        remote: 'git@github.com:ownerA/project.git',
      });
      const stale = await new Registry(workspace.store).register(join(code.path, 'stale'), {
        machineId: 'machine_colleague',
      });

      expect(stale.project.id).toBe(after.project.id);
      expect(await new Registry(workspace.store).all()).toHaveLength(1);
    });

    it('does not merge two genuinely unrelated projects', async () => {
      const { workspace } = await setup();
      await makeFakeRepo(join(code.path, 'a'), { remote: 'git@github.com:acme/a.git' });
      await makeFakeRepo(join(code.path, 'b'), { remote: 'git@github.com:acme/b.git' });

      const registry = new Registry(workspace.store);
      await registry.register(join(code.path, 'a'), { machineId: workspace.machineId });
      await registry.register(join(code.path, 'b'), { machineId: workspace.machineId });

      // Now `a` is transferred to the identity `b` already holds. It must not
      // absorb `b`, and `b` must not disappear.
      await makeFakeRepo(join(code.path, 'a'), { remote: 'git@github.com:acme/b.git' });
      await new Registry(workspace.store).register(join(code.path, 'a'), {
        machineId: workspace.machineId,
      });

      const all = await new Registry(workspace.store).all();
      expect(all).toHaveLength(2);
    });
  });

  describe('reconcileRepository is pure and predictable', () => {
    it('reports no change when the remote is unchanged', async () => {
      const { workspace } = await setup();
      await makeFakeRepo(join(code.path, 'same'), { remote: 'git@github.com:acme/same.git' });
      const { project } = await new Registry(workspace.store).register(join(code.path, 'same'), {
        machineId: workspace.machineId,
      });
      const repo = await readRepoFast(join(code.path, 'same'));

      expect(reconcileRepository(project, repo, '2026-09-18T00:00:00Z').change).toBeNull();
    });

    it('reports no change for a repository with no usable remote', async () => {
      const { workspace } = await setup();
      await makeFakeRepo(join(code.path, 'bare'), {});
      const { project } = await new Registry(workspace.store).register(join(code.path, 'bare'), {
        machineId: workspace.machineId,
      });
      const repo = await readRepoFast(join(code.path, 'bare'));

      expect(reconcileRepository(project, repo, '2026-09-18T00:00:00Z').change).toBeNull();
    });
  });
});

describe('git worktrees', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-wt-home-');
    code = await makeTempDir('pb-wt-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it.runIf(GIT_AVAILABLE)(
    'treats a real linked worktree as another location of the same project',
    async () => {
      const workspace = await Workspace.initialize({ home: home.path });
      const main = join(code.path, 'repo');
      await makeRealRepo(main, { remote: 'git@github.com:acme/repo.git', branch: 'main' });

      const worktree = join(code.path, 'repo-feature');
      await execFileAsync('git', ['worktree', 'add', '-b', 'feature', worktree], {
        cwd: main,
        timeout: 30_000,
      });

      const registry = new Registry(workspace.store);
      const first = await registry.register(main, { machineId: workspace.machineId });
      const second = await registry.register(worktree, { machineId: workspace.machineId });

      // One project...
      expect(second.project.id).toBe(first.project.id);
      expect(await new Registry(workspace.store).all()).toHaveLength(1);

      // ...with two locations, one flagged as a worktree, on different branches.
      const locations = second.project.local_locations;
      expect(locations).toHaveLength(2);

      const linked = locations.find((location) => location.is_worktree);
      expect(linked, 'the worktree must be flagged as one').toBeDefined();
      expect(linked!.branch).toBe('feature');
      expect(linked!.worktree_of).toBe(main);

      const primary = locations.find((location) => !location.is_worktree);
      expect(primary!.branch).toBe('main');
    },
  );

  it.runIf(GIT_AVAILABLE)('reads the worktree branch, not the main one', async () => {
    const main = join(code.path, 'repo');
    await makeRealRepo(main, { remote: 'git@github.com:acme/repo.git', branch: 'main' });
    const worktree = join(code.path, 'wt');
    await execFileAsync('git', ['worktree', 'add', '-b', 'phase-7', worktree], {
      cwd: main,
      timeout: 30_000,
    });

    const info = await readRepoFast(worktree);
    expect(info?.isWorktree).toBe(true);
    expect(info?.branch).toBe('phase-7');
    expect(info?.primaryRemote?.identity).toBe('github.com/acme/repo');
    expect(info?.worktreeOf).toBe(main);
  });

  it.runIf(GIT_AVAILABLE)('a scan finds both the main tree and the worktree', async () => {
    const main = join(code.path, 'repo');
    await makeRealRepo(main, { remote: 'git@github.com:acme/repo.git' });
    await execFileAsync('git', ['worktree', 'add', '-b', 'side', join(code.path, 'side')], {
      cwd: main,
      timeout: 30_000,
    });

    const { scanForProjects } = await import('../../src/discovery/scanner.js');
    const scan = await scanForProjects([code.path]);
    expect(scan.candidates).toHaveLength(2);
  });

  it.runIf(GIT_AVAILABLE)('does not treat a submodule as a worktree', async () => {
    const parent = join(code.path, 'parent');
    const child = join(code.path, 'child');
    await makeRealRepo(child, {});
    await makeRealRepo(parent, { remote: 'git@github.com:acme/parent.git' });

    const added = await execFileAsync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'vendor/child'],
      { cwd: parent, timeout: 30_000 },
    ).catch(() => null);

    if (!added) return; // Some git builds refuse local submodules outright.

    const info = await readRepoFast(join(parent, 'vendor', 'child'));
    expect(info?.isWorktree, 'a submodule is not a worktree').toBe(false);
  });
});

describe('duplicate clones of the same repository', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-dup-home-');
    code = await makeTempDir('pb-dup-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('becomes one project with two locations, not two projects', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);

    // The archived copy is the exact situation the brief describes: same
    // repository, different directory, same machine.
    await makeFakeRepo(join(code.path, 'Projects', 'app'), {
      remote: 'git@github.com:acme/app.git',
    });
    await makeFakeRepo(join(code.path, 'Archive', 'app-copy'), {
      remote: 'https://github.com/acme/app.git',
    });

    const a = await registry.register(join(code.path, 'Projects', 'app'), {
      machineId: workspace.machineId,
    });
    const b = await registry.register(join(code.path, 'Archive', 'app-copy'), {
      machineId: workspace.machineId,
    });

    expect(b.project.id).toBe(a.project.id);
    expect(b.outcome).toBe('location-added');
    expect(await new Registry(workspace.store).all()).toHaveLength(1);

    const paths = b.project.local_locations.map((location) => location.path).sort();
    expect(paths).toHaveLength(2);
    expect(paths.some((path) => path.includes('Archive'))).toBe(true);
  });

  it('keeps both locations visible so the user can tell them apart', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'a', 'app'), { remote: 'git@github.com:acme/app.git' });
    await makeFakeRepo(join(code.path, 'b', 'app'), { remote: 'git@github.com:acme/app.git' });

    await registry.register(join(code.path, 'a', 'app'), { machineId: workspace.machineId });
    const second = await registry.register(join(code.path, 'b', 'app'), {
      machineId: workspace.machineId,
    });

    const onThisMachine = second.project.local_locations.filter(
      (location) => location.machine_id === workspace.machineId,
    );
    expect(onThisMachine).toHaveLength(2);
  });
});

describe('repositories with no remote', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-norem-home-');
    code = await makeTempDir('pb-norem-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  it('does not merge two unrelated local-only repositories', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);

    await makeFakeRepo(join(code.path, 'scratch-one'), {});
    await makeFakeRepo(join(code.path, 'scratch-two'), {});

    const a = await registry.register(join(code.path, 'scratch-one'), {
      machineId: workspace.machineId,
    });
    const b = await registry.register(join(code.path, 'scratch-two'), {
      machineId: workspace.machineId,
    });

    expect(a.project.id).not.toBe(b.project.id);
    expect(a.project.repository).toBeNull();
    expect(await new Registry(workspace.store).all()).toHaveLength(2);
  });

  it('keeps its id stable across restarts', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    await makeFakeRepo(join(code.path, 'scratch'), {});
    const first = await new Registry(workspace.store).register(join(code.path, 'scratch'), {
      machineId: workspace.machineId,
    });

    // A completely fresh process, reading the same home from disk.
    const reopened = await Workspace.open({ home: home.path });
    const again = await new Registry(reopened.store).register(join(code.path, 'scratch'), {
      machineId: reopened.machineId,
    });

    expect(again.project.id).toBe(first.project.id);
    expect(again.outcome).toBe('location-updated');
  });
});
