import { z } from 'zod';
import { readFileOrNull, writeFileAtomic } from '../util/fs-atomic.js';
import { now } from '../util/time.js';
import type { BrainPaths } from './paths.js';
import type { Profile } from './schema.js';

/**
 * State that belongs to *this computer*, not to the profile.
 *
 * Everything inside a profile directory is synced, so anything written there
 * is written for every machine. Two fields were in `profile.yaml` that have no
 * business being shared:
 *
 * - `sync.last_sync_at` — when *this* machine last synced. The CLI wrote it
 *   after `ProfileSync` had already committed and pushed, so a successful sync
 *   immediately dirtied the repository it had just cleaned. Worse, each machine
 *   wrote a different timestamp into the same synced file, which manufactured a
 *   conflict in `profile.yaml` even when no user data disagreed — and
 *   `profile.yaml` is a control file, so once it holds conflict markers most
 *   commands stop working.
 *
 * - `project_roots` — the directories this machine scans. `~/Documents` on a
 *   Mac, `~/code` on a Linux box, `D:\work` on Windows. Sharing them means one
 *   machine silently overwrites another's, and a `statenest scan` with no
 *   arguments would walk paths that do not exist here.
 *
 * Both now live in `~/.statenest/local/<profile>.json`, outside `profiles/`,
 * where sync cannot reach them. The old values are still read once, so nothing
 * an existing user configured is lost.
 *
 * Automatic sync settings and sync health joined them, for the same reason: a
 * laptop on a metered connection and a desktop on home broadband can disagree
 * about whether to push, and whether the network is currently reachable is a
 * fact about one machine rather than about the data.
 */

/**
 * What sync is currently doing, from this machine's point of view.
 *
 * `detail` is a sentence for the user. It never holds a credential value: the
 * secret scanner reports file and line, and that is all that is kept here.
 */
export const SyncHealthSchema = z.looseObject({
  state: z
    .enum(['ok', 'offline', 'pending', 'conflict', 'blocked-by-secrets', 'error'])
    .default('ok'),
  /** When the current state began, so a warning can age. */
  since: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
  /** Record paths that conflicted, relative to the profile directory. */
  conflicts: z.array(z.string()).default([]),
  /**
   * The remote commit the conflict was against. Both sides of a conflict stay
   * reachable in git: ours on the branch, theirs at this sha.
   */
  conflict_remote_sha: z.string().nullable().default(null),
  /** How many times the same failing state has repeated, to throttle notices. */
  occurrences: z.number().int().nonnegative().default(0),
  /** When the user was last told about this state. */
  last_notified_at: z.string().nullable().default(null),
});

export type SyncHealth = z.infer<typeof SyncHealthSchema>;

export const MachineLocalStateSchema = z.looseObject({
  schema_version: z.number().int().positive().default(1),
  profile: z.string().min(1),
  /** When this machine last completed a sync. Never shared. */
  last_sync_at: z.string().nullable().default(null),
  /** Directories this machine scans when `statenest scan` is given none. */
  project_roots: z.array(z.string()).default([]),

  // --- automatic sync -------------------------------------------------------
  //
  // Machine-local on purpose. A desktop on home broadband and a laptop on a
  // metered connection can legitimately want different answers, so these are
  // the same category of field as `last_sync_at`: shared storage for them
  // would recreate the bug v0.1.2 fixed.
  /** Sync by itself after meaningful writes. */
  auto_sync: z.boolean().default(true),
  /**
   * Send local changes during an automatic sync.
   *
   * False gathers work locally and leaves sending it to an explicit
   * `statenest sync` - which is what someone on a metered connection wants.
   *
   * There is deliberately no `auto_pull` counterpart. StateNest never force
   * pushes, so sending requires rebasing onto the remote first; "pull" is not
   * separable from "sync at all", and `auto_sync` already says that.
   */
  auto_push: z.boolean().default(true),

  /** When an automatic sync was last attempted, successful or not. */
  last_sync_attempt_at: z.string().nullable().default(null),
  /** Set when a write happened that has not yet been synced. */
  sync_requested_at: z.string().nullable().default(null),
  sync_health: SyncHealthSchema.prefault({}),
});

export type MachineLocalState = z.infer<typeof MachineLocalStateSchema>;

function empty(profileName: string): MachineLocalState {
  return MachineLocalStateSchema.parse({ profile: profileName });
}

/**
 * Read this machine's state for a profile.
 *
 * `profile` is used once, to carry forward values written by a version that
 * kept them in `profile.yaml`. After the first write the local file is
 * authoritative and the profile's copy is ignored — so the migration happens
 * by itself, exactly once, and is idempotent.
 */
export async function readMachineLocalState(
  paths: BrainPaths,
  profileName: string,
  profile?: Profile | null,
): Promise<MachineLocalState> {
  const raw = await readFileOrNull(paths.localStateFor(profileName));

  if (raw !== null) {
    try {
      const parsed = MachineLocalStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Unreadable local state is an inconvenience, not a failure: it holds a
      // timestamp and a list of directories, both of which can be rebuilt.
    }
  }

  const carried = empty(profileName);
  if (profile) {
    carried.last_sync_at = profile.sync.last_sync_at ?? null;
    carried.project_roots = [...profile.project_roots];
    // `auto_pull: false` only ever coherently meant "leave sync alone", which
    // is what `auto_sync` says now. Honour the intent rather than the field.
    carried.auto_sync = profile.sync.auto_pull !== false;

    // `auto_push` is deliberately NOT carried forward.
    //
    // It defaulted to `false` in the profile schema and was read by nothing, so
    // a stored `false` records no decision anybody made - it is the default of
    // a field that never did anything. Inheriting it would silently mean "never
    // push automatically" for every existing user, which is the opposite of
    // what they have been experiencing. A value that cannot be distinguished
    // from its own unused default is not intent worth preserving.
  }
  return carried;
}

/** Record how sync is doing, without disturbing anything else. */
export async function recordSyncHealth(
  paths: BrainPaths,
  profileName: string,
  profile: Profile | null,
  health: Partial<SyncHealth> & Pick<SyncHealth, 'state'>,
): Promise<MachineLocalState> {
  return updateMachineLocalState(paths, profileName, profile, (state) => {
    const same = state.sync_health.state === health.state;
    return {
      ...state,
      last_sync_attempt_at: now(),
      sync_health: SyncHealthSchema.parse({
        ...health,
        // A state that persists keeps its original start time, so "since" means
        // since it started going wrong, not since it was last checked.
        since: same ? (state.sync_health.since ?? now()) : now(),
        occurrences: same ? state.sync_health.occurrences + 1 : 1,
        last_notified_at: same ? state.sync_health.last_notified_at : null,
      }),
    };
  });
}

/** Replace this machine's state for a profile. */
export async function writeMachineLocalState(
  paths: BrainPaths,
  state: MachineLocalState,
): Promise<MachineLocalState> {
  const validated = MachineLocalStateSchema.parse(state);
  await writeFileAtomic(
    paths.localStateFor(validated.profile),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
  return validated;
}

/** Apply a change to this machine's state, reading what is there first. */
export async function updateMachineLocalState(
  paths: BrainPaths,
  profileName: string,
  profile: Profile | null,
  change: (state: MachineLocalState) => MachineLocalState,
): Promise<MachineLocalState> {
  const current = await readMachineLocalState(paths, profileName, profile);
  return writeMachineLocalState(paths, change(current));
}

/**
 * Record that a sync just finished.
 *
 * Deliberately does not touch the profile: the whole point is that a completed
 * sync leaves the synced repository exactly as the sync left it.
 */
export async function recordSyncCompleted(
  paths: BrainPaths,
  profileName: string,
  profile: Profile | null,
): Promise<MachineLocalState> {
  return updateMachineLocalState(paths, profileName, profile, (state) => ({
    ...state,
    last_sync_at: now(),
    last_sync_attempt_at: now(),
    // Everything requested before now has been sent. A write that lands during
    // the sync sets this again and gets its own run.
    sync_requested_at: null,
    sync_health: SyncHealthSchema.parse({ state: 'ok', since: now() }),
  }));
}

/**
 * Note that something worth syncing was written.
 *
 * Deliberately cheap and idempotent: it is called from hooks on a latency
 * budget, and a burst of writes should leave exactly one outstanding request.
 */
export async function requestSync(
  paths: BrainPaths,
  profileName: string,
  profile: Profile | null,
): Promise<MachineLocalState> {
  return updateMachineLocalState(paths, profileName, profile, (state) =>
    state.sync_requested_at ? state : { ...state, sync_requested_at: now() },
  );
}
