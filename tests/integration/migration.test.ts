import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { ProjectSchema, MachineSchema } from '../../src/core/schema.js';
import {
  CURRENT_SCHEMA_VERSION,
  migrateRecord,
  readVersion,
  isFromFuture,
} from '../../src/core/migrations.js';
import { makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Schema migration, in both directions.
 *
 * Forward: data written by an older build must keep working. Backward: data
 * written by a NEWER build must survive contact with this one unchanged,
 * because a synced profile is routinely touched by machines running different
 * versions and the older one must not silently strip what it does not know.
 */
describe('schema migration', () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-migrate-home-');
  });

  afterEach(async () => {
    await home.cleanup();
  });

  /**
   * A realistic pre-release project record: written before `schema_version` was
   * stamped and before `repository.path` existed. Anyone who used an early
   * build has data in exactly this shape.
   */
  const LEGACY_PROJECT = [
    'id: prj_legacy001',
    'name: world-war-rts',
    'description: A real-time strategy game.',
    'aliases: []',
    'type: unity',
    'status: active',
    'tags: []',
    'created_at: 2026-03-01T09:00:00Z',
    'discovered_at: 2026-03-01T09:00:00Z',
    'last_activity_at: 2026-03-04T17:22:00Z',
    'repository:',
    '  identity: github.com/emin/world-war-rts',
    '  url: git@github.com:emin/world-war-rts.git',
    '  host: github.com',
    '  owner: emin',
    '  name: world-war-rts',
    'local_locations:',
    '  - machine_id: machine_legacy',
    '    path: /Users/emin/Projects/world-war',
    '    is_worktree: false',
    '    branch: phase-7',
    'deployments: []',
    'blockers: []',
    '',
  ].join('\n');

  describe('forward: data from an older build', () => {
    it('detects a record with no schema_version as version 0', () => {
      expect(readVersion({ id: 'x' })).toBe(0);
      expect(readVersion({ id: 'x', schema_version: 1 })).toBe(1);
    });

    it('stamps the schema version', () => {
      const result = migrateRecord('project', { id: 'x', name: 'y' });
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.value.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.applied.length).toBeGreaterThan(0);
    });

    it('backfills repository.path from the identity', () => {
      const result = migrateRecord('project', {
        id: 'x',
        repository: { identity: 'github.com/acme/widget', name: 'widget' },
      });
      const repository = result.value.repository as Record<string, unknown>;
      expect(repository.path).toBe('acme/widget');
      // Backfill must never overwrite what was already there.
      expect(repository.name).toBe('widget');
    });

    it('preserves a repository.path that already exists', () => {
      const result = migrateRecord('project', {
        schema_version: 1,
        repository: { identity: 'github.com/acme/widget', path: 'hand/edited' },
      });
      expect((result.value.repository as Record<string, unknown>).path).toBe('hand/edited');
    });

    it('backfills a location timestamp rather than letting the record become unreadable', () => {
      const result = migrateRecord('project', {
        id: 'x',
        discovered_at: '2026-03-01T09:00:00Z',
        local_locations: [{ machine_id: 'm', path: '/x' }],
      });
      const locations = result.value.local_locations as Record<string, unknown>[];
      expect(locations[0]!.last_seen_at).toBe('2026-03-01T09:00:00Z');
    });

    it('does not re-apply a migration to already-current data', () => {
      const current = { schema_version: CURRENT_SCHEMA_VERSION, id: 'x' };
      const result = migrateRecord('project', current);
      expect(result.applied).toEqual([]);
      expect(result.value).toBe(current);
    });

    it('loads a legacy project file transparently, with no migration command run', async () => {
      const workspace = await Workspace.initialize({ home: home.path });
      const dir = join(workspace.profilePaths.projectsDir, 'prj_legacy001');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'project.yaml'), LEGACY_PROJECT);

      const projects = await new Registry(workspace.store).all();
      const legacy = projects.find((project) => project.id === 'prj_legacy001');

      expect(legacy, 'the legacy record must load').toBeDefined();
      expect(legacy!.name).toBe('world-war-rts');
      expect(legacy!.repository?.path).toBe('emin/world-war-rts');
      expect(legacy!.local_locations[0]?.last_seen_at).toBe('2026-03-01T09:00:00Z');
      // And it loaded without being reported as corrupt.
      expect(workspace.store.getIssues()).toEqual([]);
    });

    it('would fail to load without the migration, proving the migration does the work', () => {
      // The same record, parsed directly against the schema with no migration:
      // the location has no `last_seen_at`, which is required.
      const raw = {
        id: 'prj_legacy001',
        name: 'world-war-rts',
        created_at: '2026-03-01T09:00:00Z',
        discovered_at: '2026-03-01T09:00:00Z',
        local_locations: [{ machine_id: 'machine_legacy', path: '/Users/emin/Projects/world-war' }],
      };
      expect(ProjectSchema.safeParse(raw).success).toBe(false);
      expect(ProjectSchema.safeParse(migrateRecord('project', raw).value).success).toBe(true);
    });

    it('migrates machine records too', () => {
      const result = migrateRecord('machine', {
        id: 'machine_x',
        name: 'laptop',
        first_seen_at: '2026-03-01T09:00:00Z',
        last_seen_at: '2026-03-01T09:00:00Z',
      });
      expect(result.value.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(MachineSchema.safeParse(result.value).success).toBe(true);
    });
  });

  describe('backward: data from a newer build', () => {
    it('recognises a future record', () => {
      expect(isFromFuture({ schema_version: CURRENT_SCHEMA_VERSION + 1 })).toBe(true);
      expect(isFromFuture({ schema_version: CURRENT_SCHEMA_VERSION })).toBe(false);
    });

    it('leaves a future record completely untouched', () => {
      const future = { schema_version: 99, id: 'x', something_new: { deeply: ['nested'] } };
      const result = migrateRecord('project', future);

      expect(result.fromFuture).toBe(true);
      expect(result.applied).toEqual([]);
      expect(result.value).toBe(future);
      expect(result.value.schema_version).toBe(99);
    });

    it('preserves unknown fields at every nesting level through a full round trip', async () => {
      const workspace = await Workspace.initialize({ home: home.path });
      const registry = new Registry(workspace.store);

      // Exactly what a newer StateNest might have written into a synced
      // profile: unknown fields at the top level, inside a nested object, and
      // inside elements of two different arrays.
      const dir = join(workspace.profilePaths.projectsDir, 'prj_future01');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'project.yaml'),
        [
          'schema_version: 99',
          'id: prj_future01',
          'name: from-the-future',
          'created_at: 2026-09-18T09:00:00Z',
          'discovered_at: 2026-09-18T09:00:00Z',
          'unknown_top_level:',
          '  nested_value: keep-me',
          'repository:',
          '  identity: github.com/acme/future',
          '  unknown_repo_field: keep-me-too',
          'local_locations:',
          '  - machine_id: machine_future',
          '    path: /elsewhere/future',
          '    last_seen_at: 2026-09-18T09:00:00Z',
          '    unknown_location_field: and-me',
          'deployments:',
          '  - id: dep_1',
          '    remote_id: remote_1',
          '    updated_at: 2026-09-18T09:00:00Z',
          '    unknown_deployment_field: me-as-well',
          '',
        ].join('\n'),
      );

      const project = (await registry.all()).find((p) => p.id === 'prj_future01');
      expect(project, 'a future record must still load').toBeDefined();

      // Read it, modify something unrelated, and write it back - the exact
      // sequence by which an older machine could strip a newer one's fields.
      await registry.save({ ...project!, current_focus: 'touched by an older version' });

      const rewritten = await readFile(join(dir, 'project.yaml'), 'utf8');
      expect(rewritten).toContain('schema_version: 99');
      expect(rewritten).toContain('keep-me');
      expect(rewritten).toContain('keep-me-too');
      expect(rewritten).toContain('and-me');
      expect(rewritten).toContain('me-as-well');
      expect(rewritten).toContain('touched by an older version');
    });
  });

  describe('a failed migration cannot destroy data', () => {
    it('leaves an unparseable file alone rather than rewriting it', async () => {
      const workspace = await Workspace.initialize({ home: home.path });
      const dir = join(workspace.profilePaths.projectsDir, 'prj_broken');
      await mkdir(dir, { recursive: true });
      const broken = 'this: is: not: valid: yaml: [\n';
      await writeFile(join(dir, 'project.yaml'), broken);

      // Reading reports the problem...
      await new Registry(workspace.store).all();
      expect(workspace.store.getIssues().length).toBeGreaterThan(0);

      // ...and the original bytes are still exactly where they were.
      await expect(readFile(join(dir, 'project.yaml'), 'utf8')).resolves.toBe(broken);
    });

    it('is a pure function, so a throwing migration cannot half-write a record', () => {
      const original = { id: 'x', repository: { identity: 'github.com/a/b' } };
      const snapshot = JSON.stringify(original);
      migrateRecord('project', original);
      // The input object is never mutated in place.
      expect(JSON.stringify(original)).toBe(snapshot);
    });
  });
});
