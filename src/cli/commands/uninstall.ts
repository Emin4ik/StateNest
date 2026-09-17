import { Command } from 'commander';
import { rm } from 'node:fs/promises';
import { createPaths } from '../../core/paths.js';
import { getGlobalOptions, wantsJson } from '../context.js';
import { bullet, heading, print, printJson, style, success } from '../output.js';
import { closePrompts, confirm, select } from '../prompt.js';
import { uninstallClaudeIntegration } from '../../integrations/claude/install.js';
import { contractHome } from '../../util/paths.js';
import { pathExists } from '../../util/fs-atomic.js';

/**
 * Removing Project Brain.
 *
 * A tool that is hard to remove is a tool people hesitate to install. The
 * default here removes integrations and leaves every byte of the user's data
 * alone; deleting their memory is a separate, explicit, confirmed choice that
 * states exactly what will be lost first.
 */
export function uninstallCommand(): Command {
  return new Command('uninstall')
    .description('Remove Project Brain integrations, and optionally its data')
    .option('--integrations-only', 'remove coding-agent integrations, keep everything else')
    .option('--all', 'also delete all Project Brain data (asks first)')
    .option('-y, --yes', 'do not prompt (never implies --all)')
    .action(async (options: UninstallOptions) => {
      try {
        const globals = getGlobalOptions();
        const paths = createPaths(globals.home);
        const dataExists = await pathExists(paths.home);

        print('');
        heading('Uninstall Project Brain');
        print('');

        // -- Always: integrations --------------------------------------------
        const claude = await uninstallClaudeIntegration({ removeMarketplace: true });
        if (claude.removed) success('Claude Code integration removed');
        else print(`  ${style.dim(claude.message)}`);

        // -- Data ------------------------------------------------------------
        let dataRemoved = false;

        if (dataExists && !options.integrationsOnly) {
          const counts = await summarize(paths.home);

          print('');
          print(`  Your data is at ${style.bold(contractHome(paths.home))}`);
          print(
            style.dim(
              `  ${counts.projects} project record(s), ${counts.checkpoints} checkpoint(s), ${counts.profiles} profile(s)`,
            ),
          );
          print('');

          const choice = options.all
            ? 1
            : await select(
                style.bold('  What should happen to it?'),
                [
                  { label: 'Keep it', hint: 'recommended - reinstalling picks up where you left off' },
                  { label: 'Delete it permanently', hint: 'cannot be undone' },
                ],
                { defaultIndex: 0, assumeDefaults: Boolean(options.yes) },
              );

          if (choice === 1) {
            print('');
            print(style.yellow('  This permanently deletes every project record, checkpoint,'));
            print(style.yellow('  decision and note Project Brain has stored.'));
            if (counts.hasSync) {
              print(
                style.dim('  Your synced git repository is not touched; you could re-clone it.'),
              );
            }
            print('');

            // `--yes` deliberately does not confirm a delete. Skipping prompts
            // is a convenience; destroying data silently is not.
            const confirmed = await confirm('  Delete it permanently?', {
              defaultValue: false,
            });

            if (confirmed) {
              await rm(paths.home, { recursive: true, force: true });
              dataRemoved = true;
              success('Data deleted');
            } else {
              print('  Kept.');
            }
          } else {
            print(`  ${style.dim('Kept.')}`);
          }
        }

        if (wantsJson()) {
          printJson({
            integrations_removed: claude.removed,
            data_removed: dataRemoved,
            data_path: paths.home,
          });
          return;
        }

        print('');
        print(style.dim('  The CLI itself is an npm package:'));
        print(bullet(style.cyan('npm uninstall -g project-brain')));
        if (!dataRemoved && dataExists) {
          print('');
          print(style.dim(`  Your data remains at ${contractHome(paths.home)}.`));
          print(style.dim('  Reinstalling picks up exactly where you left off.'));
        }
        print('');
      } finally {
        closePrompts();
      }
    });
}

interface UninstallOptions {
  integrationsOnly?: boolean;
  all?: boolean;
  yes?: boolean;
}

/** Count what is about to be lost, so the warning is specific rather than vague. */
async function summarize(home: string): Promise<{
  projects: number;
  checkpoints: number;
  profiles: number;
  hasSync: boolean;
}> {
  const { listDirectories } = await import('../../storage/store.js');
  const { join } = await import('node:path');

  const profiles = await listDirectories(join(home, 'profiles'));
  let projects = 0;
  let checkpoints = 0;
  let hasSync = false;

  for (const profile of profiles) {
    const root = join(home, 'profiles', profile);
    projects += (await listDirectories(join(root, 'projects'))).length;
    if (await pathExists(join(root, '.git'))) hasSync = true;

    for (const projectId of await listDirectories(join(root, 'checkpoints'))) {
      for (const year of await listDirectories(join(root, 'checkpoints', projectId))) {
        for (const month of await listDirectories(join(root, 'checkpoints', projectId, year))) {
          for (const day of await listDirectories(
            join(root, 'checkpoints', projectId, year, month),
          )) {
            const { listFiles } = await import('../../storage/store.js');
            checkpoints += (
              await listFiles(join(root, 'checkpoints', projectId, year, month, day), '.md')
            ).length;
          }
        }
      }
    }
  }

  return { projects, checkpoints, profiles: profiles.length, hasSync };
}
