import { upsertLocation } from './registry.js';
import type { Store } from '../storage/store.js';
import type { ProjectLocation } from './schema.js';

/**
 * Carrying local discoveries across a first-join adoption.
 *
 * When a machine joins a profile that already exists, it has local files but no
 * commits, so it cannot fast-forward. Sync resolves that by adopting the remote
 * history and materialising the remote files over the top. That is right for
 * shared state — the remote is authoritative about what the projects *are* —
 * but it is a blunt instrument, and it was throwing away something the joining
 * machine had legitimately just learned.
 *
 * The case is ordinary. A developer installs StateNest on a second computer,
 * points it at the same private repository, and opens their agent in a clone
 * they already have. The session registers the repository, discovering that it
 * lives *here* too. Then the first sync adopts the remote copy of that same
 * project — the copy that has never heard of this machine — and the discovery
 * is gone. The project, its history and its context all survive; only the one
 * fact this machine was uniquely placed to know does not.
 *
 * The rule is deliberately narrow:
 *
 *   remote state  +  this machine's own locations  =  the result
 *
 * Not "keep local changes". The remote stays authoritative about every field of
 * every record, including the rest of `local_locations`. The only thing carried
 * across is where this machine holds a project, which no other machine can
 * report and which cannot conflict, because locations are keyed by machine and
 * path.
 *
 * A project that exists only locally needs nothing: `git checkout <remote> -- .`
 * overwrites paths the remote has and leaves the rest alone, so its file was
 * never touched.
 */
export interface AdoptionReconciler {
  /** Run immediately before the remote history replaces local files. */
  capture(): Promise<void>;
  /**
   * Run immediately after, and before anything is staged.
   *
   * Ordering matters: the restored locations are committed and pushed by the
   * same sync run, so the profile is left clean and the other machines learn
   * about this one without a second sync.
   */
  restore(): Promise<void>;
}

/** A reconciler that does nothing, for callers with no data model to preserve. */
export const NO_ADOPTION_RECONCILER: AdoptionReconciler = {
  capture: async () => {},
  restore: async () => {},
};

/**
 * Preserve this machine's project locations across adoption.
 *
 * Nothing is remembered between runs: `capture` is only meaningful when
 * `restore` follows it in the same sync, and a reconciler that is captured but
 * never restored simply drops what it held.
 */
export function preserveMachineLocations(store: Store, machineId: string): AdoptionReconciler {
  let held = new Map<string, ProjectLocation[]>();

  return {
    async capture(): Promise<void> {
      held = new Map();
      for (const project of await store.listProjects()) {
        const mine = project.local_locations.filter(
          (location) => location.machine_id === machineId,
        );
        if (mine.length > 0) held.set(project.id, mine);
      }
    },

    async restore(): Promise<void> {
      const pending = held;
      held = new Map();

      for (const [projectId, locations] of pending) {
        // The remote's version of this project, freshly materialised. Absent
        // means the project exists only here, so its file was never replaced
        // and there is nothing to put back.
        const adopted = await store.getProject(projectId);
        if (!adopted) continue;

        let next = adopted;
        for (const location of locations) next = upsertLocation(next, location);

        // `upsertLocation` returns a new object even when nothing changed, so
        // compare the locations rather than the reference: a machine that was
        // already recorded remotely must not produce a pointless write, which
        // would dirty the repository the sync is about to leave clean.
        if (!sameLocations(adopted.local_locations, next.local_locations)) {
          await store.saveProject(next);
        }
      }
    },
  };
}

function sameLocations(
  before: readonly ProjectLocation[],
  after: readonly ProjectLocation[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((location, index) => {
    const other = after[index];
    return (
      other !== undefined &&
      location.machine_id === other.machine_id &&
      location.path === other.path &&
      location.branch === other.branch
    );
  });
}
