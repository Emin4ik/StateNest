import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { bullet, failure, heading, print, printJson, style, success } from '../output.js';
import { ProfileSync } from '../../sync/git-sync.js';
import { writeDataRepoScaffolding } from '../../core/workspace.js';
import { contractHome } from '../../util/paths.js';
import { confirm, closePrompts } from '../prompt.js';
import { BrainError } from '../../util/errors.js';
import { readMachineLocalState, recordSyncCompleted } from '../../core/machine-local.js';

export function syncCommand(): Command {
  const command = new Command('sync').description(
    'Optionally mirror this profile to a private git repository you own',
  );

  command
    .command('init')
    .description('Point this profile at a private git repository')
    .argument('<remote>', 'git remote URL of a PRIVATE repository you own')
    .option('--branch <branch>', 'branch to sync', 'main')
    .option('-y, --yes', 'do not prompt')
    .action(async (remote: string, options: { branch: string; yes?: boolean }) => {
      try {
        const { workspace } = await openContext();
        const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);

        // Validate before saying anything else. Printing a privacy warning and
        // asking for confirmation about a string that is not a git remote asks
        // the user to think about the wrong problem.
        // A remote is acceptable if it is a real hosted repository, or a local
        // path that actually exists (a bare repo on a NAS is a legitimate
        // backup target). Anything else - a typo, a sentence - is rejected
        // before the user is asked to think about privacy.
        const { normalizeRemoteUrl } = await import('../../git/remote-url.js');
        const { pathExists } = await import('../../util/fs-atomic.js');
        const parsed = normalizeRemoteUrl(remote);
        const isLocalPath = parsed !== null && !parsed.stableAcrossMachines;

        if (!parsed || (isLocalPath && !(await pathExists(parsed.path)))) {
          throw new BrainError('INVALID_REMOTE', `"${remote}" is not a git remote.`, {
            details: [
              isLocalPath
                ? 'It looks like a local path, but nothing exists there.'
                : 'It is not a recognisable git URL.',
            ],
            hints: [
              'statenest sync init git@github.com:you/statenest-data.git',
              'statenest sync init https://github.com/you/statenest-data.git',
              'Create the repository first - it must be PRIVATE.',
            ],
          });
        }

        if (isLocalPath) {
          print('');
          print(
            style.yellow('  That is a local path, so it is a backup on this machine only.'),
          );
          print(style.dim('  It will not carry your data to another computer.'));
        }

        print('');
        heading(`Sync profile "${workspace.profile.name}"`);
        print('');
        print(`  from  ${style.dim(contractHome(workspace.profilePaths.root))}`);
        print(`  to    ${style.cyan(remote)}`);
        print('');
        print(style.yellow('  This repository must be private.'));
        print(
          style.dim(
            '  It will contain your project names, notes, server addresses and\n' +
              '  deploy paths. None of that belongs in a public repository.',
          ),
        );
        print('');

        const confirmed = await confirm('That repository is private. Continue?', {
          defaultValue: false,
          assumeYes: Boolean(options.yes),
        });
        if (!confirmed) {
          print('Cancelled. Nothing was changed.');
          return;
        }

        await writeDataRepoScaffolding(workspace.profilePaths);
        await sync.initialise(remote, options.branch);
        await workspace.saveProfile({
          ...workspace.profile,
          sync: {
            ...workspace.profile.sync,
            enabled: true,
            remote,
            branch: options.branch,
          },
        });

        success('Sync configured');
        print('');
        print(style.dim('  Nothing has been sent yet. When you are ready:'));
        print(bullet(style.cyan('statenest sync')));
        print('');
        print(
          style.dim('  Every sync scans your data for credentials first and refuses to send if it finds any.'),
        );
        print('');
      } finally {
        closePrompts();
      }
    });

  command
    .command('run', { isDefault: true })
    .description('Pull, commit and push this profile')
    .option('-m, --message <text>', 'commit message')
    .option('--no-push', 'commit locally without pushing')
    .action(async (options: { message?: string; push: boolean }) => {
      const { workspace } = await openContext();
      const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);

      const result = await sync.sync({
        ...(options.message ? { message: options.message } : {}),
        push: options.push,
      });

      if (result.outcome === 'synced' || result.outcome === 'up-to-date') {
        // Machine-local, outside the profile directory. Writing this into
        // profile.yaml dirtied the repository the sync had just cleaned, and
        // gave every machine a different value for the same synced field.
        await recordSyncCompleted(workspace.paths, workspace.profile.name, workspace.profile);
      }

      if (wantsJson()) {
        printJson(result);
        if (result.outcome === 'blocked-by-secrets' || result.outcome === 'conflict') {
          process.exitCode = 1;
        }
        return;
      }

      print('');
      switch (result.outcome) {
        case 'not-configured':
          print('Sync is not set up for this profile.');
          print('');
          print(bullet(style.cyan('statenest sync init git@github.com:you/statenest-data.git')));
          break;

        case 'blocked-by-secrets':
          failure(result.message);
          print('');
          for (const blocker of result.blockers.slice(0, 10)) {
            print(`    ${style.yellow(blocker)}`);
          }
          if (result.blockers.length > 10) {
            print(style.dim(`    ... and ${result.blockers.length - 10} more`));
          }
          print('');
          print(style.dim('  The values above are masked. Remove them, rotate them, then:'));
          print(bullet(style.cyan('statenest privacy audit')));
          process.exitCode = 1;
          break;

        case 'conflict':
          failure('Two machines changed the same record.');
          print('');
          for (const file of result.conflicts.slice(0, 10)) print(`    ${style.yellow(file)}`);
          print('');
          print(style.dim('  Nothing was lost. Both versions are in the files above, in git.'));
          print('');

          // profile.yaml is a control file: while it holds conflict markers
          // most commands stop working, and a user who does not know that may
          // reach for something destructive. Say what not to do, once.
          if (result.conflicts.some((file) => file.endsWith('profile.yaml'))) {
            print(style.yellow('  Until this is resolved, most commands will say the profile'));
            print(style.yellow('  cannot be read. That is this conflict, not lost data.'));
            print(style.dim('  Do not create a replacement profile, and do not delete'));
            print(style.dim(`  ${contractHome(workspace.paths.home)} — everything is still here.`));
            print('');
          }

          print(style.dim('  Edit the files above to keep what you want, then:'));
          print(bullet(style.cyan('git -C ' + contractHome(workspace.profilePaths.root) + ' add <file>')));
          print(bullet(style.cyan('git -C ' + contractHome(workspace.profilePaths.root) + ' rebase --continue')));
          print(bullet(style.cyan('statenest sync')));
          print('');
          print(style.dim('  Or back out of this sync entirely and try again later:'));
          print(bullet(style.cyan('git -C ' + contractHome(workspace.profilePaths.root) + ' rebase --abort')));
          process.exitCode = 1;
          break;

        case 'offline':
          print(`${style.yellow('Offline')} — ${result.message}`);
          break;

        case 'local-only':
          print(`${style.yellow('Committed locally')} — ${result.message}`);
          break;

        default:
          success(result.message);
      }
      print('');
    });

  command
    .command('status')
    .description('Show the sync state of this profile')
    .action(async () => {
      const { workspace } = await openContext();
      const sync = new ProfileSync(workspace.profilePaths, workspace.paths.home);
      const status = await sync.status();

      if (wantsJson()) {
        return printJson({
          profile: workspace.profile.name,
          configured: workspace.profile.sync.enabled,
          last_sync_at: (
            await readMachineLocalState(workspace.paths, workspace.profile.name, workspace.profile)
          ).last_sync_at,
          ...status,
        });
      }

      print('');
      heading(`Sync — profile "${workspace.profile.name}"`);
      print('');
      if (!status.initialised) {
        print(`  ${style.dim('not configured')} — everything stays on this machine`);
        print('');
        print(bullet(style.cyan('statenest sync init <private-repo-url>')));
        print('');
        return;
      }

      print(`  remote      ${status.remote ?? style.dim('none')}`);
      print(`  branch      ${status.branch}`);
      print(`  local       ${status.dirty ? style.yellow('uncommitted changes') : style.green('clean')}`);
      if (status.ahead !== null) print(`  ahead       ${status.ahead}`);
      if (status.behind !== null) print(`  behind      ${status.behind}`);
      if (status.lastCommit) print(`  last commit ${style.dim(status.lastCommit)}`);
      print('');
    });

  return command;
}
