import type { Store } from '../storage/store.js';
import {
  CheckpointMetaSchema,
  type Checkpoint,
  type CheckpointMeta,
  type Project,
} from '../core/schema.js';
import { readRepoFull, type FullRepoInfo } from '../git/repo.js';
import { randomId } from '../util/ids.js';
import { now, parseTimestamp, type Timestamp } from '../util/time.js';
import { redactSecrets } from '../security/redact.js';

export interface CheckpointContent {
  /** One or two sentences: what changed and why it mattered. */
  summary?: string;
  completed?: string[];
  decisions?: string[];
  blockers?: string[];
  next?: string[];
  tags?: string[];
}

export interface CreateCheckpointOptions {
  machineId: string;
  source: CheckpointMeta['source'];
  /** Working tree to read git state from. Skipped when absent. */
  repoPath?: string;
  sessionId?: string;
  /** Pre-read git state, to avoid a second read on a latency-sensitive path. */
  repo?: FullRepoInfo | null;
  timestamp?: Timestamp;
}

export interface CreateCheckpointResult {
  meta: CheckpointMeta;
  filePath: string;
  body: string;
  /** Number of values the secret scanner removed before writing. */
  redactions: number;
}

/**
 * Write a checkpoint.
 *
 * Content is optional. With none, this is the "safe metadata" mode from the
 * brief: branch, commit, dirtiness and file counts, captured with no model
 * involved and no possibility of an API bill. With content, it is the rich
 * checkpoint a coding agent or the user wrote.
 *
 * Everything passed in is run through the secret scanner first. A summary is
 * prose written about a working session, and prose about a working session is
 * exactly where a pasted token ends up.
 */
export async function createCheckpoint(
  store: Store,
  project: Project,
  content: CheckpointContent,
  options: CreateCheckpointOptions,
): Promise<CreateCheckpointResult> {
  const timestamp = options.timestamp ?? now();
  const repo =
    options.repo !== undefined
      ? options.repo
      : options.repoPath
        ? await readRepoFull(options.repoPath, { changedFileLimit: 25 })
        : null;

  const redaction = redactCheckpointContent(content);

  const meta = CheckpointMetaSchema.parse({
    id: randomId('cp', 8),
    project_id: project.id,
    timestamp,
    machine_id: options.machineId,
    source: options.source,
    mode: hasNarrative(redaction.content) ? 'smart' : 'metadata',
    branch: repo?.branch ?? null,
    commit: repo?.lastCommit?.sha ?? repo?.head ?? null,
    dirty: repo?.dirty ?? null,
    changed_files: repo ? repo.stagedCount + repo.modifiedCount + repo.untrackedCount : null,
    tags: redaction.content.tags ?? [],
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  });

  const body = renderCheckpointBody(redaction.content, repo);
  const filePath = await store.writeCheckpoint(meta, body);

  return { meta, filePath, body, redactions: redaction.count };
}

function hasNarrative(content: CheckpointContent): boolean {
  return Boolean(
    content.summary?.trim() ||
      content.completed?.length ||
      content.decisions?.length ||
      content.blockers?.length ||
      content.next?.length,
  );
}

function redactCheckpointContent(content: CheckpointContent): {
  content: CheckpointContent;
  count: number;
} {
  let count = 0;

  const scrubOne = (value: string): string => {
    const result = redactSecrets(value);
    count += result.findings.length;
    return result.text;
  };
  const scrubMany = (values: string[] | undefined): string[] | undefined =>
    values?.map(scrubOne);

  return {
    content: {
      ...(content.summary !== undefined ? { summary: scrubOne(content.summary) } : {}),
      ...(content.completed !== undefined ? { completed: scrubMany(content.completed)! } : {}),
      ...(content.decisions !== undefined ? { decisions: scrubMany(content.decisions)! } : {}),
      ...(content.blockers !== undefined ? { blockers: scrubMany(content.blockers)! } : {}),
      ...(content.next !== undefined ? { next: scrubMany(content.next)! } : {}),
      ...(content.tags !== undefined ? { tags: content.tags } : {}),
    },
    count,
  };
}

/**
 * The prose body of a checkpoint.
 *
 * Section headings are fixed so they can be parsed back out, but the file
 * stays an ordinary markdown document a person can read, edit and diff.
 */
export function renderCheckpointBody(
  content: CheckpointContent,
  repo: FullRepoInfo | null,
): string {
  const lines: string[] = [];

  lines.push('# Summary', '');
  lines.push(content.summary?.trim() || describeMetadataOnly(repo));

  const sections: [string, string[] | undefined][] = [
    ['Completed', content.completed],
    ['Decisions', content.decisions],
    ['Blockers', content.blockers],
    ['Next', content.next],
  ];

  for (const [title, items] of sections) {
    if (!items || items.length === 0) continue;
    lines.push('', `# ${title}`, '');
    for (const item of items) lines.push(`- ${item}`);
  }

  if (repo) {
    lines.push('', '# Repository', '');
    if (repo.branch) lines.push(`- branch: ${repo.branch}`);
    if (repo.lastCommit) {
      lines.push(`- commit: ${repo.lastCommit.shortSha} ${repo.lastCommit.subject}`);
    }
    lines.push(
      `- working tree: ${repo.dirty ? 'has uncommitted changes' : 'clean'}` +
        (repo.dirty
          ? ` (${repo.stagedCount} staged, ${repo.modifiedCount} modified, ${repo.untrackedCount} untracked)`
          : ''),
    );
    if (repo.changedFiles.length > 0) {
      const shown = repo.changedFiles.slice(0, 10);
      lines.push(`- changed: ${shown.join(', ')}`);
      if (repo.changedFiles.length > shown.length) {
        lines.push(`- (${repo.changedFiles.length - shown.length} more changed files not listed)`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * The summary line for a checkpoint nobody wrote prose for.
 *
 * Deliberately states only what was observed. "Updated files" would be worse
 * than useless in six months; "working tree had 8 uncommitted changes on
 * phase-7" at least tells the reader where things stood.
 */
function describeMetadataOnly(repo: FullRepoInfo | null): string {
  if (!repo) return 'Activity recorded. No repository state was available.';

  const parts: string[] = [];
  if (repo.branch) parts.push(`on ${repo.branch}`);
  if (repo.lastCommit) parts.push(`at ${repo.lastCommit.shortSha}`);

  const changed = repo.stagedCount + repo.modifiedCount + repo.untrackedCount;
  const state = repo.dirty
    ? `${changed} uncommitted change${changed === 1 ? '' : 's'}`
    : 'a clean working tree';

  return `Automatic checkpoint ${parts.join(' ')} with ${state}. No summary was written for this session.`;
}

// ---------------------------------------------------------------------------
// Deciding whether a checkpoint is worth writing
// ---------------------------------------------------------------------------

export interface MeaningfulnessInput {
  /** The most recent checkpoint for this project, if any. */
  lastCheckpoint: Checkpoint | null;
  repo: FullRepoInfo | null;
  /** Minimum gap between automatic checkpoints. */
  minIntervalMinutes: number;
  now?: Date;
  /** Explicit user request always wins. */
  forced?: boolean;
}

export interface Meaningfulness {
  worthwhile: boolean;
  reason: string;
}

/**
 * Should an automatic checkpoint be written?
 *
 * The brief is explicit that a checkpoint after every tool call produces
 * useless memory. Two guards: enough time must have passed, and something must
 * actually have changed since last time. A session where nothing moved
 * produces no file, which keeps the history worth reading.
 */
export function isCheckpointWorthwhile(input: MeaningfulnessInput): Meaningfulness {
  if (input.forced) return { worthwhile: true, reason: 'explicitly requested' };

  const { lastCheckpoint, repo } = input;
  const reference = input.now ?? new Date();

  if (!lastCheckpoint) {
    return repo?.dirty || repo?.lastCommit
      ? { worthwhile: true, reason: 'first checkpoint for this project' }
      : { worthwhile: false, reason: 'no repository activity to record yet' };
  }

  const previous = parseTimestamp(lastCheckpoint.meta.timestamp);
  if (previous) {
    const minutesSince = (reference.getTime() - previous.getTime()) / 60_000;
    if (minutesSince < input.minIntervalMinutes) {
      return {
        worthwhile: false,
        reason: `last checkpoint was ${Math.round(minutesSince)} minutes ago (minimum gap is ${input.minIntervalMinutes})`,
      };
    }
  }

  if (repo) {
    const commitChanged =
      (repo.lastCommit?.sha ?? repo.head) !== null &&
      (repo.lastCommit?.sha ?? repo.head) !== lastCheckpoint.meta.commit;
    if (commitChanged) return { worthwhile: true, reason: 'new commits since the last checkpoint' };

    const changed = repo.stagedCount + repo.modifiedCount + repo.untrackedCount;
    if (changed !== (lastCheckpoint.meta.changed_files ?? 0)) {
      return { worthwhile: true, reason: 'the working tree changed since the last checkpoint' };
    }
    if (repo.branch !== lastCheckpoint.meta.branch) {
      return { worthwhile: true, reason: 'the branch changed since the last checkpoint' };
    }
  }

  return { worthwhile: false, reason: 'nothing changed since the last checkpoint' };
}
