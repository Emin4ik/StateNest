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
 */
export const MachineLocalStateSchema = z.looseObject({
  schema_version: z.number().int().positive().default(1),
  profile: z.string().min(1),
  /** When this machine last completed a sync. Never shared. */
  last_sync_at: z.string().nullable().default(null),
  /** Directories this machine scans when `statenest scan` is given none. */
  project_roots: z.array(z.string()).default([]),
});

export type MachineLocalState = z.infer<typeof MachineLocalStateSchema>;

function empty(profileName: string): MachineLocalState {
  return { schema_version: 1, profile: profileName, last_sync_at: null, project_roots: [] };
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
  }
  return carried;
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
  }));
}
