import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { type Registry } from '../core/registry.js';
import { buildRecent, buildResumeBrief } from '../core/context.js';
import { search } from '../search/search.js';
import { renderPage } from './page.js';
import { BrainError } from '../util/errors.js';
import { relativeTime } from '../util/time.js';
import { redactSecrets } from '../security/redact.js';
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

/**
 * One profile, as the dashboard reads it.
 *
 * The unified view is a list of these. Profiles stay completely separate on
 * disk and in sync; this is a read-only join performed in memory, for display,
 * and every row carries the profile it came from. Nothing is written, so there
 * is no such thing as writing to the wrong profile here - the dashboard has no
 * verbs at all.
 */
export interface ProfileView {
  name: string;
  workspace: Workspace;
  registry: Registry;
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
  views: ProfileView[],
  options: DashboardOptions = {},
): Promise<RunningDashboard> {
  const primary = views[0];
  if (!primary) throw new Error('The dashboard needs at least one profile to show.');
  const { workspace } = primary;
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
          'statenest dashboard                       (serves on 127.0.0.1)',
          `statenest dashboard --host ${host} --yes-expose-me   (if you really mean it)`,
        ],
      },
    );
  }

  const server = createServer((request, response) => {
    handle(request, response, views).catch((error: unknown) => {
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

/** Concatenate one payload per profile, tagging every row with its profile. */
async function acrossProfiles<T>(
  views: ProfileView[],
  build: (view: ProfileView) => Promise<T[]>,
): Promise<(T & { profile: string })[]> {
  const perProfile = await Promise.all(
    views.map(async (view) =>
      (await build(view)).map((row) => ({ ...row, profile: view.name })),
    ),
  );
  return perProfile.flat();
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  views: ProfileView[],
): Promise<void> {
  const primary = views[0]!;
  const { workspace } = primary;
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

    case '/api/overview': {
      const perProfile = await Promise.all(
        views.map(async (view) => ({
          ...(await buildOverview(view.workspace, view.registry)),
          profile: view.name,
        })),
      );
      // A single profile keeps exactly the shape it had. More than one adds
      // the per-profile breakdown alongside the totals, so the boundary stays
      // visible rather than being summed away.
      sendJson(
        response,
        200,
        perProfile.length === 1
          ? { ...perProfile[0]!, profiles: perProfile }
          : {
              ...mergeOverviews(perProfile),
              profiles: perProfile,
            },
      );
      return;
    }

    case '/api/projects':
      sendJson(response, 200, {
        projects: await acrossProfiles(views, (view) =>
          projectSummaries(view.workspace, view.registry),
        ),
      });
      return;

    case '/api/recent': {
      const entries = await acrossProfiles(views, async (view) => {
        const projects = (await view.registry.all()).filter((p) => p.status !== 'archived');
        const found = await buildRecent(view.workspace.store, projects, { limit: 25 });
        return found.map((entry) => ({
          project: entry.project.name,
          project_id: entry.project.id,
          timestamp: entry.timestamp,
          relative: relativeTime(entry.timestamp),
          summary: entry.summary,
          next: entry.checkpoint?.next ?? [],
          blockers: entry.checkpoint?.blockers ?? [],
        }));
      });
      // Interleave by time, which is the whole point of a combined feed.
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      sendJson(response, 200, { entries: entries.slice(0, 25) });
      return;
    }

    case '/api/project': {
      const term = url.searchParams.get('id') ?? '';
      const wanted = url.searchParams.get('profile');

      // Scope to one profile. The same repository may legitimately be
      // registered in two profiles, and answering from whichever happened to
      // be searched first would show work data on a personal row.
      const candidates = (
        await Promise.all(
          views
            .filter((view) => wanted === null || view.name === wanted)
            .map(async (view) => ({
              view,
              project: (await view.registry.all()).find((p) => p.id === term) ?? null,
            })),
        )
      ).filter((entry) => entry.project !== null);

      if (candidates.length === 0) {
        sendJson(response, 404, { error: 'No such project.' });
        return;
      }
      if (candidates.length > 1) {
        sendJson(response, 409, {
          error: 'That project id exists in more than one profile.',
          profiles: candidates.map((entry) => entry.view.name),
        });
        return;
      }

      const owner = candidates[0]!.view;
      const project = candidates[0]!.project!;
      const brief = await buildResumeBrief(owner.workspace.store, project, {
        machineId: owner.workspace.machineId,
        checkpointLimit: 10,
      });
      const machines = await owner.workspace.store.listMachines();
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));

      sendJson(response, 200, {
        project: {
          id: project.id,
          name: scrub(project.name),
          description: project.description ? scrub(project.description) : null,
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
      const results = await acrossProfiles(views, async (view) => {
        const hits = await search(view.workspace.store, await view.registry.all(), query, {
          limit: 40,
        });
        return hits.map((hit) => ({
          scope: hit.scope,
          project: hit.projectName,
          project_id: hit.projectId,
          excerpt: hit.excerpt,
          when: hit.timestamp ? relativeTime(hit.timestamp) : null,
        }));
      });
      sendJson(response, 200, { results: results.slice(0, 40) });
      return;
    }

    case '/api/machines': {
      sendJson(response, 200, {
        machines: await acrossProfiles(views, async (view) => {
          const machines = await view.workspace.store.listMachines();
          const projects = await view.registry.all();
          return machines.map((machine) => ({
            id: machine.id,
            name: machine.name,
            os: machine.os,
            type: machine.type,
            is_current: machine.id === view.workspace.machineId,
            last_seen: relativeTime(machine.last_seen_at),
            projects: projects.filter((project) =>
              project.local_locations.some((location) => location.machine_id === machine.id),
            ).length,
          }));
        }),
      });
      return;
    }

    case '/api/remotes': {
      sendJson(response, 200, {
        // Servers stay scoped to the profile that registered them: a work VPS
        // must never appear attached to a personal project.
        remotes: await acrossProfiles(views, async (view) => {
          const remotes = await view.workspace.store.listRemotes();
          const projects = await view.registry.all();
          return remotes.map((remote) => ({
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
          }));
        }),
      });
      return;
    }

    default:
      sendJson(response, 404, { error: 'Not found.' });
  }
}

/**
 * Totals across every profile shown, for the unified view.
 *
 * Deliberately only sums counters. Profile-specific identity - which machine
 * this is, which profile is active - is not meaningful once combined, so it is
 * left to the per-profile breakdown rather than being averaged into nonsense.
 */
function mergeOverviews(parts: Awaited<ReturnType<typeof buildOverview>>[]) {
  const byStatus: Record<string, number> = {};
  const blocked: { name: string; id: string; blockers: string[]; profile?: string }[] = [];
  const totals = { projects: 0, stale: 0, blocked: 0, deployments: 0, machines: 0, remotes: 0 };

  for (const part of parts) {
    totals.projects += part.totals.projects;
    totals.stale += part.totals.stale;
    totals.blocked += part.totals.blocked;
    totals.deployments += part.totals.deployments;
    totals.machines += part.totals.machines;
    totals.remotes += part.totals.remotes;
    for (const [status, count] of Object.entries(part.totals.by_status)) {
      byStatus[status] = (byStatus[status] ?? 0) + count;
    }
    for (const entry of part.blocked) blocked.push({ ...entry, profile: part.profile });
  }

  return { profile: null, machine_id: null, totals: { ...totals, by_status: byStatus }, blocked };
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
      .map((project) => ({
        name: scrub(project.name),
        id: project.id,
        blockers: project.blockers.map(scrub),
      })),
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
      // Redacted on the way out as well as on the way in: a value written by an
      // older build or a hand edit must not reach a browser page.
      name: scrub(project.name),
      description: project.description ? scrub(project.description) : null,
      status: project.status,
      type: project.type,
      last_activity: relativeTime(project.last_activity_at),
      current_focus: project.current_focus ? scrub(project.current_focus) : null,
      blockers: project.blockers.map(scrub),
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

/** Stored text on its way to a browser gets the same treatment as on write. */
function scrub(value: string): string {
  return redactSecrets(value).text;
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
