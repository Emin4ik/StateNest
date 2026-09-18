import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Registry } from '../../src/core/registry.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { startDashboard, isLoopbackHost, type RunningDashboard , type ProfileView } from '../../src/dashboard/server.js';
import { RemoteSchema } from '../../src/core/schema.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';
import { now } from '../../src/util/time.js';
import { Workspace } from '../../src/core/workspace.js';

/** The dashboard takes a list of profile views; these tests show exactly one. */
function oneProfile(workspace: Workspace): ProfileView[] {
  return [{ name: workspace.profile.name, workspace, registry: new Registry(workspace.store) }];
}


describe('dashboard', () => {
  let home: TempDir;
  let code: TempDir;
  let server: RunningDashboard | null = null;
  let workspace: Workspace;

  beforeEach(async () => {
    home = await makeTempDir('pb-dash-home-');
    code = await makeTempDir('pb-dash-code-');
    workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });

    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'widget'), { remote: 'git@github.com:acme/widget.git' });
    const { project } = await registry.register(join(code.path, 'widget'), {
      machineId: workspace.machineId,
    });
    await registry.save({ ...project, blockers: ['the refinery AI cannot rebuild'] });
    await createCheckpoint(
      workspace.store,
      project,
      { summary: 'Reworked the preprocessing pass.', next: ['re-benchmark on iOS'] },
      { machineId: workspace.machineId, source: 'cli' },
    );

    const timestamp = now();
    await workspace.store.saveRemote(
      RemoteSchema.parse({
        id: 'remote_prod',
        name: 'widget-prod',
        ssh_alias: 'widget-prod',
        host: '203.0.113.10',
        environment: 'production',
        created_at: timestamp,
        updated_at: timestamp,
      }),
    );

    // Port 0 lets the OS pick a free port, so tests never collide.
    server = await startDashboard(oneProfile(workspace), { host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await home.cleanup();
    await code.cleanup();
  });

  const url = (path: string) => `${server!.url}${path}`;

  /**
   * `Response.json()` is typed `unknown`, which is correct: it is untrusted
   * wire data. Asserting the shape once here keeps that honest while letting
   * the assertions below read normally.
   */
  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(url(path));
    return (await response.json()) as T;
  }

  describe('binds safely by default', () => {
    it('serves on a loopback address', () => {
      expect(server!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('refuses a non-loopback address without an explicit override', async () => {
      await expect(
        startDashboard(oneProfile(workspace), { host: '0.0.0.0', port: 0 }),
      ).rejects.toThrow(/Refusing to serve the dashboard/i);
    });

    it('recognises loopback addresses', () => {
      for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1']) {
        expect(isLoopbackHost(host), host).toBe(true);
      }
      for (const host of ['0.0.0.0', '192.168.1.10', '10.0.0.1', 'example.com']) {
        expect(isLoopbackHost(host), host).toBe(false);
      }
    });

    it('binds elsewhere only when explicitly forced', async () => {
      const exposed = await startDashboard(oneProfile(workspace), {
        host: '127.0.0.1',
        port: 0,
        allowNonLoopback: true,
      });
      expect(exposed.url).toContain('127.0.0.1');
      await exposed.close();
    });
  });

  describe('is read-only', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s', async (method) => {
      const response = await fetch(url('/api/projects'), { method });
      expect(response.status).toBe(405);
    });

    it('sends headers that stop the page being framed or sniffed', async () => {
      const response = await fetch(url('/'));
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    });
  });

  describe('serves the data', () => {
    it('returns an overview with real totals', async () => {
      const data = await getJson<{
        profile: string;
        totals: { projects: number; blocked: number };
        blocked: { blockers: string[] }[];
      }>('/api/overview');
      expect(data.profile).toBe('personal');
      expect(data.totals.projects).toBe(1);
      expect(data.totals.blocked).toBe(1);
      expect(data.blocked[0]!.blockers).toContain('the refinery AI cannot rebuild');
    });

    it('lists projects with where they live', async () => {
      const { projects } = await getJson<{
        projects: { name: string; locations: { is_current: boolean }[] }[];
      }>('/api/projects');
      expect(projects).toHaveLength(1);
      expect(projects[0]!.name).toBe('widget');
      expect(projects[0]!.locations[0]!.is_current).toBe(true);
    });

    it('returns a project detail view', async () => {
      const { projects } = await getJson<{ projects: { id: string }[] }>('/api/projects');
      const detail = await getJson<{
        project: { name: string };
        next: string[];
        checkpoints: { summary: string }[];
      }>(`/api/project?id=${projects[0]!.id}`);
      expect(detail.project.name).toBe('widget');
      expect(detail.next).toContain('re-benchmark on iOS');
      expect(detail.checkpoints[0]!.summary).toBe('Reworked the preprocessing pass.');
    });

    it('returns recent activity', async () => {
      const { entries } = await getJson<{ entries: { project: string; summary: string }[] }>(
        '/api/recent',
      );
      expect(entries[0]!.project).toBe('widget');
      expect(entries[0]!.summary).toBe('Reworked the preprocessing pass.');
    });

    it('searches', async () => {
      const { results } = await getJson<{ results: { excerpt: string }[] }>(
        '/api/search?q=preprocessing',
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.excerpt.includes('preprocessing'))).toBe(true);
    });

    it('serves servers as addresses only', async () => {
      const { remotes } = await getJson<{ remotes: { name: string; ssh_alias: string }[] }>(
        '/api/remotes',
      );
      expect(remotes[0]!.name).toBe('widget-prod');
      expect(remotes[0]!.ssh_alias).toBe('widget-prod');

      const body = JSON.stringify(remotes).toLowerCase();
      for (const forbidden of ['password', 'private_key', 'identity', 'token', 'passphrase']) {
        expect(body).not.toContain(forbidden);
      }
    });

    it('serves a self-contained page that loads nothing remote', async () => {
      const html = await (await fetch(url('/'))).text();
      expect(html).toContain('StateNest');
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+href="https?:/i);
      // Values from the API are inserted as text, never parsed as markup.
      expect(html).not.toContain('innerHTML');
    });

    it('404s an unknown path', async () => {
      expect((await fetch(url('/nope'))).status).toBe(404);
    });

    it('404s an unknown project rather than leaking a listing', async () => {
      const response = await fetch(url('/api/project?id=prj_does_not_exist'));
      expect(response.status).toBe(404);
    });
  });
});
