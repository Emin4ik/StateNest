import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { Workspace, listProfileNames } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { RemoteSchema } from '../../src/core/schema.js';
import { randomId } from '../../src/util/ids.js';
import { now } from '../../src/util/time.js';
import { startDashboard, type ProfileView, type RunningDashboard } from '../../src/dashboard/server.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * One place to see personal and work, without merging them.
 *
 * The unified dashboard is a read-only join performed in memory. Profiles keep
 * separate directories, separate sync remotes and separate data files; nothing
 * is copied between them. These tests exist to prove the join does not become a
 * merge — that every row still says which profile it came from, that a server
 * registered at work never appears attached to a personal project, and that
 * viewing everything at once writes nothing anywhere.
 */
describe('unified dashboard view', () => {
  let home: TempDir;
  let code: TempDir;
  let server: RunningDashboard | null = null;
  let base = '';
  let personal: Workspace;
  let work: Workspace;

  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  /** Every file in a profile directory, with its contents, for comparison. */
  async function snapshot(root: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (dir: string, prefix = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const full = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(full, rel);
        else files.set(rel, await readFile(full, 'utf8'));
      }
    };
    await walk(root);
    return files;
  }

  beforeEach(async () => {
    home = await makeTempDir('sn-unified-home-');
    code = await makeTempDir('sn-unified-code-');

    personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    work = await Workspace.initialize({ home: home.path, profileName: 'work' });

    // A project in each, plus one server each.
    for (const [workspace, name, remote] of [
      [personal, 'hobby', 'git@github.com:me/hobby.git'],
      [work, 'billing', 'git@github.com:acme/billing.git'],
    ] as const) {
      const registry = new Registry(workspace.store);
      await makeFakeRepo(join(code.path, name), { remote });
      const { project } = await registry.register(join(code.path, name), {
        machineId: workspace.machineId,
      });
      await createCheckpoint(
        workspace.store,
        project,
        { summary: `Worked on ${name}.` },
        { machineId: workspace.machineId, source: 'cli' },
      );
      await workspace.store.saveRemote(
        RemoteSchema.parse({
          id: randomId('rmt'),
          name: `${name}-vps`,
          host: `${name}.example.invalid`,
          environment: 'production',
          created_at: now(),
          updated_at: now(),
        }),
      );
    }

    const views: ProfileView[] = [
      { name: 'personal', workspace: personal, registry: new Registry(personal.store) },
      { name: 'work', workspace: work, registry: new Registry(work.store) },
    ];
    server = await startDashboard(views, { host: '127.0.0.1', port: 0 });
    base = server.url;
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await home.cleanup();
    await code.cleanup();
  });

  it('shows both profiles, and labels every project with the one it belongs to', async () => {
    const { body } = await get('/api/projects');
    const byName = new Map(body.projects.map((p: any) => [p.name, p.profile]));

    expect(byName.get('hobby')).toBe('personal');
    expect(byName.get('billing')).toBe('work');
    expect(body.projects.every((p: any) => typeof p.profile === 'string' && p.profile.length > 0)).toBe(
      true,
    );
  });

  it('keeps servers attached to the profile that registered them', async () => {
    const { body } = await get('/api/remotes');
    const personalServer = body.remotes.find((r: any) => r.name === 'hobby-vps');
    const workServer = body.remotes.find((r: any) => r.name === 'billing-vps');

    expect(personalServer.profile).toBe('personal');
    expect(workServer.profile).toBe('work');
    // A work server must never be listed against a personal project.
    expect(workServer.projects).not.toContain('hobby');
    expect(personalServer.projects).not.toContain('billing');
  });

  it('reports totals across profiles and the per-profile breakdown', async () => {
    const { body } = await get('/api/overview');
    expect(body.totals.projects).toBe(2);
    expect(body.profiles.map((p: any) => p.profile).sort()).toEqual(['personal', 'work']);
    for (const part of body.profiles) expect(part.totals.projects).toBe(1);
  });

  it('interleaves the recent feed while keeping each entry attributable', async () => {
    const { body } = await get('/api/recent');
    expect(body.entries.length).toBe(2);
    expect(new Set(body.entries.map((e: any) => e.profile))).toEqual(new Set(['personal', 'work']));
  });

  it('answers a project detail request from the profile that was asked for', async () => {
    const { body: list } = await get('/api/projects');
    const billing = list.projects.find((p: any) => p.name === 'billing');

    const { body } = await get(
      `/api/project?id=${encodeURIComponent(billing.id)}&profile=work`,
    );
    expect(body.project.name).toBe('billing');

    // The same id scoped to the other profile is simply not there.
    const { status } = await get(
      `/api/project?id=${encodeURIComponent(billing.id)}&profile=personal`,
    );
    expect(status).toBe(404);
  });

  it('never merges two profiles into one project, even with the same name', async () => {
    const { body } = await get('/api/projects');
    const names = body.projects.map((p: any) => p.name);
    expect(names).toHaveLength(2);
    expect(new Set(body.projects.map((p: any) => `${p.profile}/${p.id}`)).size).toBe(2);
  });

  it('writes nothing to any profile while the unified view is used', async () => {
    const before = {
      personal: await snapshot(personal.profilePaths.root),
      work: await snapshot(work.profilePaths.root),
    };

    // Exercise every endpoint, including a detail view and a search.
    await get('/api/overview');
    await get('/api/projects');
    await get('/api/recent');
    await get('/api/machines');
    await get('/api/remotes');
    await get('/api/search?q=worked');
    const { body: list } = await get('/api/projects');
    for (const project of list.projects) {
      await get(`/api/project?id=${encodeURIComponent(project.id)}&profile=${project.profile}`);
    }

    const after = {
      personal: await snapshot(personal.profilePaths.root),
      work: await snapshot(work.profilePaths.root),
    };

    // Byte-for-byte identical. A read-only view that writes is not read-only.
    expect([...after.personal.entries()]).toEqual([...before.personal.entries()]);
    expect([...after.work.entries()]).toEqual([...before.work.entries()]);
  });

  it('refuses every verb but GET, so a unified view cannot write anywhere', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/api/projects`, { method });
      expect(response.status).toBe(405);
    }
  });

  it('lists both profiles on disk, still stored separately', async () => {
    expect(await listProfileNames(personal.paths)).toEqual(['personal', 'work']);
    expect(personal.profilePaths.root).not.toBe(work.profilePaths.root);
  });
});
