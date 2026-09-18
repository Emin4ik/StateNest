import { z } from 'zod';

/**
 * Persisted data schemas.
 *
 * Two rules govern everything in this file:
 *
 * 1. Every persisted record uses `z.looseObject`, so fields written by a newer
 *    version of Project Brain survive a round-trip through an older one. A
 *    developer syncing one data repo between an up-to-date laptop and a
 *    lagging workstation must never lose data to the older machine rewriting
 *    a file it only partly understands.
 *
 * 2. Nothing here has a field for a credential. There is no `password`, no
 *    `token`, no `private_key`. The schema itself is the enforcement: a secret
 *    has nowhere to go.
 */

export const SCHEMA_VERSION = 1;

/** UTC ISO-8601, second precision, trailing Z. See util/time.ts. */
export const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'expected UTC ISO-8601 like 2026-09-17T18:54:30Z');

const IdSchema = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const MachineTypeSchema = z.enum([
  'laptop',
  'desktop',
  'server',
  'container',
  'vm',
  'unknown',
]);

export const MachineSchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  id: IdSchema,
  name: z.string().min(1),
  type: MachineTypeSchema.default('unknown'),
  os: z.enum(['macos', 'linux', 'windows', 'wsl', 'unknown']).default('unknown'),
  os_release: z.string().optional(),
  hostname: z.string().optional(),
  architecture: z.string().optional(),
  /** Home directory on this machine, used to render paths portably. */
  home_dir: z.string().optional(),
  first_seen_at: TimestampSchema,
  last_seen_at: TimestampSchema,
  notes: z.string().optional(),
});

export type Machine = z.infer<typeof MachineSchema>;

// ---------------------------------------------------------------------------
// Remote environments (VPS, dev servers)
// ---------------------------------------------------------------------------

export const RemoteTypeSchema = z.enum([
  'vps',
  'dedicated',
  'cloud-instance',
  'container-host',
  'shared-hosting',
  'raspberry-pi',
  'other',
]);

export const EnvironmentSchema = z.enum([
  'production',
  'staging',
  'development',
  'testing',
  'other',
]);

/**
 * A remote machine the developer deploys to.
 *
 * Authentication is intentionally absent. Project Brain records *which* host a
 * project runs on and how it is addressed; connecting to it stays the job of
 * the user's existing SSH configuration and agent. There is no field here that
 * could hold a password or a key, so there is no way for one to be stored,
 * synced, or leaked.
 */
export const RemoteSchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  id: IdSchema,
  name: z.string().min(1),
  type: RemoteTypeSchema.default('vps'),
  environment: EnvironmentSchema.default('production'),
  /** Preferred way to reach the host: an alias from the user's ~/.ssh/config. */
  ssh_alias: z.string().optional(),
  /** Hostname or IP. Optional - an ssh alias alone is often enough. */
  host: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  provider: z.string().optional(),
  region: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

export type Remote = z.infer<typeof RemoteSchema>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const ProjectStatusSchema = z.enum(['active', 'paused', 'waiting', 'archived']);

/**
 * Status is always a human decision. Project Brain reports recency separately
 * ("active, last touched 42 days ago") rather than silently archiving things
 * on the user's behalf.
 */
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const RepositorySchema = z.looseObject({
  /** Canonical cross-machine identity, e.g. `github.com/acme/widget`. */
  identity: z.string().min(1),
  /** Sanitized remote URL - credentials are removed before this is written. */
  url: z.string().optional(),
  host: z.string().optional(),
  /** Lowercased owner/name path, e.g. `acme/widget`. Searchable. */
  path: z.string().optional(),
  owner: z.string().nullable().optional(),
  name: z.string().optional(),
  web_url: z.string().nullable().optional(),
  default_branch: z.string().optional(),
  /**
   * Identities this repository was previously known by, oldest first.
   *
   * Written when a remote changes under an already-recorded project - a
   * repository transferred to a new owner, or moved to a different host. The
   * project keeps its id so its history survives, and the old identity is kept
   * so `pb doctor` can explain a duplicate that arrives through sync from a
   * machine that only ever saw one of the two.
   */
  previous_identities: z.array(z.string()).default([]),
});

export const ProjectLocationSchema = z.looseObject({
  machine_id: IdSchema,
  path: z.string().min(1),
  /** Git worktrees are another location of the same project, not a new project. */
  is_worktree: z.boolean().default(false),
  /** Path of the main worktree this one belongs to, when known. */
  worktree_of: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
  dirty: z.boolean().nullable().optional(),
  last_seen_at: TimestampSchema,
  /** Set when the path no longer exists, rather than deleting the record. */
  missing_since: TimestampSchema.nullable().optional(),
});

export const DeploymentSchema = z.looseObject({
  id: IdSchema,
  remote_id: IdSchema,
  environment: EnvironmentSchema.default('production'),
  /** Filesystem path on the remote host. */
  path: z.string().optional(),
  branch: z.string().optional(),
  /** Service manager unit, pm2 name, container name - whatever runs it. */
  service: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
  updated_at: TimestampSchema,
});

export const ProjectTypeSchema = z.enum([
  'node',
  'python',
  'go',
  'rust',
  'java',
  'dotnet',
  'ruby',
  'php',
  'swift',
  'cpp',
  'docker',
  'terraform',
  'unity',
  'docs',
  'monorepo',
  'unknown',
]);

export const ProjectSchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  id: IdSchema,
  /** Display name. Never identity - projects get renamed. */
  name: z.string().min(1),
  description: z.string().optional(),
  /** Extra names `pb show <term>` should resolve. */
  aliases: z.array(z.string()).default([]),
  type: ProjectTypeSchema.default('unknown'),
  status: ProjectStatusSchema.default('active'),
  tags: z.array(z.string()).default([]),

  created_at: TimestampSchema,
  discovered_at: TimestampSchema,
  /** Most recent evidence of work, from any signal. See discovery/activity.ts. */
  last_activity_at: TimestampSchema.nullable().optional(),
  last_checkpoint_at: TimestampSchema.nullable().optional(),

  repository: RepositorySchema.nullable().optional(),
  local_locations: z.array(ProjectLocationSchema).default([]),
  deployments: z.array(DeploymentSchema).default([]),

  /** One line: what is being worked on right now. */
  current_focus: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectLocation = z.infer<typeof ProjectLocationSchema>;
export type Deployment = z.infer<typeof DeploymentSchema>;
export type Repository = z.infer<typeof RepositorySchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);

export const TaskSchema = z.looseObject({
  id: IdSchema,
  text: z.string().min(1),
  status: TaskStatusSchema.default('todo'),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  completed_at: TimestampSchema.nullable().optional(),
  /** Free-form reason, shown when the task is blocked. */
  blocked_reason: z.string().optional(),
  tags: z.array(z.string()).default([]),
  source: z.enum(['manual', 'claude-code', 'import']).default('manual'),
});

export const TaskFileSchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  project_id: IdSchema,
  tasks: z.array(TaskSchema).default([]),
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskFile = z.infer<typeof TaskFileSchema>;

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export const CheckpointSourceSchema = z.enum([
  'manual',
  'cli',
  'claude-code',
  'session-end',
  'pre-compact',
  'post-compact',
  'import',
]);

export const CheckpointModeSchema = z.enum(['metadata', 'smart']);

/**
 * The YAML frontmatter of a checkpoint file. The prose body below it is the
 * part a human reads; this is the part queries run against.
 */
export const CheckpointMetaSchema = z.looseObject({
  id: IdSchema,
  project_id: IdSchema,
  timestamp: TimestampSchema,
  machine_id: IdSchema,
  source: CheckpointSourceSchema.default('manual'),
  mode: CheckpointModeSchema.default('metadata'),
  branch: z.string().nullable().optional(),
  commit: z.string().nullable().optional(),
  dirty: z.boolean().nullable().optional(),
  changed_files: z.number().int().nonnegative().nullable().optional(),
  /** Commits made on this machine since the previous checkpoint. */
  commits_since_last: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.string()).default([]),
  /** Opaque id of the coding session that produced this, when there was one. */
  session_id: z.string().optional(),
});

export type CheckpointMeta = z.infer<typeof CheckpointMetaSchema>;

/** A parsed checkpoint: frontmatter, prose body, and the sections we extract. */
export interface Checkpoint {
  meta: CheckpointMeta;
  /** Raw markdown body, everything after the frontmatter. */
  body: string;
  summary: string;
  completed: string[];
  decisions: string[];
  blockers: string[];
  next: string[];
  /** Absolute path on disk, for diagnostics and `pb doctor`. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const DecisionSchema = z.looseObject({
  id: IdSchema,
  project_id: IdSchema,
  timestamp: TimestampSchema,
  machine_id: IdSchema.optional(),
  title: z.string().min(1),
  /** Why the decision was made - the part git history never records. */
  reason: z.string().optional(),
  /** What was considered and rejected. */
  alternatives: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Set when a later decision supersedes this one; the record is kept. */
  superseded_by: IdSchema.nullable().optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;

// ---------------------------------------------------------------------------
// Profiles and configuration
// ---------------------------------------------------------------------------

export const PrivacyLevelSchema = z.enum(['strict', 'balanced', 'open']);

export const SyncConfigSchema = z.looseObject({
  enabled: z.boolean().default(false),
  /** Git remote of the user's PRIVATE data repository. Never the app's repo. */
  remote: z.string().optional(),
  branch: z.string().default('main'),
  /** Push automatically after a checkpoint. Never blocks the caller. */
  auto_push: z.boolean().default(false),
  auto_pull: z.boolean().default(true),
  last_sync_at: TimestampSchema.nullable().optional(),
});

export const ProfileSchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'profile names are lowercase, digits and dashes'),
  description: z.string().optional(),
  /** Directories scanned by `pb scan` when none are given. */
  project_roots: z.array(z.string()).default([]),
  privacy: PrivacyLevelSchema.default('balanced'),
  sync: SyncConfigSchema.prefault({}),
  created_at: TimestampSchema,
});

export type Profile = z.infer<typeof ProfileSchema>;
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

export const DiscoveryModeSchema = z.enum(['auto', 'ask', 'manual']);

export const ConfigSchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  /** Profile used when no --profile flag and no directory-based match applies. */
  default_profile: z.string().default('personal'),
  discovery: z
    .looseObject({
      mode: DiscoveryModeSchema.default('ask'),
      /** Directory names never descended into during a scan. */
      exclude: z.array(z.string()).default([]),
      max_depth: z.number().int().min(1).max(32).default(8),
    })
    .prefault({}),
  checkpoint: z
    .looseObject({
      mode: z.enum(['metadata', 'smart', 'manual-smart']).default('manual-smart'),
      /** Minimum gap between automatic checkpoints, in minutes. */
      min_interval_minutes: z.number().int().min(0).default(30),
    })
    .prefault({}),
  dashboard: z
    .looseObject({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(7777),
    })
    .prefault({}),
  log: z
    .looseObject({
      level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
      max_size_kb: z.number().int().positive().default(2048),
    })
    .prefault({}),
  telemetry: z
    .looseObject({
      // Off, and there is no code that would turn it on. See docs/privacy.md.
      enabled: z.literal(false).default(false),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Machine-local identity (never synced)
// ---------------------------------------------------------------------------

/**
 * Written to `~/.project-brain/machine.json`, outside every profile directory
 * so it can never be committed to a data repository. It answers exactly one
 * question: which machine is this?
 */
export const LocalMachineIdentitySchema = z.looseObject({
  schema_version: z.number().int().positive().default(SCHEMA_VERSION),
  machine_id: IdSchema,
  created_at: TimestampSchema,
});

export type LocalMachineIdentity = z.infer<typeof LocalMachineIdentitySchema>;
