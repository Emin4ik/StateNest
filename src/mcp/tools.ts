import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Workspace } from '../core/workspace.js';
import { Registry } from '../core/registry.js';
import { buildRecent, buildResumeBrief, renderSessionContext } from '../core/context.js';
import { createCheckpoint } from '../checkpoints/create.js';
import { search } from '../search/search.js';
import { readRepoFull } from '../git/repo.js';
import { DecisionSchema, TaskSchema, type Project } from '../core/schema.js';
import { randomId } from '../util/ids.js';
import { now, relativeTime } from '../util/time.js';
import { redactSecrets } from '../security/redact.js';
import { contractHome } from '../util/paths.js';
import { isBrainError } from '../util/errors.js';

/**
 * MCP tool definitions.
 *
 * Naming follows `projectbrain_<verb>_<thing>` so the tools group together in
 * a host's tool list. Schemas are kept deliberately small: every field costs
 * context in every request, and an agent that needs a rarely-used option can
 * be told about it in the description instead.
 */

type TextResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function text(body: string): TextResult {
  return { content: [{ type: 'text', text: body }] };
}

function failure(message: string): TextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Open the workspace for one tool call.
 *
 * Not cached: an MCP server lives for the whole session, and the user may run
 * `statenest` in a terminal at the same time. Re-reading means the agent sees writes
 * made outside the session rather than a snapshot from when it started.
 */
async function open(): Promise<{ workspace: Workspace; registry: Registry }> {
  const workspace = await Workspace.open();
  return { workspace, registry: new Registry(workspace.store) };
}

/**
 * Wrap a handler so a failure becomes a readable message, never a crash.
 *
 * An MCP tool that throws surfaces to the agent as a transport-level error
 * with no useful detail. Returning `isError` with a sentence the agent can act
 * on - and a command it can suggest to the user - is far more recoverable.
 */
function guard<A extends unknown[]>(
  handler: (...args: A) => Promise<TextResult>,
): (...args: A) => Promise<TextResult> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isBrainError(error)) {
        const hints = error.hints.length > 0 ? `\n\nTry: ${error.hints.join(' | ')}` : '';
        return failure(`${error.message}${error.details.length > 0 ? `\n${error.details.join('\n')}` : ''}${hints}`);
      }
      return failure(
        `StateNest could not complete that: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

export function registerTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  server.registerTool(
    'projectbrain_current_project',
    {
      title: 'Identify the current project',
      description:
        'Identify which registered project a directory belongs to, and return a short brief: branch, last activity, current focus, blockers and next actions. Call this when you need to know what project you are working in.',
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe('Absolute path to check. Defaults to the working directory.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z.object({ directory: z.string().optional() }).parse(args ?? {});
      const { workspace, registry } = await open();
      const directory = input.directory ?? process.cwd();
      const { project, repoRoot } = await registry.identify(directory, workspace.machineId);

      if (!project) {
        return text(
          `No registered project at ${contractHome(directory)}.` +
            (repoRoot
              ? ` A git repository exists at ${contractHome(repoRoot)} but is not registered; the user can run \`statenest add .\` to register it.`
              : ' No git repository was found above it.'),
        );
      }

      const machine = await workspace.currentMachine();
      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
        checkpointLimit: 3,
      });
      return text(
        renderSessionContext(brief, {
          ...(machine?.name ? { machineName: machine.name } : {}),
        }),
      );
    }),
  );

  server.registerTool(
    'projectbrain_list_projects',
    {
      title: 'List projects',
      description:
        'List the user\'s projects with status and when each was last active. Use filters rather than listing everything when the user asked a specific question.',
      inputSchema: {
        status: z.enum(['active', 'paused', 'waiting', 'archived']).optional(),
        stale_days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only projects untouched for at least this many days.'),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({
          status: z.enum(['active', 'paused', 'waiting', 'archived']).optional(),
          stale_days: z.number().optional(),
          limit: z.number().optional(),
        })
        .parse(args ?? {});

      const { workspace, registry } = await open();
      let projects = await registry.all();

      if (input.status) projects = projects.filter((p) => p.status === input.status);
      else projects = projects.filter((p) => p.status !== 'archived');

      if (input.stale_days) {
        const cutoff = Date.now() - input.stale_days * 86_400_000;
        projects = projects.filter((p) => {
          const at = p.last_activity_at;
          return !at || new Date(at).getTime() < cutoff;
        });
      }

      projects.sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''));
      const shown = projects.slice(0, input.limit ?? 40);

      if (shown.length === 0) return text('No projects match.');

      const machines = await workspace.store.listMachines();
      const machineNames = new Map(machines.map((m) => [m.id, m.name]));

      const lines = shown.map((project) => {
        const where = describeLocations(project, workspace.machineId, machineNames);
        return `${project.name}  [${project.status}]  ${relativeTime(project.last_activity_at)}  ${where}${
          project.current_focus ? `  — ${project.current_focus}` : ''
        }`;
      });

      const omitted = projects.length - shown.length;
      return text(
        [
          `${shown.length} project(s):`,
          ...lines,
          ...(omitted > 0 ? [`(${omitted} more not shown)`] : []),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'projectbrain_get_resume_context',
    {
      title: 'Get resume context for a project',
      description:
        'Full context for picking a project back up: what it is, what was recently done, decisions made, what is blocked, what is next, and where it lives. Use when the user asks to resume or asks what they were doing in a project.',
      inputSchema: {
        project: z.string().describe('Project name, alias, or id. Partial names work.'),
        checkpoints: z.number().int().min(0).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({ project: z.string(), checkpoints: z.number().optional() })
        .parse(args ?? {});
      const { workspace, registry } = await open();
      const project = await registry.resolveOrThrow(input.project);

      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
        checkpointLimit: input.checkpoints ?? 5,
      });
      const machines = await workspace.store.listMachines();
      const machineNames = new Map(machines.map((m) => [m.id, m.name]));

      const lines: string[] = [`# ${project.name}`];
      if (project.description) lines.push(project.description);
      lines.push(
        '',
        `Status: ${project.status}`,
        `Last activity: ${brief.lastActivityRelative}`,
      );
      if (brief.hereLocation) {
        lines.push(
          `Here: ${brief.hereLocation.path}${brief.hereLocation.branch ? ` (${brief.hereLocation.branch})` : ''}`,
        );
      }
      for (const other of brief.otherLocations) {
        lines.push(
          `Also on ${machineNames.get(other.location.machine_id) ?? 'another machine'}: ${other.location.path}`,
        );
      }
      for (const deployment of brief.deployments) {
        lines.push(
          `Deployed (${deployment.environment}): ${deployment.remote?.ssh_alias ?? deployment.remote?.name ?? 'unknown host'}${deployment.path ? `:${deployment.path}` : ''}`,
        );
      }

      pushSection(lines, 'Current focus', brief.currentFocus ? [brief.currentFocus] : []);
      pushSection(lines, 'Recently completed', brief.recentlyCompleted);
      pushSection(lines, 'Blockers', brief.blockers);
      pushSection(lines, 'Next', brief.nextActions);
      pushSection(
        lines,
        'Decisions',
        brief.keyDecisions.map(
          (decision) =>
            `${decision.title}${decision.reason ? ` — ${decision.reason}` : ''} (${relativeTime(decision.timestamp)})`,
        ),
      );
      pushSection(
        lines,
        'Recent checkpoints',
        brief.checkpoints.map(
          (checkpoint) => `${relativeTime(checkpoint.meta.timestamp)}: ${checkpoint.summary}`,
        ),
      );

      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'projectbrain_list_recent',
    {
      title: 'Recent activity across projects',
      description:
        'What the user has worked on recently, newest first, with a one-line summary of each. Use for "what was I doing yesterday / this week".',
      inputSchema: {
        limit: z.number().int().positive().max(50).optional(),
        days: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z.object({ limit: z.number().optional(), days: z.number().optional() }).parse(args ?? {});
      const { workspace, registry } = await open();
      const projects = (await registry.all()).filter((p) => p.status !== 'archived');

      const since = input.days
        ? `${new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 19)}Z`
        : undefined;

      const entries = await buildRecent(workspace.store, projects, {
        limit: input.limit ?? 15,
        ...(since ? { since } : {}),
      });

      if (entries.length === 0) return text('No recorded activity.');

      return text(
        entries
          .map(
            (entry) =>
              `${relativeTime(entry.timestamp)} — ${entry.project.name}: ${entry.summary}` +
              (entry.checkpoint?.next?.[0] ? `\n  next: ${entry.checkpoint.next[0]}` : ''),
          )
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'projectbrain_where',
    {
      title: 'Where a project lives',
      description:
        'Every place a project exists: local paths on each machine, and every server it is deployed to with ssh alias, deploy path and service name. Addresses only - StateNest stores no credentials and cannot connect anywhere.',
      inputSchema: { project: z.string().describe('Project name, alias, or id.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z.object({ project: z.string() }).parse(args ?? {});
      const { workspace, registry } = await open();
      const project = await registry.resolveOrThrow(input.project);

      const machines = await workspace.store.listMachines();
      const remotes = await workspace.store.listRemotes();
      const machineNames = new Map(machines.map((m) => [m.id, m.name]));
      const remoteById = new Map(remotes.map((r) => [r.id, r]));

      const lines: string[] = [`${project.name}`];
      if (project.repository) lines.push(`Repository: ${project.repository.identity}`);

      if (project.local_locations.length > 0) {
        lines.push('', 'Local copies:');
        for (const location of project.local_locations) {
          const machine = machineNames.get(location.machine_id) ?? location.machine_id;
          const here = location.machine_id === workspace.machineId ? ' (this machine)' : '';
          lines.push(
            `  ${machine}${here}: ${location.path}${location.branch ? ` [${location.branch}]` : ''}${location.is_worktree ? ' (worktree)' : ''}`,
          );
        }
      }

      if (project.deployments.length > 0) {
        lines.push('', 'Deployments:');
        for (const deployment of project.deployments) {
          const remote = remoteById.get(deployment.remote_id);
          lines.push(
            `  ${deployment.environment}: ${remote?.name ?? 'unknown server'}` +
              (remote?.ssh_alias ? ` (ssh alias: ${remote.ssh_alias})` : '') +
              (remote?.host ? ` host ${remote.host}` : '') +
              (deployment.path ? ` path ${deployment.path}` : '') +
              (deployment.service ? ` service ${deployment.service}` : ''),
          );
        }
      }

      if (project.local_locations.length === 0 && project.deployments.length === 0) {
        lines.push('', 'No locations recorded yet.');
      }

      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'projectbrain_search',
    {
      title: 'Search project memory',
      description:
        'Search the user\'s own project history: checkpoints, decisions, tasks, project notes and server labels. Does not search source code. Use when the user refers to something they did but cannot remember where.',
      inputSchema: {
        query: z.string().describe('Words to find. Use "quotes" for an exact phrase.'),
        project: z.string().optional().describe('Restrict to one project.'),
        limit: z.number().int().positive().max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({ query: z.string(), project: z.string().optional(), limit: z.number().optional() })
        .parse(args ?? {});
      const { workspace, registry } = await open();

      const projectId = input.project
        ? (await registry.resolveOrThrow(input.project)).id
        : undefined;

      const hits = await search(workspace.store, await registry.all(), input.query, {
        limit: input.limit ?? 20,
        ...(projectId ? { projectId } : {}),
      });

      if (hits.length === 0) return text(`Nothing found for "${input.query}".`);

      return text(
        hits
          .map(
            (hit) =>
              `[${hit.scope}] ${hit.projectName ?? 'servers'}${hit.timestamp ? ` (${relativeTime(hit.timestamp)})` : ''}: ${hit.excerpt}`,
          )
          .join('\n'),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // Writing memory
  // -------------------------------------------------------------------------

  server.registerTool(
    'projectbrain_checkpoint',
    {
      title: 'Record a checkpoint',
      description:
        'Record what was accomplished in a working session. Write it for someone reading in six months who has forgotten everything: what changed and why it mattered, not "updated files". Call this when meaningful work is finished, not after every edit.',
      inputSchema: {
        project: z.string().optional().describe('Defaults to the project of the working directory.'),
        summary: z.string().describe('One or two sentences: what changed and why it mattered.'),
        completed: z.array(z.string()).optional().describe('Things finished this session.'),
        decisions: z.array(z.string()).optional().describe('Choices made that a diff would not show.'),
        blockers: z.array(z.string()).optional().describe('What is stopping progress.'),
        next: z.array(z.string()).optional().describe('What to do next.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({
          project: z.string().optional(),
          summary: z.string(),
          completed: z.array(z.string()).optional(),
          decisions: z.array(z.string()).optional(),
          blockers: z.array(z.string()).optional(),
          next: z.array(z.string()).optional(),
        })
        .parse(args ?? {});

      const { workspace, registry } = await open();
      const project = input.project
        ? await registry.resolveOrThrow(input.project)
        : await currentProjectOrThrow(registry, workspace.machineId);

      const location = project.local_locations.find((l) => l.machine_id === workspace.machineId);
      const repo = location ? await readRepoFull(location.path, { changedFileLimit: 25 }) : null;

      const result = await createCheckpoint(
        workspace.store,
        project,
        {
          summary: input.summary,
          ...(input.completed ? { completed: input.completed } : {}),
          ...(input.decisions ? { decisions: input.decisions } : {}),
          ...(input.blockers ? { blockers: input.blockers } : {}),
          ...(input.next ? { next: input.next } : {}),
          tags: ['agent'],
        },
        { machineId: workspace.machineId, source: 'claude-code', repo },
      );

      await registry.save({
        ...project,
        last_checkpoint_at: result.meta.timestamp,
        last_activity_at: now(),
      });

      return text(
        `Checkpoint saved for ${project.name}.` +
          (result.redactions > 0
            ? ` ${result.redactions} value(s) that looked like credentials were redacted first.`
            : ''),
      );
    }),
  );

  server.registerTool(
    'projectbrain_add_decision',
    {
      title: 'Record a decision',
      description:
        'Record a decision and, crucially, why it was made. Use for choices that would not be obvious from the code later - especially ones a future session might otherwise reverse by accident.',
      inputSchema: {
        project: z.string().optional(),
        title: z.string().describe('What was decided.'),
        reason: z.string().optional().describe('Why. This is the part git history never records.'),
        alternatives: z.array(z.string()).optional().describe('What was considered and rejected.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({
          project: z.string().optional(),
          title: z.string(),
          reason: z.string().optional(),
          alternatives: z.array(z.string()).optional(),
        })
        .parse(args ?? {});

      const { workspace, registry } = await open();
      const project = input.project
        ? await registry.resolveOrThrow(input.project)
        : await currentProjectOrThrow(registry, workspace.machineId);

      const decision = DecisionSchema.parse({
        id: randomId('dec', 6),
        project_id: project.id,
        timestamp: now(),
        machine_id: workspace.machineId,
        title: redactSecrets(input.title).text,
        ...(input.reason ? { reason: redactSecrets(input.reason).text } : {}),
        alternatives: (input.alternatives ?? []).map((item) => redactSecrets(item).text),
      });

      await workspace.store.appendDecision(decision);
      return text(`Decision recorded for ${project.name}: ${decision.title}`);
    }),
  );

  server.registerTool(
    'projectbrain_add_task',
    {
      title: 'Record a next action',
      description:
        'Record something still to do, so it appears the next time the project is resumed. Lightweight - this is not an issue tracker.',
      inputSchema: {
        project: z.string().optional(),
        text: z.string().describe('What needs doing.'),
        blocked_reason: z.string().optional().describe('Set if it is blocked, and by what.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({
          project: z.string().optional(),
          text: z.string(),
          blocked_reason: z.string().optional(),
        })
        .parse(args ?? {});

      const { workspace, registry } = await open();
      const project = input.project
        ? await registry.resolveOrThrow(input.project)
        : await currentProjectOrThrow(registry, workspace.machineId);

      const file = await workspace.store.readTasks(project.id);
      const timestamp = now();
      const task = TaskSchema.parse({
        id: randomId('task', 6),
        text: redactSecrets(input.text).text,
        status: input.blocked_reason ? 'blocked' : 'todo',
        ...(input.blocked_reason ? { blocked_reason: input.blocked_reason } : {}),
        created_at: timestamp,
        updated_at: timestamp,
        source: 'claude-code',
      });

      await workspace.store.writeTasks({ ...file, tasks: [...file.tasks, task] });
      return text(`Next action recorded for ${project.name}: ${task.text}`);
    }),
  );

  server.registerTool(
    'projectbrain_update_state',
    {
      title: 'Update what a project is currently about',
      description:
        'Set the one-line current focus, and optionally replace the list of open blockers. Use when the direction of the work changes, not for every step.',
      inputSchema: {
        project: z.string().optional(),
        current_focus: z.string().optional().describe('One line: what is being worked on now.'),
        blockers: z.array(z.string()).optional().describe('Replaces the existing blocker list.'),
        status: z.enum(['active', 'paused', 'waiting', 'archived']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async (args: unknown) => {
      const input = z
        .object({
          project: z.string().optional(),
          current_focus: z.string().optional(),
          blockers: z.array(z.string()).optional(),
          status: z.enum(['active', 'paused', 'waiting', 'archived']).optional(),
        })
        .parse(args ?? {});

      const { workspace, registry } = await open();
      const project = input.project
        ? await registry.resolveOrThrow(input.project)
        : await currentProjectOrThrow(registry, workspace.machineId);

      const saved = await registry.save({
        ...project,
        ...(input.current_focus !== undefined
          ? { current_focus: redactSecrets(input.current_focus).text }
          : {}),
        ...(input.blockers !== undefined
          ? { blockers: input.blockers.map((item) => redactSecrets(item).text) }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        last_activity_at: now(),
      });

      return text(
        `Updated ${saved.name}.` +
          (saved.current_focus ? ` Current focus: ${saved.current_focus}` : ''),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function currentProjectOrThrow(registry: Registry, machineId: string): Promise<Project> {
  const { project } = await registry.identify(process.cwd(), machineId);
  if (project) return project;
  const { BrainError } = await import('../util/errors.js');
  throw new BrainError(
    'UNKNOWN_PROJECT',
    'This directory is not a registered project, so there is nowhere to record that.',
    {
      details: [`Directory: ${contractHome(process.cwd())}`],
      hints: ['Ask the user to run `statenest add .`, or pass an explicit project name.'],
    },
  );
}

function pushSection(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push('', `## ${title}`);
  for (const item of items) lines.push(`- ${item}`);
}

function describeLocations(
  project: Project,
  machineId: string,
  machineNames: Map<string, string>,
): string {
  const here = project.local_locations.some((l) => l.machine_id === machineId);
  const others = new Set(
    project.local_locations.filter((l) => l.machine_id !== machineId).map((l) => l.machine_id),
  );
  const parts: string[] = [];
  if (here) parts.push('here');
  for (const machineId of others) parts.push(machineNames.get(machineId) ?? 'another machine');
  if (project.deployments.length > 0) {
    parts.push(...new Set(project.deployments.map((d) => d.environment)));
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}
