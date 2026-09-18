import { spawn } from 'node:child_process';
import { Workspace } from '../core/workspace.js';
import {
  readMachineLocalState,
  recordSyncCompleted,
  recordSyncHealth,
  requestSync,
} from '../core/machine-local.js';
import { withExclusiveFileLock } from '../util/file-lock.js';
import { HOME_ENV_VAR } from '../core/paths.js';
import { PROFILE_ENV_VAR } from '../core/workspace.js';
import { ProfileSync, type SyncResult } from './git-sync.js';

/**
 * Sync that happens by itself.
 *
 * The product promise is that an ordinary day needs no StateNest commands, and
 * sync is the part of that most easily got wrong. Four properties are
 * non-negotiable, and every design choice here follows from one of them:
 *
 * 1. **Nothing waits for the network.** A write records that a sync is wanted
 *    and returns. The sync itself happens in a process nobody is waiting for,
 *    so a hook stays in the tens of milliseconds whatever GitHub is doing.
 *
 * 2. **One sync at a time, per profile.** Two processes driving git in one
 *    directory is how a repository gets wedged. The lock is exclusive and
 *    *skips* rather than queues: whoever holds it is already doing the work.
 *
 * 3. **A burst becomes one sync.** Writes arrive in clumps - a checkpoint, a
 *    task, a decision, all within a second. The runner waits out a short
 *    debounce before starting, so the clump costs one push rather than five.
 *
 * 4. **Failure is never louder than the work.** Offline, conflicted and
 *    credential-blocked all resolve to a recorded health state. None of them
 *    interrupts anybody, and none of them loses a local write.
 *
 * There is no daemon. Nothing runs unless StateNest was invoked.
 */

/** How long to let writes accumulate before syncing them. */
const DEBOUNCE_MS = 1_500;

/**
 * How many times one runner will go round.
 *
 * A sync that lands while an earlier one was in flight deserves its own pass,
 * but only a bounded number: this is the backstop against a runner that keeps
 * finding new work forever. It cannot normally trigger, because sync writes
 * nothing inside the profile directory - that was the v0.1.2 fix - so a sync
 * cannot generate the change that would schedule the next one.
 */
const MAX_PASSES = 2;

export type AutoSyncReason =
  | 'synced'
  | 'disabled'
  | 'not-configured'
  | 'already-running'
  | 'nothing-pending'
  | 'unavailable';

export interface AutoSyncOutcome {
  /** True when this process actually ran at least one sync. */
  ran: boolean;
  reason: AutoSyncReason;
  passes: number;
  /** The last sync's result, when one ran. */
  result: SyncResult | null;
}

export interface AutoSyncOptions {
  home?: string;
  profile?: string;
  /** Overridden in tests, which have no interest in waiting. */
  debounceMs?: number;
  /** Sync even when nothing asked for it - used by an explicit CLI run. */
  force?: boolean;
}

/**
 * Note that something worth syncing happened, and get out of the way.
 *
 * Cheap by construction: one small write to a machine-local file, then a
 * detached process that this one does not wait for. Safe to call from any hook.
 */
export async function scheduleAutoSync(
  workspace: Workspace,
  runner: BackgroundRunner | null,
): Promise<void> {
  const local = await readMachineLocalState(
    workspace.paths,
    workspace.profile.name,
    workspace.profile,
  );
  if (!local.auto_sync) return;
  if (!workspace.profile.sync.enabled || !workspace.profile.sync.remote) return;

  await requestSync(workspace.paths, workspace.profile.name, workspace.profile);

  // Tell the child which home and profile to work on, explicitly.
  //
  // It is a fresh process with only the arguments given here, so it would
  // otherwise resolve the *default* home - and a caller who passed `--home`
  // would have their background sync quietly operate on somebody else's data.
  // Passing it through the environment rather than as arguments also means the
  // child does not depend on how this process happened to be invoked.
  runner?.spawn({
    [HOME_ENV_VAR]: workspace.paths.home,
    [PROFILE_ENV_VAR]: workspace.profile.name,
  });
}

/**
 * Run the sync a `scheduleAutoSync` asked for.
 *
 * This is the whole of the interesting behaviour and it is an ordinary async
 * function, so the lock, the debounce, the coalescing and every health
 * transition are testable without starting a single process.
 */
export async function performAutoSync(options: AutoSyncOptions = {}): Promise<AutoSyncOutcome> {
  const nothing = (reason: AutoSyncReason): AutoSyncOutcome => ({
    ran: false,
    reason,
    passes: 0,
    result: null,
  });

  let workspace: Workspace;
  try {
    workspace = await Workspace.open({
      ...(options.home ? { home: options.home } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    });
  } catch {
    // StateNest is not set up, or its home is unreadable. Either way this is
    // background work nobody asked to watch.
    return nothing('unavailable');
  }

  const profileName = workspace.profile.name;
  const local = await readMachineLocalState(workspace.paths, profileName, workspace.profile);

  if (!local.auto_sync && !options.force) return nothing('disabled');
  if (!workspace.profile.sync.enabled || !workspace.profile.sync.remote) {
    return nothing('not-configured');
  }

  // Skipped, not queued: a second runner would only duplicate the first.
  return withExclusiveFileLock(
    `${workspace.paths.localStateFor(profileName)}.sync`,
    () => drain(workspace, options),
    nothing('already-running'),
    { staleMs: 10 * 60_000 },
  );
}

async function drain(workspace: Workspace, options: AutoSyncOptions): Promise<AutoSyncOutcome> {
  const profileName = workspace.profile.name;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  let passes = 0;
  let last: SyncResult | null = null;
  let ran = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // Let a burst of writes finish arriving before servicing any of them.
    // A forced run is somebody waiting at a terminal, so it does not wait.
    const forcedFirstPass = options.force === true && pass === 0;
    if (debounceMs > 0 && !forcedFirstPass) await delay(debounceMs);

    const before = await readMachineLocalState(workspace.paths, profileName, workspace.profile);
    if (!before.sync_requested_at && !(options.force && pass === 0)) {
      break;
    }

    const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
    const result = await sync.sync({ push: before.auto_push });
    last = result;
    ran = true;
    passes = pass + 1;

    await recordOutcome(workspace, result);

    // A write that landed while the sync was running gets its own pass. A run
    // that changed nothing has nothing to chase.
    const after = await readMachineLocalState(workspace.paths, profileName, workspace.profile);
    if (!after.sync_requested_at) break;
    if (result.outcome === 'offline' || result.outcome === 'conflict') break;
    if (result.outcome === 'blocked-by-secrets') break;
  }

  return {
    ran,
    reason: ran ? 'synced' : 'nothing-pending',
    passes,
    result: last,
  };
}

/**
 * Translate a sync result into this machine's health.
 *
 * Nothing here is shared, so two machines can disagree about whether sync is
 * healthy - which is correct, because it is a statement about a network
 * connection and a working copy, not about the data.
 */
export async function recordOutcome(workspace: Workspace, result: SyncResult): Promise<void> {
  const { paths, profile } = workspace;
  const name = profile.name;

  switch (result.outcome) {
    case 'synced':
    case 'up-to-date':
      await recordSyncCompleted(paths, name, profile);
      return;

    case 'offline':
      await recordSyncHealth(paths, name, profile, {
        state: 'offline',
        detail: 'Could not reach the sync repository.',
      });
      return;

    case 'conflict':
      await recordSyncHealth(paths, name, profile, {
        state: 'conflict',
        detail: 'Two machines changed the same record.',
        conflicts: result.conflicts,
        conflict_remote_sha: result.conflictRemoteSha ?? null,
      });
      return;

    case 'blocked-by-secrets':
      await recordSyncHealth(paths, name, profile, {
        state: 'blocked-by-secrets',
        // `blockers` are already masked - file and line, never a value - and
        // only the count is kept here, so nothing sensitive reaches this file.
        detail: `${result.blockers.length} item(s) may contain a credential.`,
      });
      return;

    case 'local-only':
      await recordSyncHealth(paths, name, profile, {
        state: 'pending',
        detail: 'Saved on this machine; not sent yet.',
      });
      return;

    case 'not-configured':
      return;
  }
}

// ---------------------------------------------------------------------------
// Re-invoking this program in the background
// ---------------------------------------------------------------------------

/**
 * How to start a background sync.
 *
 * A thin shim over `spawn` on purpose: every decision worth testing lives in
 * `performAutoSync`, and this only has to start a process and let go of it.
 */
export interface BackgroundRunner {
  spawn(env?: NodeJS.ProcessEnv): void;
}

/**
 * Re-invoke the currently running program to sync in the background.
 *
 * The child is detached with no stdio, and unref'd, so the parent exits
 * immediately and the child survives it. That is what lets a SessionEnd hook
 * finish inside its ~1.5s budget while the push happens afterwards.
 */
export function selfRunner(args: string[], env: NodeJS.ProcessEnv = {}): BackgroundRunner {
  return {
    spawn(extra: NodeJS.ProcessEnv = {}): void {
      const entry = process.argv[1];
      if (!entry) return;
      try {
        const child = spawn(process.execPath, [entry, ...args], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...env, ...extra, STATENEST_BACKGROUND: '1' },
        });
        child.unref();
      } catch {
        // A background sync that cannot start is not worth a word to anyone.
        // The request stays recorded and the next StateNest invocation retries.
      }
    },
  };
}

/** True when this process is itself a background sync runner. */
export function isBackgroundRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['STATENEST_BACKGROUND'] === '1';
}

/**
 * Wait, and keep the process alive while waiting.
 *
 * Deliberately not `unref`'d. An unref'd timer does not hold the event loop
 * open, so a process whose only outstanding work is this sleep exits before it
 * fires - which would silently turn the debounce into no debounce at all. The
 * background runner exists in order to wait; letting it die early defeats it.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
