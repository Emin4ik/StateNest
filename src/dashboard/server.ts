import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Registry } from '../core/registry.js';
import { buildRecent, buildResumeBrief } from '../core/context.js';
import { search } from '../search/search.js';
import { renderPage } from './page.js';
import { BrainError } from '../util/errors.js';
import { relativeTime } from '../util/time.js';
import type { Workspace } from '../core/workspace.js';
import type { Project } from '../core/schema.js';

/**
 * The local dashboard.
 *
 * Built on `node:http` with no framework and no client-side build step: this
 * is a read-only view of local files, and a dependency tree would be a poor
 * trade for that.
 *
 * It is **read-only by design**. There is no endpoint that mutates data, runs
 * a command, or connects to a registered server. A page served on localhost is
 * reachable by anything else running as this user, including a browser tab on
 * a hostile site, so the safest surface is one with no verbs on it.
 */

export interface DashboardOptions {
  host?: string;
  port?: number;
  /** Explicit opt-in required to bind anywhere but a loopback address. */
  allowNonLoopback?: boolean;
}

export interface RunningDashboard {
  url: string;
  close: () => Promise<void>;
}

/**
 * Addresses that keep the dashboard on this machine.
 *
 * Binding to `0.0.0.0` on a laptop in a coffee shop would expose a listing of
 * every project and server the user owns to the local network. Anything else
 * has to be asked for explicitly, and is still warned about.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8 is entirely loopback.
  if (isIP(host) === 4) return host.startsWith('127.');
  return false;
}

export async function startDashboard(
  workspace: Workspace,
  options: DashboardOptions = {},
): Promise<RunningDashboard> {
  const host = options.host ?? workspace.config.dashboard.host;
  const port = options.port ?? workspace.config.dashboard.port;

  if (!isLoopbackHost(host) && !options.allowNonLoopback) {
    throw new BrainError(
      'UNSAFE_DASHBOARD_BIND',
      `Refusing to serve the dashboard on ${host}.`,
      {
        details: [
          'The dashboard lists every project, machine and server you have registered.',
          'On a non-loopback address, anything on your network could read it.',
        ],
        hints: [
          'pb dashboard                       (serves on 127.0.0.1)',
          `pb dashboard --host ${host} --yes-expose-me   (if you really mean it)`,
        ],
      },
    );
  }

  const registry = new Registry(workspace.store);

  const server = createServer((request, response) => {
    handle(request, response, workspace, registry).catch((error: unknown) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'internal error',
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '::1' ? '[::1]' : host;

  return {
    url: `http://${displayHost}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: Workspace,
  registry: Registry,
): Promise<void> {
  // Only reads. Anything else is refused before it reaches a handler.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'The dashboard is read-only.' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  switch (path) {
    case '/':
      sendHtml(response, 200, renderPage());
      return;

    case '/api/overview':
      sendJson(response, 200, await buildOverview(workspace, registry));
      return;

    case '/api/projects':
      sendJson(response, 200, { projects: await projectSummaries(workspace, registry) });
      return;

    case '/api/recent': {
      const projects = (await registry.all()).filter((p) => p.status !== 'archived');
      const entries = await buildRecent(workspace.store, projects, { limit: 25 });
      sendJson(response, 200, {
        entries: entries.map((entry) => ({
          project: entry.project.name,
          project_id: entry.project.id,
          timestamp: entry.timestamp,
          relative: relativeTime(entry.timestamp),
          summary: entry.summary,
          next: entry.checkpoint?.next ?? [],
          blockers: entry.checkpoint?.blockers ?? [],
        })),
      });
      return;
    }

    case '/api/project': {
      const term = url.searchParams.get('id') ?? '';
      const project = (await registry.all()).find((candidate) => candidate.id === term);
      if (!project) {
        sendJson(response, 404, { error: 'No such project.' });
        return;
      }
      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
        checkpointLimit: 10,
      });
      const machines = await workspace.store.listMachines();
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));

      sendJson(response, 200, {
        project: {
          id: project.id,
          name: project.name,
          description: project.description ?? null,
          status: project.status,
          type: project.type,
          tags: project.tags,
          repository: project.repository ?? null,
        },
        last_activity: brief.lastActivityRelative,
        current_focus: brief.currentFocus,
        completed: brief.recentlyCompleted,
        blockers: brief.blockers,
        next: brief.nextActions,
        decisions: brief.keyDecisions.map((decision) => ({
          title: decision.title,
          reason: decision.reason ?? null,
          when: relativeTime(decision.timestamp),
        })),
        locations: project.local_locations.map((location) => ({
          machine: machineNames.get(location.machine_id) ?? location.machine_id,
          is_current: location.machine_id === workspace.machineId,
          path: location.path,
          branch: location.branch,
        })),
        deployments: brief.deployments.map((deployment) => ({
          environment: deployment.environment,
          server: deployment.remote?.name ?? null,
          ssh_alias: deployment.remote?.ssh_alias ?? null,
          path: deployment.path ?? null,
        })),
        checkpoints: brief.checkpoints.map((checkpoint) => ({
          when: relativeTime(checkpoint.meta.timestamp),
          branch: checkpoint.meta.branch,
          summary: checkpoint.summary,
          completed: checkpoint.completed,
        })),
      });
      return;
    }

    case '/api/search': {
      const query = url.searchParams.get('q') ?? '';
      if (query.trim() === '') {
        sendJson(response, 200, { results: [] });
        return;
      }
      const hits = await search(workspace.store, await registry.all(), query, { limit: 40 });
      sendJson(response, 200, {
        results: hits.map((hit) => ({
          scope: hit.scope,
          project: hit.projectName,
          project_id: hit.projectId,
          excerpt: hit.excerpt,
          when: hit.timestamp ? relativeTime(hit.timestamp) : null,
        })),
      });
      return;
    }

    case '/api/machines': {
      const machines = await workspace.store.listMachines();
      const projects = await registry.all();
      sendJson(response, 200, {
        machines: machines.map((machine) => ({
          id: machine.id,
          name: machine.name,
          os: machine.os,
          type: machine.type,
          is_current: machine.id === workspace.machineId,
          last_seen: relativeTime(machine.last_seen_at),
          projects: projects.filter((project) =>
            project.local_locations.some((location) => location.machine_id === machine.id),
          ).length,
        })),
      });
      return;
    }

    case '/api/remotes': {
      const remotes = await workspace.store.listRemotes();
      const projects = await registry.all();
      sendJson(response, 200, {
        remotes: remotes.map((remote) => ({
          id: remote.id,
          name: remote.name,
          environment: remote.environment,
          // Address only. There is no credential to send, by construction.
          ssh_alias: remote.ssh_alias ?? null,
          host: remote.host ?? null,
          provider: remote.provider ?? null,
          projects: projects
            .filter((project) => project.deployments.some((d) => d.remote_id === remote.id))
            .map((project) => project.name),
        })),
      });
      return;
    }

    default:
      sendJson(response, 404, { error: 'Not found.' });
  }
}

async function buildOverview(workspace: Workspace, registry: Registry) {
  const projects = await registry.all();
  const byStatus: Record<string, number> = {};
  for (const project of projects) {
    byStatus[project.status] = (byStatus[project.status] ?? 0) + 1;
  }

  const stale = projects.filter((project) => {
    if (project.status === 'archived') return false;
    const at = project.last_activity_at;
    return !at || Date.now() - new Date(at).getTime() > 30 * 86_400_000;
  });

  return {
    profile: workspace.profile.name,
    machine_id: workspace.machineId,
    totals: {
      projects: projects.length,
      by_status: byStatus,
      stale: stale.length,
      blocked: projects.filter((project) => project.blockers.length > 0).length,
      deployments: projects.reduce((sum, project) => sum + project.deployments.length, 0),
      machines: (await workspace.store.listMachines()).length,
      remotes: (await workspace.store.listRemotes()).length,
    },
    blocked: projects
      .filter((project) => project.blockers.length > 0)
      .map((project) => ({ name: project.name, id: project.id, blockers: project.blockers })),
  };
}

async function projectSummaries(workspace: Workspace, registry: Registry) {
  const projects = await registry.all();
  const machines = await workspace.store.listMachines();
  const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));

  return projects
    .slice()
    .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''))
    .map((project: Project) => ({
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      status: project.status,
      type: project.type,
      last_activity: relativeTime(project.last_activity_at),
      current_focus: project.current_focus ?? null,
      blockers: project.blockers,
      web_url: project.repository?.web_url ?? null,
      locations: project.local_locations.map((location) => ({
        machine: machineNames.get(location.machine_id) ?? location.machine_id,
        is_current: location.machine_id === workspace.machineId,
        path: location.path,
        branch: location.branch,
      })),
      environments: [...new Set(project.deployments.map((d) => d.environment))],
    }));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // The dashboard is same-origin only; nothing should embed or frame it.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    // No remote code, no remote anything: everything is inline and local.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
  });
  response.end(html);
}
