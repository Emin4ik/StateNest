import { Command } from 'commander';
import { cp, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { openContext, wantsJson } from '../context.js';
import { bullet, heading, print, printJson, pluralize, style, success } from '../output.js';
import { closePrompts, confirm } from '../prompt.js';
import { readFileOrNull, writeFileAtomic } from '../../util/fs-atomic.js';
import { serializeYaml } from '../../storage/yaml-file.js';
import {
  CURRENT_SCHEMA_VERSION,
  migrateRecord,
  readVersion,
  type RecordKind,
} from '../../core/migrations.js';
import { contractHome } from '../../util/paths.js';
import type { ProfilePaths } from '../../core/paths.js';
import { now } from '../../util/time.js';

/**
 * Bring stored records up to the current schema version.
 *
 * Migration is applied transparently on *read*, so nothing is broken before
 * this runs - it exists to write the migrated form back so the files on disk
 * match what the code expects, and so a future migration starts from a known
 * state.
 *
 * It always takes a backup first, and it is a no-op by default: `--dry-run`
 * shows what would change, and the write requires confirmation. A migration
 * that destroyed a user's memory would be the single worst bug this tool could
 * have.
 */
export function migrateCommand(): Command {
  return new Command('migrate')
    .description('Bring stored records up to the current schema version')
    .option('--dry-run', 'show what would change, write nothing', false)
    .option('-y, --yes', 'do not prompt')
    .option('--all-profiles', 'migrate every profile, not just the active one')
    .action(async (options: { dryRun?: boolean; yes?: boolean; allProfiles?: boolean }) => {
      try {
        const { workspace } = await openContext();
        const { listProfileNames } = await import('../../core/workspace.js');

        const profileNames = options.allProfiles
          ? await listProfileNames(workspace.paths)
          : [workspace.profile.name];

        const plans: ProfilePlan[] = [];
        for (const name of profileNames) {
          plans.push(await planProfile(workspace.paths.profile(name), name));
        }

        const pending = plans.filter((plan) => plan.changes.length > 0);
        const future = plans.flatMap((plan) => plan.fromFuture);

        if (wantsJson()) {
          printJson({
            current_schema_version: CURRENT_SCHEMA_VERSION,
            profiles: plans.map((plan) => ({
              profile: plan.profile,
              records_scanned: plan.scanned,
              changes: plan.changes.map((change) => ({
                file: change.relativePath,
                from_version: change.fromVersion,
                applied: change.applied,
              })),
              from_future: plan.fromFuture,
            })),
            dry_run: Boolean(options.dryRun),
          });
          return;
        }

        print('');
        heading(`Schema migration (current version: ${CURRENT_SCHEMA_VERSION})`);
        print('');

        if (future.length > 0) {
          print(
            style.yellow(
              `  ${pluralize(future.length, 'record')} came from a NEWER version of Project Brain.`,
            ),
          );
          print(style.dim('  These are left completely untouched, and their extra fields are'));
          print(style.dim('  preserved. Update Project Brain so it understands them fully:'));
          print(bullet(style.cyan('npm install -g project-brain@latest')));
          print('');
        }

        if (pending.length === 0) {
          success(`Everything is already at schema version ${CURRENT_SCHEMA_VERSION}.`);
          print(
            style.dim(
              `  ${pluralize(
                plans.reduce((sum, plan) => sum + plan.scanned, 0),
                'record',
              )} checked.`,
            ),
          );
          print('');
          return;
        }

        for (const plan of pending) {
          print(`  ${style.bold(plan.profile)}  ${pluralize(plan.changes.length, 'record')} to migrate`);
          for (const change of plan.changes.slice(0, 10)) {
            print(`    ${style.dim(`v${change.fromVersion} -> v${CURRENT_SCHEMA_VERSION}`)}  ${change.relativePath}`);
            for (const applied of change.applied) print(`      ${style.dim(applied)}`);
          }
          if (plan.changes.length > 10) {
            print(style.dim(`    ... and ${plan.changes.length - 10} more`));
          }
          print('');
        }

        if (options.dryRun) {
          print(style.dim('  Nothing was written. Re-run without --dry-run to apply.'));
          print('');
          return;
        }

        const confirmed = await confirm('  Apply these migrations?', {
          defaultValue: true,
          assumeDefaults: Boolean(options.yes),
        });
        if (!confirmed) {
          print('  Cancelled. Nothing was changed.');
          return;
        }

        // Back up before touching anything. A migration is the one operation
        // that rewrites files the user cannot reconstruct.
        const backupRoot = join(workspace.paths.backupsDir, `pre-migration-${now().replace(/[:]/g, '')}`);
        await mkdir(backupRoot, { recursive: true });

        let migrated = 0;
        for (const plan of pending) {
          await cp(plan.root, join(backupRoot, plan.profile), { recursive: true });
          for (const change of plan.changes) {
            await writeFileAtomic(change.absolutePath, serializeYaml(change.migrated));
            migrated++;
          }
        }

        print('');
        success(`Migrated ${pluralize(migrated, 'record')} to schema version ${CURRENT_SCHEMA_VERSION}`);
        print(`  ${style.dim(`backup: ${contractHome(backupRoot)}`)}`);
        print('');
        print(bullet(style.cyan('pb doctor')));
        print('');
      } finally {
        closePrompts();
      }
    });
}

interface RecordChange {
  relativePath: string;
  absolutePath: string;
  fromVersion: number;
  applied: string[];
  migrated: Record<string, unknown>;
}

interface ProfilePlan {
  profile: string;
  root: string;
  scanned: number;
  changes: RecordChange[];
  fromFuture: string[];
}

/** Every YAML record in a profile, with the kind it should be migrated as. */
async function planProfile(paths: ProfilePaths, profileName: string): Promise<ProfilePlan> {
  const targets: { file: string; kind: RecordKind }[] = [{ file: paths.profileFile, kind: 'profile' }];

  const { listDirectories, listFiles } = await import('../../storage/store.js');

  for (const projectDir of await listDirectories(paths.projectsDir)) {
    targets.push({ file: join(paths.projectsDir, projectDir, 'project.yaml'), kind: 'project' });
    targets.push({ file: join(paths.projectsDir, projectDir, 'tasks.yaml'), kind: 'tasks' });
  }
  for (const name of await listFiles(paths.machinesDir, '.yaml')) {
    targets.push({ file: join(paths.machinesDir, name), kind: 'machine' });
  }
  for (const name of await listFiles(paths.remotesDir, '.yaml')) {
    targets.push({ file: join(paths.remotesDir, name), kind: 'remote' });
  }

  const changes: RecordChange[] = [];
  const fromFuture: string[] = [];
  let scanned = 0;

  for (const target of targets) {
    const raw = await readFileOrNull(target.file);
    if (raw === null) continue;

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      // Unparseable files are `pb doctor`'s business. A migration must never
      // try to rewrite something it could not read.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    scanned++;

    const result = migrateRecord(target.kind, parsed);
    if (result.fromFuture) {
      fromFuture.push(basename(target.file));
      continue;
    }
    if (result.applied.length === 0) continue;

    changes.push({
      relativePath: target.file.slice(paths.root.length + 1),
      absolutePath: target.file,
      fromVersion: readVersion(parsed),
      applied: result.applied,
      migrated: result.value,
    });
  }

  return { profile: profileName, root: paths.root, scanned, changes, fromFuture };
}
