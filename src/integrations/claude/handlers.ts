import { Workspace } from '../../core/workspace.js';
import { Registry } from '../../core/registry.js';
import type { Project } from '../../core/schema.js';
import type { FastRepoInfo } from '../../git/repo.js';
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
 * 1. It always exits 0. StateNest failing must never look like Claude Code
 *    failing. A crash here is logged and swallowed.
 *
 * 2. Every handler has a deadline. SessionStart delays the model's first
 *    response one-for-one, and a plugin's SessionEnd hook is killed at roughly
 *    1.5 seconds no matter what timeout it declares.
 *
 * 3. Nothing here writes to the user's source repository. It reads git state
 *    and writes only inside the StateNest home.
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
  // Not a Claude Code event. This is the plugin re-invoking itself, detached,
  // to run a sync that a hook asked for and refused to wait around for. It has
  // no deadline because nobody is waiting on it.
  if (handlerName === 'auto-sync' || handlerName === 'auto-sync-now') {
    try {
      const { performAutoSync } = await import('../../sync/auto-sync.js');
      // `-now` is the session-start refresh: somebody is waiting a few hundred
      // milliseconds for it, so it skips the debounce that exists to coalesce
      // write bursts. Waiting 1.5s to start would have made the refresh budget
      // impossible to meet, and the wait pointless.
      await performAutoSync(
        handlerName === 'auto-sync-now' ? { debounceMs: 0, force: true } : {},
      );
    } catch (error) {
      await logFailure(handlerName, error);
    }
    return '';
  }

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
  const identified = await registry.identify(cwd, workspace.machineId);
  const { repo, repoRoot } = identified;

  // Register this repository if it is eligible and not yet known.
  //
  // This is what removes `statenest add .` from an ordinary day. It is
  // deliberately narrow: the directory Claude was opened in, nothing above it,
  // nothing beside it, and only when the repository has a remote that means the
  // same thing on every machine.
  const project = identified.project ?? (await autoRegister(registry, workspace, cwd, repo));

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
    // Not eligible for automatic registration - see `autoRegister`. No context,
    // and no nagging either; `statenest add .` is there when the user wants it.
    return '';
  }

  // Record that this project was touched here.
  //
  // Awaited, unlike most bookkeeping. This is what links a second clone on the
  // same machine, or the first clone on a new one, and a hook process is
  // short-lived enough that a fire-and-forget write can simply not happen - so
  // "the same repository at a new path" would sometimes be remembered and
  // sometimes not. It is one small file write against an already-cached record.
  await registry
    .touchActivity(project.id, workspace.machineId, repoRoot ?? cwd, repo)
    .catch(() => null);

  // Give a stale profile a brief chance to catch up before the brief is built,
  // so work finished on another machine an hour ago is already in front of
  // Claude. Strictly bounded, and it never decides whether the session starts.
  if (await refreshIfStale(workspace)) registry.invalidate();

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

/**
 * Register the repository Claude was opened in, if it is safe to.
 *
 * Eligibility is one rule: **a git repository whose remote identifies it the
 * same way on every machine.** That is the whole test, and everything it rules
 * out is deliberate.
 *
 * - *Not a git repository* - `~/Downloads/scratch`, `/tmp/foo`. Opening Claude
 *   somewhere is not a statement that it is a project.
 * - *A git repository with no remote.* A project with no remote gets a random
 *   id, which cannot merge with the same directory on another machine. Creating
 *   those automatically would quietly fill a synced profile with one entry per
 *   machine for what the user thinks is one project. `statenest add .` still
 *   registers it, because then the user has said so.
 *
 * Nothing is scanned. The parent directory is not examined, the home directory
 * is not walked, and no file is read that `statenest add` would not read.
 */
async function autoRegister(
  registry: Registry,
  workspace: Workspace,
  cwd: string,
  repo: FastRepoInfo | null,
): Promise<Project | null> {
  if (!repo?.primaryRemote?.stableAcrossMachines) return null;

  try {
    const result = await registry.register(cwd, { machineId: workspace.machineId });
    // A newly known project is worth sending to the other machines.
    void scheduleSyncQuietly(workspace);
    return result.project;
  } catch {
    // A registration that fails must not cost the user their session context.
    return null;
  }
}

/**
 * A sync StateNest already did counts as fresh for this long.
 *
 * Long enough that a run of sessions in one afternoon never waits, short enough
 * that the first session of the day does.
 */
const FRESH_WINDOW_MS = 5 * 60_000;

/**
 * The most a session start will ever wait for the network.
 *
 * Chosen against the 2.5s handler deadline, not against how long a sync takes.
 * The rule is that Claude starts on time and StateNest catches up afterwards -
 * never the other way round - so this is a budget, not a timeout to be raised
 * when a remote turns out to be slow.
 */
const STARTUP_SYNC_BUDGET_MS = 700;

/**
 * How long a failed attempt suppresses the next session's wait.
 *
 * Being offline is usually a state, not an event: a laptop on a train starts
 * many sessions and the answer is the same every time. Without this, every one
 * of them pays to rediscover it. The sync is still scheduled in the background;
 * only the waiting is skipped.
 */
const OFFLINE_BACKOFF_MS = 60_000;

/**
 * Bring the profile up to date before building the brief, if there is time.
 *
 * The sync itself runs detached, so it finishes whatever happens here. This
 * only decides whether to wait a moment for it. Returns true when fresh data
 * actually arrived, which is the caller's cue to re-read.
 */
async function refreshIfStale(workspace: Workspace): Promise<boolean> {
  try {
    const { readMachineLocalState } = await import('../../core/machine-local.js');
    const local = await readMachineLocalState(
      workspace.paths,
      workspace.profile.name,
      workspace.profile,
    );

    if (!local.auto_sync) return false;
    if (!workspace.profile.sync.enabled || !workspace.profile.sync.remote) return false;

    // Recently found unreachable? Do not spend this session's budget proving it
    // again. Still schedule one, so the moment the network returns, it syncs.
    const attemptAge = local.last_sync_attempt_at
      ? Date.now() - Date.parse(local.last_sync_attempt_at)
      : Infinity;
    if (
      local.sync_health.state === 'offline' &&
      Number.isFinite(attemptAge) &&
      attemptAge < OFFLINE_BACKOFF_MS
    ) {
      void scheduleSyncQuietly(workspace);
      return false;
    }

    const since = local.last_sync_at ? Date.now() - Date.parse(local.last_sync_at) : Infinity;
    if (Number.isFinite(since) && since < FRESH_WINDOW_MS) {
      // Already fresh. Still ask for a sync so the *next* session is too, but
      // do not spend a millisecond of this one waiting for it.
      void scheduleSyncQuietly(workspace);
      return false;
    }

    await scheduleSyncQuietly(workspace, 'auto-sync-now');

    // Watch for the detached run to land. Polling a small local file is far
    // cheaper than holding the sync open in this process, and it means an
    // over-budget sync is abandoned by the waiter, not cancelled.
    const deadline = Date.now() + STARTUP_SYNC_BUDGET_MS;
    const before = local.last_sync_at;
    const beforeAttempt = local.last_sync_attempt_at;

    while (Date.now() < deadline) {
      // Not `unref`'d: an unref'd timer lets the process exit before it fires,
      // which would make this whole wait quietly do nothing in a real hook.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = await readMachineLocalState(
        workspace.paths,
        workspace.profile.name,
        workspace.profile,
      );
      if (current.last_sync_at && current.last_sync_at !== before) return true;

      // The attempt finished and did not bring anything back - offline, or a
      // conflict waiting to be repaired. Waiting out the rest of the budget
      // would buy nothing, and being offline should not tax every session.
      if (current.last_sync_attempt_at && current.last_sync_attempt_at !== beforeAttempt) {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Ask for a background sync without ever making the caller wait for one.
 *
 * Every call site is on a latency budget inside somebody else's tool, so this
 * swallows everything: a sync that cannot be scheduled is not a reason for a
 * hook to misbehave.
 */
async function scheduleSyncQuietly(
  workspace: Workspace,
  entry: 'auto-sync' | 'auto-sync-now' = 'auto-sync',
): Promise<void> {
  try {
    const { scheduleAutoSync, selfRunner } = await import('../../sync/auto-sync.js');
    await scheduleAutoSync(workspace, selfRunner([entry]));
  } catch {
    // Ignored on purpose.
  }
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
      decisions: condensed.decisions,
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

  // A checkpoint is the most valuable thing StateNest writes, and the moment
  // it exists is the moment another machine should be able to see it.
  await scheduleSyncQuietly(workspace);

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

  // Detached, so the push outlives this hook. SessionEnd is killed at roughly
  // 1.5 seconds; a sync is not going to finish inside that, and the checkpoint
  // must not be at risk of being cut short waiting for one.
  await scheduleSyncQuietly(workspace);

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
    // StateNest is not set up on this machine, or its home is unreadable.
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
  decisions: string[];
}> {
  // Redaction runs first, over the whole text, so a credential is removed
  // wherever it appears - not merely dropped by the condensing that follows.
  const redactSecrets = await loadRedact();
  const clean = redactSecrets(summary).text;

  const prose: string[] = [];
  const buckets: Record<Bucket, string[]> = {
    completed: [],
    next: [],
    blockers: [],
    decisions: [],
  };
  let inCodeFence = false;
  let seenBullet = false;

  // Which bucket subsequent bullets belong to, driven by the last heading or
  // lead-in line seen. A compaction summary is written for a model, but it
  // still tends to group its content under recognisable labels.
  let bucket: Bucket = 'completed';

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

      // A bullet that names its own category wins over the heading above it.
      const self = classifyBullet(text);
      const target = buckets[self ? self.bucket : bucket];
      const value = self ? self.text : text;
      if (value.length > 3 && target.length < 10) target.push(value);
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
      const target = buckets[inlineBucket];
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
    completed: buckets.completed,
    next: buckets.next,
    blockers: buckets.blockers,
    decisions: buckets.decisions,
  };
}

type Bucket = 'completed' | 'next' | 'blockers' | 'decisions';

function classifyLabel(text: string): Bucket | null {
  const value = text.toLowerCase();
  if (/\b(still open|remaining|next steps?|next|todos?|to do|unfinished|outstanding|follow[- ]?ups?)\b/.test(value)) {
    return 'next';
  }
  if (/\b(blocked|blockers?|blocking|stuck|problems?|issues?|failing)\b/.test(value)) {
    return 'blockers';
  }
  if (/\b(decision|decisions|decided|chose|rationale)\b/.test(value)) {
    return 'decisions';
  }
  if (/\b(completed|done|accomplished|changes|work done|finished|implemented)\b/.test(value)) {
    return 'completed';
  }
  return null;
}

/**
 * A bullet that labels itself, as in `- Next: re-run the winter fixtures`.
 *
 * Claude Code's summaries group bullets under headings most of the time, but
 * not always - and a bullet that says what it is should be believed over the
 * heading it happens to sit under. Without this, `Next:` and `Blocked:` bullets
 * were filed as work already completed, which is worse than filing them
 * nowhere: a resume brief would claim you had finished the thing blocking you.
 *
 * Deliberately narrow. It fires only on a short leading `Label:` whose word is
 * already recognised, so ordinary prose containing a colon - "Refactor: split
 * the allocator" - classifies as nothing and is left exactly where it was.
 * Nothing here infers meaning from a sentence.
 */
function classifyBullet(text: string): { bucket: Bucket; text: string } | null {
  const prefixed = /^([A-Za-z][A-Za-z \t/-]{1,24}):\s+(\S.*)$/.exec(text);
  if (!prefixed) return null;

  const bucket = classifyLabel(prefixed[1]!.trim());
  if (!bucket) return null;

  return { bucket, text: prefixed[2]!.trim() };
}

function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

/**
 * Record a hook failure where `statenest doctor` can find it.
 *
 * Written to the StateNest log, never to stderr: stderr from a hook is
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
