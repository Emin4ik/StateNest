import type { Store } from '../storage/store.js';
import type {
  Checkpoint,
  Decision,
  Machine,
  Project,
  ProjectLocation,
  Remote,
  Task,
} from './schema.js';
import { relativeTime, type Timestamp } from '../util/time.js';
import { contractHome } from '../util/paths.js';
import { extractSections } from '../storage/frontmatter.js';

/**
 * The shared answer to "where was I?".
 *
 * Built once here and consumed by the CLI, the MCP server and the Claude Code
 * SessionStart hook, so all three tell the user the same story. Core owns this
 * on purpose: an adapter formats a brief, it never decides what is in one.
 */
export interface ResumeBrief {
  project: Project;
  /** Best available "when did anything last happen", across all signals. */
  lastActivityAt: Timestamp | null;
  lastActivityRelative: string;
  /** Where the project is on the machine asking. */
  hereLocation: ProjectLocation | null;
  otherLocations: { location: ProjectLocation; machine: Machine | null }[];
  deployments: { environment: string; remote: Remote | null; path?: string; branch?: string }[];
  currentFocus: string | null;
  /** Prose from state.md, already split into its sections. */
  stateSections: Map<string, string>;
  recentlyCompleted: string[];
  blockers: string[];
  nextActions: string[];
  openTasks: Task[];
  keyDecisions: Decision[];
  checkpoints: Checkpoint[];
}

export interface BuildBriefOptions {
  machineId: string;
  /** How many checkpoints to read. More costs one file read each. */
  checkpointLimit?: number;
  decisionLimit?: number;
}

export async function buildResumeBrief(
  store: Store,
  project: Project,
  options: BuildBriefOptions,
): Promise<ResumeBrief> {
  const checkpointLimit = options.checkpointLimit ?? 5;

  const [state, tasks, checkpoints, decisions, machines, remotes] = await Promise.all([
    store.readState(project.id),
    store.readTasks(project.id),
    store.listCheckpoints(project.id, { limit: checkpointLimit }),
    store.readDecisions(project.id),
    store.listMachines(),
    store.listRemotes(),
  ]);

  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const remoteById = new Map(remotes.map((remote) => [remote.id, remote]));
  const stateSections = state ? extractSections(state) : new Map<string, string>();

  const here =
    project.local_locations.find((location) => location.machine_id === options.machineId) ?? null;
  const elsewhere = project.local_locations
    .filter((location) => location !== here)
    .map((location) => ({ location, machine: machineById.get(location.machine_id) ?? null }));

  const openTasks = tasks.tasks.filter(
    (task) => task.status === 'todo' || task.status === 'in_progress' || task.status === 'blocked',
  );

  const lastActivityAt = latest(
    project.last_activity_at,
    project.last_checkpoint_at,
    checkpoints[0]?.meta.timestamp,
    ...project.local_locations.map((location) => location.last_seen_at),
  );

  return {
    project,
    lastActivityAt,
    lastActivityRelative: relativeTime(lastActivityAt),
    hereLocation: here,
    otherLocations: elsewhere,
    deployments: project.deployments.map((deployment) => ({
      environment: deployment.environment,
      remote: remoteById.get(deployment.remote_id) ?? null,
      ...(deployment.path ? { path: deployment.path } : {}),
      ...(deployment.branch ? { branch: deployment.branch } : {}),
    })),
    currentFocus: project.current_focus ?? sectionText(stateSections, 'current focus') ?? null,
    stateSections,
    recentlyCompleted: collectRecent(checkpoints, (checkpoint) => checkpoint.completed, 6),
    blockers: dedupe([
      ...project.blockers,
      ...collectRecent(checkpoints, (checkpoint) => checkpoint.blockers, 4),
      ...openTasks.filter((task) => task.status === 'blocked').map((task) => task.text),
    ]).slice(0, 6),
    nextActions: dedupe([
      ...openTasks.filter((task) => task.status !== 'blocked').map((task) => task.text),
      ...collectRecent(checkpoints, (checkpoint) => checkpoint.next, 4),
    ]).slice(0, 8),
    openTasks,
    keyDecisions: decisions.filter((decision) => !decision.superseded_by).slice(0, options.decisionLimit ?? 5),
    checkpoints,
  };
}

/**
 * The compact brief injected at Claude Code session start.
 *
 * Hard-capped, because Claude Code truncates hook output at 10,000 characters
 * and because spending a session's context on history the model may not need
 * is exactly the wrong trade. This is the "here is where you are" summary;
 * anything deeper is available on request through the MCP tools.
 */
export const SESSION_CONTEXT_MAX_CHARS = 4_000;

/** Claude Code's documented cap on any single hook output string. */
export const HOOK_OUTPUT_MAX_CHARS = 10_000;

export function renderSessionContext(
  brief: ResumeBrief,
  options: { machineName?: string; maxChars?: number } = {},
): string {
  const limit = Math.min(options.maxChars ?? SESSION_CONTEXT_MAX_CHARS, HOOK_OUTPUT_MAX_CHARS);
  const { project } = brief;
  const lines: string[] = ['# Project Brain', ''];

  lines.push(`Project: ${project.name}`);
  if (project.description) lines.push(`About: ${project.description}`);
  if (options.machineName) lines.push(`Machine: ${options.machineName}`);

  const branch = brief.hereLocation?.branch;
  if (branch) lines.push(`Branch: ${branch}`);
  lines.push(`Last activity: ${brief.lastActivityRelative}`);
  if (project.status !== 'active') lines.push(`Status: ${project.status}`);

  const sections: [string, string[]][] = [
    ['Current focus', brief.currentFocus ? [brief.currentFocus] : []],
    ['Recently completed', brief.recentlyCompleted.slice(0, 4)],
    ['Open blockers', brief.blockers.slice(0, 3)],
    ['Next', brief.nextActions.slice(0, 5)],
  ];

  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    lines.push('', `## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  }

  if (brief.deployments.length > 0) {
    lines.push('', '## Deployed');
    for (const deployment of brief.deployments.slice(0, 3)) {
      const target = deployment.remote?.ssh_alias ?? deployment.remote?.name ?? 'unknown host';
      lines.push(`- ${deployment.environment}: ${target}${deployment.path ? ` ${deployment.path}` : ''}`);
    }
  }

  lines.push(
    '',
    'Use the project-brain MCP tools for more detail, or to record a checkpoint, decision or next action.',
  );

  return capText(lines.join('\n'), limit);
}

/**
 * Truncate at a line boundary and say so.
 *
 * Cutting mid-sentence would leave the model reading a fragment as if it were
 * complete; an explicit marker tells it that more exists and can be fetched.
 */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const notice = '\n\n[truncated - ask Project Brain for more]';
  const budget = maxChars - notice.length;
  const cut = text.slice(0, Math.max(0, budget));
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > budget * 0.5 ? cut.slice(0, lastBreak) : cut}${notice}`;
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export interface RecentEntry {
  project: Project;
  timestamp: Timestamp;
  /** What we actually know happened, in one line. */
  summary: string;
  source: 'checkpoint' | 'activity';
  checkpoint: Checkpoint | null;
}

/**
 * The feed behind `pb recent`.
 *
 * Checkpoints are preferred because they say *what* happened. A project with
 * no checkpoint still appears, with its recorded activity time and an honest
 * "no checkpoint yet" rather than an invented summary.
 */
export async function buildRecent(
  store: Store,
  projects: readonly Project[],
  options: { limit?: number; since?: Timestamp } = {},
): Promise<RecentEntry[]> {
  const limit = options.limit ?? 20;
  const entries: RecentEntry[] = [];

  await Promise.all(
    projects.map(async (project) => {
      const checkpoints = await store.listCheckpoints(project.id, { limit: 1 });
      const checkpoint = checkpoints[0];

      if (checkpoint) {
        entries.push({
          project,
          timestamp: checkpoint.meta.timestamp,
          summary: firstLine(checkpoint.summary) || 'checkpoint recorded',
          source: 'checkpoint',
          checkpoint,
        });
        return;
      }

      const activity = latest(
        project.last_activity_at,
        ...project.local_locations.map((location) => location.last_seen_at),
      );
      if (!activity) return;

      entries.push({
        project,
        timestamp: activity,
        summary: project.current_focus ?? 'no checkpoint yet',
        source: 'activity',
        checkpoint: null,
      });
    }),
  );

  return entries
    .filter((entry) => !options.since || entry.timestamp >= options.since)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function latest(...values: (Timestamp | null | undefined)[]): Timestamp | null {
  let best: Timestamp | null = null;
  for (const value of values) {
    if (!value) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function collectRecent(
  checkpoints: readonly Checkpoint[],
  pick: (checkpoint: Checkpoint) => string[],
  limit: number,
): string[] {
  const collected: string[] = [];
  for (const checkpoint of checkpoints) {
    for (const item of pick(checkpoint)) {
      collected.push(item);
      if (collected.length >= limit) return dedupe(collected);
    }
  }
  return dedupe(collected);
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function sectionText(sections: Map<string, string>, name: string): string | null {
  const value = sections.get(name);
  if (!value) return null;
  const text = value.replace(/^[-*+]\s*/gm, '').trim();
  return text === '' ? null : firstLine(text);
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

/** Path as the user would type it, with their home collapsed to `~`. */
export function displayPath(path: string): string {
  return contractHome(path);
}
