import { readdir, rm } from 'node:fs/promises';
import type { z } from 'zod';
import { basename, join } from 'node:path';
import type { ProfilePaths } from '../core/paths.js';
import {
  CheckpointMetaSchema,
  DecisionSchema,
  MachineSchema,
  ProfileSchema,
  ProjectSchema,
  SCHEMA_VERSION,
  TaskFileSchema,
  RemoteSchema,
  type Checkpoint,
  type CheckpointMeta,
  type Decision,
  type Machine,
  type Profile,
  type Project,
  type Remote,
  type TaskFile,
} from '../core/schema.js';
import { readYamlFile, writeYamlFile, type LoadIssue } from './yaml-file.js';
import type { RecordKind } from '../core/migrations.js';
import {
  extractListItems,
  extractSections,
  parseFrontmatter,
  serializeFrontmatter,
} from './frontmatter.js';
import { appendLine, ensureDir, readFileOrNull, writeFileAtomic } from '../util/fs-atomic.js';
import { errnoCode } from '../util/errors.js';
import type { Timestamp } from '../util/time.js';

/**
 * All reads and writes of one profile's data.
 *
 * Two behaviours are load-bearing:
 *
 * - Nothing here throws because a single file is unreadable. A corrupt
 *   checkpoint written by a crashed process must not make `pb projects`
 *   useless; issues are collected and surfaced by `pb doctor`.
 *
 * - Nothing here ever deletes data it could not parse. Unreadable files are
 *   reported and left exactly where they are.
 */
export class Store {
  private readonly issues: LoadIssue[] = [];

  constructor(readonly paths: ProfilePaths) {}

  /** Files that could not be read since this store was opened. */
  getIssues(): readonly LoadIssue[] {
    return this.issues;
  }

  private record(issue: LoadIssue | null): void {
    if (issue) this.issues.push(issue);
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async readProfile(): Promise<Profile | null> {
    const { value, issue } = await readYamlFile(this.paths.profileFile, ProfileSchema, 'profile');
    this.record(issue);
    return value;
  }

  async writeProfile(profile: Profile): Promise<Profile> {
    return writeYamlFile(this.paths.profileFile, ProfileSchema, profile);
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    const dirs = await listDirectories(this.paths.projectsDir);
    const projects = await Promise.all(dirs.map((dir) => this.readProjectAtDir(dir)));
    return projects.filter((project): project is Project => project !== null);
  }

  private async readProjectAtDir(dirName: string): Promise<Project | null> {
    const file = join(this.paths.projectsDir, dirName, 'project.yaml');
    const { value, issue } = await readYamlFile(file, ProjectSchema, 'project');
    this.record(issue);
    return value;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const { value, issue } = await readYamlFile(this.paths.projectFile(projectId), ProjectSchema, 'project');
    this.record(issue);
    return value;
  }

  async saveProject(project: Project): Promise<Project> {
    return writeYamlFile(this.paths.projectFile(project.id), ProjectSchema, {
      ...project,
      schema_version: project.schema_version ?? SCHEMA_VERSION,
    });
  }

  /**
   * Remove a project's registry entry.
   *
   * Checkpoints live in a separate tree and are kept unless `withHistory` is
   * explicitly set: forgetting where a project lives should not silently
   * destroy the record of what was done in it.
   */
  async deleteProject(projectId: string, options: { withHistory?: boolean } = {}): Promise<void> {
    await rm(this.paths.projectDir(projectId), { recursive: true, force: true });
    if (options.withHistory) {
      await rm(this.paths.checkpointDir(projectId), { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // Project state (state.md)
  // -------------------------------------------------------------------------

  async readState(projectId: string): Promise<string | null> {
    return readFileOrNull(this.paths.stateFile(projectId));
  }

  async writeState(projectId: string, markdown: string): Promise<void> {
    await writeFileAtomic(this.paths.stateFile(projectId), `${markdown.trimEnd()}\n`);
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  async readTasks(projectId: string): Promise<TaskFile> {
    const { value, issue } = await readYamlFile(this.paths.tasksFile(projectId), TaskFileSchema, 'tasks');
    this.record(issue);
    return value ?? { schema_version: SCHEMA_VERSION, project_id: projectId, tasks: [] };
  }

  async writeTasks(file: TaskFile): Promise<TaskFile> {
    return writeYamlFile(this.paths.tasksFile(file.project_id), TaskFileSchema, file);
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Decisions are appended to a single readable markdown file.
   *
   * Each entry carries its structured fields in an HTML comment: invisible
   * when the file is rendered, exact when it is parsed, and - because entries
   * are only ever appended and never rewritten - safe to resolve with git's
   * `union` merge driver when two machines record decisions independently.
   * See docs/architecture/sync.md.
   */
  async readDecisions(projectId: string): Promise<Decision[]> {
    const raw = await readFileOrNull(this.paths.decisionsFile(projectId));
    if (!raw) return [];
    const { decisions, issue } = parseDecisionsMarkdown(
      raw,
      projectId,
      this.paths.decisionsFile(projectId),
    );
    this.record(issue);
    return decisions;
  }

  async appendDecision(decision: Decision): Promise<void> {
    const file = this.paths.decisionsFile(decision.project_id);
    const existing = await readFileOrNull(file);
    if (existing === null) {
      await writeFileAtomic(file, decisionsHeader(decision.project_id));
    }
    await appendLine(file, renderDecision(decision));
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /**
   * Write a checkpoint.
   *
   * One checkpoint is one immutable file at a timestamped path, which is what
   * keeps concurrent Claude Code sessions and multiple machines from ever
   * contending for the same file.
   */
  async writeCheckpoint(meta: CheckpointMeta, body: string): Promise<string> {
    const validated = CheckpointMetaSchema.parse(meta);
    const file = this.paths.checkpointFile(validated.project_id, validated.timestamp, validated.id);
    await writeFileAtomic(file, serializeFrontmatter(validated as Record<string, unknown>, body));
    return file;
  }

  /**
   * Read checkpoints for a project, newest first.
   *
   * The date-sharded directory layout is walked newest-shard-first and stops as
   * soon as `limit` files have been read, so "show me the last 5 checkpoints"
   * costs five file reads rather than a full history scan.
   */
  async listCheckpoints(
    projectId: string,
    options: { limit?: number; since?: Timestamp } = {},
  ): Promise<Checkpoint[]> {
    const files = await this.listCheckpointFiles(projectId, options);
    const checkpoints: Checkpoint[] = [];

    for (const file of files) {
      const checkpoint = await this.readCheckpointFile(file);
      if (!checkpoint) continue;
      if (options.since && checkpoint.meta.timestamp < options.since) continue;
      checkpoints.push(checkpoint);
      if (options.limit && checkpoints.length >= options.limit) break;
    }

    return checkpoints;
  }

  /** Checkpoint file paths for a project, newest first. */
  async listCheckpointFiles(
    projectId: string,
    options: { since?: Timestamp } = {},
  ): Promise<string[]> {
    const root = this.paths.checkpointDir(projectId);
    const sinceYmd = options.since ? options.since.slice(0, 10).split('-') : null;

    const years = await listDirectories(root);
    const files: string[] = [];

    for (const year of years.sort().reverse()) {
      if (sinceYmd && year < sinceYmd[0]!) break;
      const months = await listDirectories(join(root, year));
      for (const month of months.sort().reverse()) {
        if (sinceYmd && year === sinceYmd[0] && month < sinceYmd[1]!) break;
        const days = await listDirectories(join(root, year, month));
        for (const day of days.sort().reverse()) {
          if (sinceYmd && year === sinceYmd[0] && month === sinceYmd[1] && day < sinceYmd[2]!) break;
          const dayFiles = await listFiles(join(root, year, month, day), '.md');
          for (const file of dayFiles.sort().reverse()) {
            files.push(join(root, year, month, day, file));
          }
        }
      }
    }

    return files;
  }

  async readCheckpointFile(filePath: string): Promise<Checkpoint | null> {
    const raw = await readFileOrNull(filePath);
    if (raw === null) return null;

    const { data, body, error } = parseFrontmatter(raw);
    if (error) {
      this.record({ filePath, reason: error });
      return null;
    }

    const parsed = CheckpointMetaSchema.safeParse(data);
    if (!parsed.success) {
      this.record({
        filePath,
        reason: `checkpoint frontmatter is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      });
      return null;
    }

    const sections = extractSections(body);
    return {
      meta: parsed.data,
      body,
      summary: sections.get('summary') ?? firstParagraph(body),
      completed: extractListItems(sections.get('completed')),
      decisions: extractListItems(sections.get('decisions')),
      blockers: extractListItems(sections.get('blockers')),
      next: extractListItems(sections.get('next')),
      filePath,
    };
  }

  /** Every checkpoint across every project, newest first. Used by `pb recent`. */
  async listAllCheckpointFiles(): Promise<{ projectId: string; files: string[] }[]> {
    const projectDirs = await listDirectories(this.paths.checkpointsDir);
    return Promise.all(
      projectDirs.map(async (projectId) => ({
        projectId,
        files: await this.listCheckpointFiles(projectId),
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Machines and remotes
  // -------------------------------------------------------------------------

  async listMachines(): Promise<Machine[]> {
    return this.readAllYaml(this.paths.machinesDir, MachineSchema, 'machine');
  }

  async getMachine(machineId: string): Promise<Machine | null> {
    const { value, issue } = await readYamlFile(this.paths.machineFile(machineId), MachineSchema, 'machine');
    this.record(issue);
    return value;
  }

  async saveMachine(machine: Machine): Promise<Machine> {
    return writeYamlFile(this.paths.machineFile(machine.id), MachineSchema, machine);
  }

  async listRemotes(): Promise<Remote[]> {
    return this.readAllYaml(this.paths.remotesDir, RemoteSchema, 'remote');
  }

  async getRemote(remoteId: string): Promise<Remote | null> {
    const { value, issue } = await readYamlFile(this.paths.remoteFile(remoteId), RemoteSchema, 'remote');
    this.record(issue);
    return value;
  }

  async saveRemote(remote: Remote): Promise<Remote> {
    return writeYamlFile(this.paths.remoteFile(remote.id), RemoteSchema, remote);
  }

  async deleteRemote(remoteId: string): Promise<void> {
    await rm(this.paths.remoteFile(remoteId), { force: true });
  }

  private async readAllYaml<S extends z.ZodType<object>>(
    dir: string,
    schema: S,
    kind: RecordKind,
  ): Promise<z.infer<S>[]> {
    const names = await listFiles(dir, '.yaml');
    const records = await Promise.all(
      names.map(async (name) => {
        const { value, issue } = await readYamlFile(join(dir, name), schema, kind);
        this.record(issue);
        return value;
      }),
    );

    const loaded: z.infer<S>[] = [];
    for (const record of records) {
      if (record !== null) loaded.push(record as z.infer<S>);
    }
    return loaded;
  }

  /** Create the directory skeleton for this profile. */
  async ensureLayout(): Promise<void> {
    await Promise.all([
      ensureDir(this.paths.root),
      ensureDir(this.paths.projectsDir),
      ensureDir(this.paths.machinesDir),
      ensureDir(this.paths.remotesDir),
      ensureDir(this.paths.checkpointsDir),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Decision markdown
// ---------------------------------------------------------------------------

const DECISION_MARKER = 'pb-decision:';

function decisionsHeader(projectId: string): string {
  return [
    '# Decisions',
    '',
    `<!-- Project Brain appends one \`##\` block per decision for project ${projectId}.`,
    '     The HTML comment under each heading holds the structured fields;',
    '     everything else is yours to edit. Entries are never rewritten. -->',
    '',
    '',
  ].join('\n');
}

export function renderDecision(decision: Decision): string {
  const meta = JSON.stringify({
    id: decision.id,
    project_id: decision.project_id,
    timestamp: decision.timestamp,
    machine_id: decision.machine_id,
    tags: decision.tags,
    superseded_by: decision.superseded_by ?? null,
  });

  const lines = [`## ${decision.title}`, `<!-- ${DECISION_MARKER} ${meta} -->`, ''];
  if (decision.reason) lines.push(decision.reason.trim(), '');
  if (decision.alternatives.length > 0) {
    lines.push('**Considered instead:**');
    for (const alternative of decision.alternatives) lines.push(`- ${alternative}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function parseDecisionsMarkdown(
  raw: string,
  projectId: string,
  filePath: string,
): { decisions: Decision[]; issue: LoadIssue | null } {
  const decisions: Decision[] = [];
  let malformed = 0;

  // Split on `## ` headings at the start of a line.
  const blocks = raw.split(/\n(?=##\s)/);
  for (const block of blocks) {
    const headingMatch = /^##\s+(.+?)\s*$/m.exec(block);
    if (!headingMatch) continue;

    const metaMatch = new RegExp(`<!--\\s*${DECISION_MARKER}\\s*(\\{.*?\\})\\s*-->`, 's').exec(block);
    if (!metaMatch) {
      // A heading a human added by hand. Not an error - just not a record.
      continue;
    }

    let meta: unknown;
    try {
      meta = JSON.parse(metaMatch[1]!);
    } catch {
      malformed++;
      continue;
    }

    const body = block
      .slice(metaMatch.index + metaMatch[0].length)
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const alternatives = extractListItems(
      /\*\*Considered instead:\*\*([\s\S]*)$/.exec(body)?.[1] ?? '',
    );
    const reason = body.replace(/\*\*Considered instead:\*\*[\s\S]*$/, '').trim();

    const candidate = {
      ...(meta as Record<string, unknown>),
      project_id: (meta as Record<string, unknown>).project_id ?? projectId,
      title: headingMatch[1]!,
      reason: reason === '' ? undefined : reason,
      alternatives,
    };

    const parsed = DecisionSchema.safeParse(candidate);
    if (parsed.success) decisions.push(parsed.data);
    else malformed++;
  }

  decisions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    decisions,
    issue:
      malformed > 0
        ? { filePath, reason: `${malformed} decision entr${malformed === 1 ? 'y' : 'ies'} could not be parsed` }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
}

export async function listFiles(dir: string, extension?: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && (!extension || name.endsWith(extension)));
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
}

function firstParagraph(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';
  const paragraph = trimmed.split(/\n\s*\n/)[0] ?? '';
  return paragraph.replace(/^#+\s*/gm, '').trim();
}

/** Exported for `pb doctor`, which reports the basename of an unreadable file. */
export function issueLabel(issue: LoadIssue): string {
  return `${basename(issue.filePath)}: ${issue.reason}`;
}
