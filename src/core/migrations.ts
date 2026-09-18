import { SCHEMA_VERSION } from './schema.js';

/**
 * Schema migration.
 *
 * Two different problems live here, and they need opposite treatments.
 *
 * **Older data** is migrated forward. Each migration is a pure function from
 * one plain object to another, applied in order, and every one of them is
 * additive: a migration may fill in a field it can derive, but it never removes
 * or overwrites something the user wrote. `pb migrate` backs the profile up
 * before rewriting anything.
 *
 * **Newer data** is left completely alone. Every schema is a `z.looseObject`,
 * so a record written by a future version round-trips through this one with
 * every unknown field intact - verified at every nesting level by
 * tests/integration/migration.test.ts. An old machine syncing a profile a newer
 * machine has touched therefore cannot silently strip it. What it must not do
 * is *migrate* such a record, so anything at or above the current version is
 * passed through untouched.
 */

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

/** Records that carry a `schema_version` and can therefore be migrated. */
export type RecordKind = 'project' | 'machine' | 'remote' | 'tasks' | 'profile' | 'config';

export interface Migration {
  /** The version this migration produces. */
  to: number;
  /** Shown by `pb migrate`, so the user can see what will change. */
  describe: string;
  /** Kinds this applies to. Omit for all. */
  kinds?: RecordKind[];
  apply(record: Record<string, unknown>, kind: RecordKind): Record<string, unknown>;
}

/**
 * Migration to schema version 1.
 *
 * This is a real migration, not a placeholder. Project Brain's pre-release
 * builds wrote records before `schema_version` was stamped and before
 * `repository.path` existed, and anyone who used one of those builds has data
 * in exactly this shape.
 */
const TO_V1: Migration = {
  to: 1,
  describe: 'Stamp schema_version, and backfill repository.path from the repository identity',
  apply(record, kind) {
    const migrated: Record<string, unknown> = { ...record, schema_version: 1 };

    if (kind === 'project') {
      const repository = migrated.repository;
      if (isObject(repository) && typeof repository.identity === 'string' && !repository.path) {
        // `identity` is `host/owner/name`; the path is everything after the host.
        const slash = repository.identity.indexOf('/');
        if (slash > 0) {
          migrated.repository = {
            ...repository,
            path: repository.identity.slice(slash + 1),
          };
        }
      }

      // A location without a timestamp cannot be ordered or aged. Falling back
      // to the project's discovery time is wrong-but-bounded; leaving it absent
      // makes the record fail validation and become unreadable entirely.
      const locations = migrated.local_locations;
      const fallback =
        typeof migrated.discovered_at === 'string' ? migrated.discovered_at : undefined;
      if (Array.isArray(locations) && fallback) {
        migrated.local_locations = locations.map((location) =>
          isObject(location) && typeof location.last_seen_at !== 'string'
            ? { ...location, last_seen_at: fallback }
            : location,
        );
      }
    }

    return migrated;
  },
};

/** Ordered by target version. Add new migrations to the end. */
export const MIGRATIONS: readonly Migration[] = [TO_V1];

export interface MigrationResult {
  value: Record<string, unknown>;
  /** Descriptions of migrations actually applied, in order. */
  applied: string[];
  fromVersion: number;
  toVersion: number;
  /** True when the record came from a newer version and was left untouched. */
  fromFuture: boolean;
}

/**
 * Bring one record up to the current schema version.
 *
 * A record with no `schema_version` is treated as version 0 - that is what
 * pre-release data looks like, and assuming it is current would skip exactly
 * the migration it needs.
 */
export function migrateRecord(kind: RecordKind, raw: unknown): MigrationResult {
  if (!isObject(raw)) {
    return { value: {}, applied: [], fromVersion: 0, toVersion: 0, fromFuture: false };
  }

  const fromVersion = readVersion(raw);

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return {
      value: raw,
      applied: [],
      fromVersion,
      toVersion: fromVersion,
      fromFuture: true,
    };
  }

  let value = raw;
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.to <= fromVersion) continue;
    if (migration.kinds && !migration.kinds.includes(kind)) continue;
    value = migration.apply(value, kind);
    applied.push(`v${migration.to}: ${migration.describe}`);
  }

  return {
    value,
    applied,
    fromVersion,
    toVersion: applied.length > 0 ? CURRENT_SCHEMA_VERSION : fromVersion,
    fromFuture: false,
  };
}

export function readVersion(raw: unknown): number {
  if (!isObject(raw)) return 0;
  const version = raw.schema_version;
  return typeof version === 'number' && Number.isFinite(version) && version > 0 ? version : 0;
}

/** True when this build is older than the data it is looking at. */
export function isFromFuture(raw: unknown): boolean {
  return readVersion(raw) > CURRENT_SCHEMA_VERSION;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
