import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { getGlobalOptions, openContext, wantsJson } from '../context.js';
import { bullet, heading, print, printJson, pluralize, style, success } from '../output.js';
import { closePrompts, confirm } from '../prompt.js';
import { contractHome } from '../../util/paths.js';
import { pathExists } from '../../util/fs-atomic.js';
import { auditProfile, describeBlock, hasBlockingFindings } from '../../security/audit.js';
import { BrainError } from '../../util/errors.js';
import { createPaths } from '../../core/paths.js';

const execFileAsync = promisify(execFile);

/**
 * Backup and restore.
 *
 * Uses `tar` rather than a bundled archive library: it is present on every
 * platform we target (Windows has shipped bsdtar since Windows 10 1803), and a
 * backup the user can open with tools they already have is worth more than one
 * only Project Brain can read.
 */
export function exportCommand(): Command {
  return new Command('export')
    .description('Write a backup archive of your Project Brain data')
    .argument('[file]', 'archive to write', 'project-brain-backup.tar.gz')
    .option('--profile-only', 'export only the active profile')
    .option('--skip-audit', 'skip the secret scan (not recommended)')
    .action(async (file: string, options: { profileOnly?: boolean; skipAudit?: boolean }) => {
      const { workspace } = await openContext();
      const target = resolve(file);

      // An archive is data leaving the safety of the home directory - it gets
      // the same scan a sync would.
      if (!options.skipAudit) {
        const audit = await auditProfile(workspace.profilePaths);
        if (hasBlockingFindings(audit)) {
          throw new BrainError(
            'EXPORT_BLOCKED',
            'Export stopped: something in your data looks like a credential.',
            {
              details: describeBlock(audit).slice(0, 8),
              hints: ['pb privacy audit', 'Remove and rotate it, then export again.'],
            },
          );
        }
      }

      await mkdir(dirname(target), { recursive: true });

      // Machine-local state is excluded: an archive restored onto a different
      // computer must not tell it that it is the machine the backup came from.
      const source = options.profileOnly ? workspace.profilePaths.root : workspace.paths.home;
      const args = [
        '-czf',
        target,
        '--exclude',
        'cache',
        '--exclude',
        'logs',
        '--exclude',
        'backups',
        '--exclude',
        'machine.json',
        '-C',
        dirname(source),
        basename(source),
      ];

      const result = await execFileAsync('tar', args, { timeout: 300_000 }).catch(
        (error: { stderr?: string; message?: string }) => {
          throw new BrainError('EXPORT_FAILED', 'Could not write the archive.', {
            details: [error.stderr?.trim() || error.message || 'tar failed'],
            hints: ['Check that `tar` is available and the destination is writable.'],
          });
        },
      );
      void result;

      const size = (await stat(target)).size;

      if (wantsJson()) {
        return printJson({ file: target, bytes: size, profile: workspace.profile.name });
      }

      success(`Exported to ${contractHome(target)}`);
      print(`  ${style.dim(`${(size / 1024).toFixed(0)}KB · profile: ${workspace.profile.name}`)}`);
      print(
        `  ${style.dim('Machine identity, caches and logs are excluded - they are specific to this computer.')}`,
      );
    });
}

export function importCommand(): Command {
  return new Command('import')
    .description('Restore Project Brain data from a backup archive')
    .argument('<file>', 'archive to restore')
    .option('--force', 'overwrite existing data')
    .option('-y, --yes', 'do not prompt')
    .action(async (file: string, options: { force?: boolean; yes?: boolean }) => {
      try {
        const globals = getGlobalOptions();
        const paths = createPaths(globals.home);
        const archive = resolve(file);

        if (!(await pathExists(archive))) {
          throw new BrainError('ARCHIVE_NOT_FOUND', `${contractHome(archive)} does not exist.`);
        }

        const existing = await pathExists(paths.configFile);
        if (existing && !options.force) {
          print('');
          print(`  Project Brain data already exists at ${style.bold(contractHome(paths.home))}`);
          print(
            style.dim(
              '  Importing merges the archive over it. Files with the same name are replaced.',
            ),
          );
          print('');

          const confirmed = await confirm('  Continue?', {
            defaultValue: false,
            assumeDefaults: Boolean(options.yes),
          });
          if (!confirmed) {
            print('Cancelled. Nothing was changed.');
            return;
          }
        }

        // Restore into a staging directory first, so a corrupt archive cannot
        // half-overwrite a working installation.
        const staging = `${paths.home}.import-${process.pid}`;
        await mkdir(staging, { recursive: true });

        try {
          await execFileAsync('tar', ['-xzf', archive, '-C', staging], { timeout: 300_000 });

          const { listDirectories } = await import('../../storage/store.js');
          const roots = await listDirectories(staging);
          if (roots.length === 0) {
            throw new BrainError('EMPTY_ARCHIVE', 'The archive contained nothing to restore.');
          }

          const { cp } = await import('node:fs/promises');
          const { join } = await import('node:path');
          await mkdir(paths.home, { recursive: true });
          for (const root of roots) {
            await cp(join(staging, root), paths.home, { recursive: true, force: true });
          }

          // The importing machine keeps its own identity; the archive does not
          // carry one, and inheriting one would make two computers claim to be
          // the same machine.
          const { readOrCreateMachineId } = await import('../../core/workspace.js');
          const machineId = await readOrCreateMachineId(paths);

          if (wantsJson()) {
            return printJson({ imported: archive, home: paths.home, machine_id: machineId });
          }

          print('');
          success(`Restored into ${contractHome(paths.home)}`);
          const { listProfileNames } = await import('../../core/workspace.js');
          const profiles = await listProfileNames(paths);
          print(`  ${style.dim(`${pluralize(profiles.length, 'profile')}: ${profiles.join(', ')}`)}`);
          print(`  ${style.dim(`this machine: ${machineId}`)}`);
          print('');
          print(bullet(style.cyan('pb projects')));
          print(bullet(style.cyan('pb doctor')));
          print('');
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      } finally {
        closePrompts();
      }
    });
}

export { heading };
