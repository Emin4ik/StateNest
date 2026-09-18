import { Workspace } from '../../core/workspace.js';
import { Registry } from '../../core/registry.js';
import { buildResumeBrief, renderSessionContext } from '../../core/context.js';
import { appendLine } from '../../util/fs-atomic.js';
import { now } from '../../util/time.js';
import {
  buildHookResponse,
  parseHookInput,
  withDeadline,
  type HookEventName,
  type HookInput,
} from './protocol.js';
import {
  compactDigest,
  pruneSessionRecords,
  readSessionRecord,
  updateSessionRecord,
  type SessionRecord,
} from './session.js';

/**
 * The Claude Code hook entry point.
 *
 * Three rules govern this file, and every one of them exists because this code
 * runs inside somebody else's tool:
 *
 * 1. It always exits 0. Project Brain failing must never look like Claude Code
 *    failing. A crash here is logged and swallowed.
 *
 * 2. Every handler has a deadline. SessionStart delays the model's first
 *    response one-for-one, and a plugin's SessionEnd hook is killed at roughly
 *    1.5 seconds no matter what timeout it declares.
 *
 * 3. Nothing here writes to the user's source repository. It reads git state
 *    and writes only inside the Project Brain home.
 *
 * Checkpoint creation, full git reads and the secret scanner are imported
 * lazily. SessionStart is the only latency-sensitive handler and it needs none
 * of them; loading them eagerly cost about 20ms on every session start for
 * code that would not run.
 */

const DEADLINES = {
  'session-start': 2_500,
  stop: 8_000,
  'pre-compact': 5_000,
  'post-compact': 8_000,
  // Deliberately under Claude Code's ~1.5s plugin SessionEnd budget, so the
  // checkpoint is finished and flushed rather than killed half-written.
  'session-end': 1_200,
} as const;

type HandlerName = keyof typeof DEADLINES;

const EVENT_NAMES: Record<HandlerName, HookEventName> = {
  'session-start': 'SessionStart',
  stop: 'Stop',
  'pre-compact': 'PreCompact',
  'post-compact': 'PostCompact',
  'session-end': 'SessionEnd',
};

/**
 * Run one hook handler and return what should be written to stdout.
 *
 * Returns rather than writing or exiting, so the whole hook surface is
 * testable. `hook.ts` is the thin process entry that calls this.
 */
export async function runHook(handlerName: string, rawInput: string): Promise<string> {
  if (!handlerName || !(handlerName in DEADLINES)) {
    // Not an error worth surfacing: a stale hook config from an older version
    // must not spam the user.
    return '';
  }

  const handler = handlerName as HandlerName;
  const input = parseHookInput(rawInput);
  return withDeadline(runHandler(handler, input), DEADLINES[handler], '');
}

export { DEADLINES };

async function runHandler(handler: HandlerName, input: HookInput): Promise<string> {
  try {
    switch (handler) {
      case 'session-start':
        return await onSessionStart(input);
      case 'stop':
        return await onStop(input);
      case 'pre-compact':
        return await onPreCompact(input);
      case 'post-compact':
        return await onPostCompact(input);
      case 'session-end':
        return await onSessionEnd(input);
    }
  } catch (error) {
    await logFailure(handler, error);
    return '';
  }
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

/**
 * Inject a short brief about the project Claude has been opened in.
 *
 * Nothing here spawns a git process: repository state is read straight off the
 * filesystem, which is what keeps this in the low tens of milliseconds instead
 * of adding a visible pause before Claude's first reply.
 */
async function onSessionStart(input: HookInput): Promise<string> {
  const opened = await openWorkspaceQuietly();
  if (!opened) return '';
  const { workspace, registry } = opened;

  const cwd = input.cwd ?? process.cwd();
  const { project, repo, repoRoot } = await registry.identify(cwd, workspace.machineId);

  // Housekeeping that must never delay the session; failures are irrelevant.
  void pruneSessionRecords(workspace.paths).catch(() => {});

  if (input.session_id) {
    // SessionStart re-fires after /clear and after compaction, so an existing
    // session is updated rather than restarted - resetting it would discard the
    // turn count that decides whether the session did anything worth recording.
    await updateSessionRecord(workspace.paths, input.session_id, cwd, (record) =>
      record.turns > 0 || record.project_id !== null
        ? { ...record, last_activity_at: now(), cwd }
        : {
            ...record,
            cwd,
            last_activity_at: now(),
            project_id: project?.id ?? null,
            start_branch: repo?.branch ?? null,
            start_commit: repo?.head ?? null,
          },
    );
  }

  if (!project) {
    // An unregistered directory gets no injected context. Interrupting a
    // session to ask about registration would be exactly the kind of nagging
    // the tool is supposed to avoid; `pb add .` is there when the user wants it.
    return '';
  }

  // Record that this project was touched, without blocking the response.
  void registry
    .touchActivity(project.id, workspace.machineId, repoRoot ?? cwd, repo)
    .catch(() => {});

  const machine = await workspace.currentMachine();
  const brief = await buildResumeBrief(workspace.store, project, {
    machineId: workspace.machineId,
    checkpointLimit: 3,
  });

  const context = renderSessionContext(brief, {
    ...(machine?.name ? { machineName: machine.name } : {}),
  });

  return buildHookResponse('SessionStart', { additionalContext: context });
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Note that a turn happened.
 *
 * Stop fires constantly, so this writes one small machine-local file and never
 * a checkpoint. The hook is declared `async` in hooks.json, so it cannot block
 * the session even if the disk is slow.
 */
async function onStop(input: HookInput): Promise<string> {
  if (!input.session_id) return '';

  const opened = await openWorkspaceQuietly();
  if (!opened) return '';
  const { workspace, registry } = opened;

  const cwd = input.cwd ?? process.cwd();

  // Resolved outside the lock: identifying a project touches the filesystem,
  // and holding a lock across that would serialise unrelated sessions.
  const identified = await registry.identify(cwd, workspace.machineId);

  // The increment itself must be serialised. Without the lock every concurrent
  // Stop reads the same count and the last writer wins, losing the others.
  await updateSessionRecord(workspace.paths, input.session_id, cwd, (record) => ({
    ...record,
    project_id: record.project_id ?? identified.project?.id ?? null,
    turns: record.turns + 1,
    last_activity_at: now(),
    cwd,
  }));

  return '';
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Capture deterministic state just before context is compacted.
 *
 * This writes no checkpoint. It stashes where the repository stood so that
 * PostCompact - which is handed a model-written summary for free - can turn
 * both halves into one good checkpoint instead of two thin ones.
 */
async function onPreCompact(input: HookInput): Promise<string> {
  if (!input.session_id) return '';

  const opened = await openWorkspaceQuietly();
  if (!opened) return '';
  const { workspace, registry } = opened;

  const cwd = input.cwd ?? process.cwd();
  const { project, repoRoot } = await registry.identify(cwd, workspace.machineId);

  const readRepoFull = await loadGitFull();
  const repo = repoRoot
    ? await withDeadline(readRepoFull(repoRoot, { changedFileLimit: 25 }), 2_000, null)
    : null;

  await updateSessionRecord(workspace.paths, input.session_id, cwd, (record) => ({
    ...record,
    project_id: project?.id ?? record.project_id,
    last_activity_at: now(),
    pending_compact: {
      at: now(),
      branch: repo?.branch ?? null,
      commit: repo?.lastCommit?.sha ?? repo?.head ?? null,
      changed_files: repo ? repo.stagedCount + repo.modifiedCount + repo.untrackedCount : null,
    },
  }));

  return '';
}

/**
 * Write a checkpoint from the compaction summary.
 *
 * PostCompact receives `compact_summary`, a summary of the conversation that
 * Claude Code has already generated. Using it costs nothing extra and produces
 * a far better record than any metadata-only checkpoint could - and it arrives
 * at precisely the moment the session's own memory of the work is about to be
 * thrown away.
 *
 * It is run through the secret scanner first: a summary of a coding session is
 * exactly where a pasted token would show up.
 */
async function onPostCompact(input: HookInput): Promise<string> {
  const summary = input.compact_summary?.trim();
  if (!summary) return '';

  const opened = await openWorkspaceQuietly();
  if (!opened) return '';
  const { workspace, registry } = opened;

  const cwd = input.cwd ?? process.cwd();
  const digest = compactDigest(summary);
  const record = input.session_id
    ? await readSessionRecord(workspace.paths, input.session_id)
    : null;

  // Claude Code can deliver the same hook twice. Two *different* compactions in
  // one session should each be recorded, so the guard is the identity of this
  // compaction rather than "has this session been checkpointed".
  if (record?.last_compact_digest === digest) return '';

  const project = record?.project_id
    ? await registry.byId(record.project_id)
    : (await registry.identify(cwd, workspace.machineId)).project;
  if (!project) return '';

  const { repoRoot } = await registry.identify(cwd, workspace.machineId);
  const readRepoFull = await loadGitFull();
  const repo = repoRoot
    ? await withDeadline(readRepoFull(repoRoot, { changedFileLimit: 25 }), 3_000, null)
    : null;

  const condensed = await condenseSummary(summary);
  const { createCheckpoint } = await loadCheckpointing();

  await createCheckpoint(
    workspace.store,
    project,
    {
      summary: condensed.summary,
      completed: condensed.completed,
      next: condensed.next,
      blockers: condensed.blockers,
      tags: ['auto', 'compaction'],
    },
    {
      machineId: workspace.machineId,
      source: 'post-compact',
      repo,
      ...(input.session_id ? { sessionId: input.session_id } : {}),
    },
  );

  if (input.session_id) {
    await updateSessionRecord(workspace.paths, input.session_id, cwd, (current) => ({
      ...current,
      checkpointed: true,
      last_compact_digest: digest,
      pending_compact: null,
      last_activity_at: now(),
    }));
  }

  return '';
}

// ---------------------------------------------------------------------------
// SessionEnd
// ---------------------------------------------------------------------------

/**
 * Write a final checkpoint, but only if the session actually did something.
 *
 * Budget is roughly 1.2 seconds. Git state is read with its own short deadline
 * and the checkpoint falls back to metadata-only rather than being skipped, so
 * a slow repository costs detail rather than the whole record.
 */
async function onSessionEnd(input: HookInput): Promise<string> {
  if (!input.session_id) return '';

  const opened = await openWorkspaceQuietly();
  if (!opened) return '';
  const { workspace, registry } = opened;

  const record = await readSessionRecord(workspace.paths, input.session_id);
  if (!record || record.checkpointed) return '';

  // A session with no turns at all is someone opening Claude Code and closing
  // it again. There is nothing to remember.
  if (record.turns < 1) return '';

  const project = record.project_id ? await registry.byId(record.project_id) : null;
  if (!project) return '';

  const { repoRoot } = await registry.identify(record.cwd, workspace.machineId);
  const readRepoFull = await loadGitFull();
  const repo = repoRoot
    ? await withDeadline(readRepoFull(repoRoot, { changedFileLimit: 20 }), 500, null)
    : null;

  const { createCheckpoint, isCheckpointWorthwhile } = await loadCheckpointing();
  const [lastCheckpoint] = await workspace.store.listCheckpoints(project.id, { limit: 1 });
  const verdict = isCheckpointWorthwhile({
    lastCheckpoint: lastCheckpoint ?? null,
    repo,
    minIntervalMinutes: workspace.config.checkpoint.min_interval_minutes,
  });
  if (!verdict.worthwhile) return '';

  // Claim the session before writing. Taking the flag under the lock means a
  // duplicate SessionEnd - or one racing a trailing async Stop - cannot produce
  // a second checkpoint for the same session.
  const claimed = await updateSessionRecord(
    workspace.paths,
    input.session_id,
    record.cwd,
    (current) => (current.checkpointed ? current : { ...current, checkpointed: true }),
  );
  if (claimed.checkpointed && record.checkpointed) return '';

  await createCheckpoint(
    workspace.store,
    project,
    { tags: ['auto', 'session-end'] },
    {
      machineId: workspace.machineId,
      source: 'session-end',
      repo,
      sessionId: input.session_id,
    },
  );

  return '';
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Loaded on demand - see the note at the top of this file. */
async function loadCheckpointing() {
  return import('../../checkpoints/create.js');
}

async function loadGitFull() {
  return (await import('../../git/repo.js')).readRepoFull;
}

async function loadRedact() {
  return (await import('../../security/redact.js')).redactSecrets;
}

async function openWorkspaceQuietly(): Promise<{
  workspace: Workspace;
  registry: Registry;
} | null> {
  try {
    const workspace = await Workspace.open();
    return { workspace, registry: new Registry(workspace.store) };
  } catch {
    // Project Brain is not set up on this machine, or its home is unreadable.
    // Either way, staying silent is correct: the user did not invoke us.
    return null;
  }
}

/**
 * Reduce a compaction summary to something worth keeping.
 *
 * The summary Claude Code generates is written for the model and can run to
 * thousands of words. A checkpoint is read by a human months later, so this
 * keeps an opening paragraph and any bullet list of what was done, and drops
 * the rest. Everything is redacted before it is written.
 */
export async function condenseSummary(summary: string): Promise<{
  summary: string;
  completed: string[];
  next: string[];
  blockers: string[];
}> {
  // Redaction runs first, over the whole text, so a credential is removed
  // wherever it appears - not merely dropped by the condensing that follows.
  const redactSecrets = await loadRedact();
  const clean = redactSecrets(summary).text;

  const prose: string[] = [];
  const completed: string[] = [];
  const next: string[] = [];
  const blockers: string[] = [];
  let inCodeFence = false;
  let seenBullet = false;

  // Which bucket subsequent bullets belong to, driven by the last heading or
  // lead-in line seen. A compaction summary is written for a model, but it
  // still tends to group its content under recognisable labels.
  let bucket: 'completed' | 'next' | 'blockers' = 'completed';

  for (const rawLine of clean.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const line = rawLine.trim();
    if (line === '') continue;

    const label = /^#{0,6}\s*\**\s*([a-z][a-z \t-]{2,40})\**\s*:?\s*$/i.exec(line);
    if (label) {
      const detected = classifyLabel(label[1]!);
      if (detected) {
        bucket = detected;
        continue;
      }
    }

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(rawLine);
    if (bullet) {
      seenBullet = true;
      const text = bullet[1]!.replace(/^\[[ xX~-]\]\s*/, '').replace(/[*_`]/g, '').trim();
      if (text.length <= 3) continue;
      const target =
        bucket === 'next' ? next : bucket === 'blockers' ? blockers : completed;
      if (target.length < 10) target.push(text);
      continue;
    }

    const text = line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
    if (text === '') continue;

    // Prose after the bullets is usually the most valuable part of a summary -
    // the "still open" sentence that says what was not finished. Earlier this
    // was discarded, which threw away exactly what a resume brief needs.
    const inlineBucket = classifyLabel(text);
    if (seenBullet && inlineBucket && inlineBucket !== 'completed') {
      const stripped = text.replace(/^[^:]*:\s*/, '').trim();
      const target = inlineBucket === 'next' ? next : blockers;
      if (stripped !== '' && target.length < 10) target.push(stripped);
      continue;
    }

    if (!seenBullet && prose.length < 6) prose.push(text);
  }

  const paragraph = prose.join(' ').trim();
  return {
    summary:
      paragraph.length > 0
        ? truncateWords(paragraph, 600)
        : 'Context was compacted during a long working session.',
    completed,
    next,
    blockers,
  };
}

function classifyLabel(text: string): 'completed' | 'next' | 'blockers' | null {
  const value = text.toLowerCase();
  if (/\b(still open|remaining|next step|next|todo|to do|unfinished|outstanding|follow[- ]?up)\b/.test(value)) {
    return 'next';
  }
  if (/\b(blocked|blocker|blocking|stuck|problem|issue|failing)\b/.test(value)) {
    return 'blockers';
  }
  if (/\b(completed|done|accomplished|changes|work done|finished|implemented)\b/.test(value)) {
    return 'completed';
  }
  return null;
}

function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

/**
 * Record a hook failure where `pb doctor` can find it.
 *
 * Written to the Project Brain log, never to stderr: stderr from a hook is
 * shown to the user as an error in Claude Code, and a problem with this plugin
 * is not something the user should have to see mid-session.
 */
async function logFailure(handler: string, error: unknown): Promise<void> {
  try {
    const { createPaths } = await import('../../core/paths.js');
    const paths = createPaths();
    const redactSecrets = await loadRedact();
    const message = error instanceof Error ? error.message : String(error);
    await appendLine(
      paths.logFile,
      JSON.stringify({
        at: now(),
        level: 'error',
        source: 'claude-hook',
        handler,
        message: redactSecrets(message).text,
      }),
    );
  } catch {
    // If even logging fails there is nothing useful left to do.
  }
}



export { EVENT_NAMES, type SessionRecord };
