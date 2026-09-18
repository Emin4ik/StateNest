import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { bullet, failure, heading, print, printJson, style, success } from '../output.js';
import { ProfileSync } from '../../sync/git-sync.js';
import { preserveMachineLocations } from '../../core/adoption.js';
import { writeDataRepoScaffolding } from '../../core/workspace.js';
import { contractHome } from '../../util/paths.js';
import { confirm, closePrompts } from '../prompt.js';
import { BrainError } from '../../util/errors.js';
import { relativeTime } from '../../util/time.js';
import { readMachineLocalState } from '../../core/machine-local.js';
import { recordOutcome, performAutoSync } from '../../sync/auto-sync.js';
import { describeRecordPath, labelRecord } from '../../sync/record-label.js';
import { Registry } from '../../core/registry.js';
import { projectLabels } from '../../core/resolve.js';
import type { Workspace } from '../../core/workspace.js';
import { select } from '../prompt.js';

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
        const sync = new ProfileSync(
          workspace.profilePaths,
          workspace.paths.home,
          preserveMachineLocations(workspace.store, workspace.machineId),
        );

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
      const sync = new ProfileSync(
        workspace.profilePaths,
        workspace.paths.home,
        preserveMachineLocations(workspace.store, workspace.machineId),
      );

      const result = await sync.sync({
        ...(options.message ? { message: options.message } : {}),
        push: options.push,
      });

      // Machine-local, outside the profile directory. Writing any of this into
      // profile.yaml dirtied the repository the sync had just cleaned, and gave
      // every machine a different value for the same synced field.
      await recordOutcome(workspace, result);

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

        case 'conflict': {
          const nameOf = await projectNameResolver(workspace);
          failure('StateNest needs your attention.');
          print('');
          print('  Two machines changed the same thing:');
          print('');
          for (const file of result.conflicts.slice(0, 10)) {
            print(`    ${style.yellow(describeRecordPath(file, nameOf))}`);
          }
          if (result.conflicts.length > 10) {
            print(style.dim(`    ... and ${result.conflicts.length - 10} more`));
          }
          print('');
          if (result.rolledBack) {
            // The rebase was unwound, so this is true and worth saying plainly:
            // the thing users fear here is that their data is stuck or gone.
            print(`  ${style.green('Your local StateNest data is safe and still usable.')}`);
            print(style.dim('  Both versions are kept. Nothing was merged or discarded.'));
          } else {
            print(style.dim('  Both versions are kept. Nothing was merged or discarded.'));
          }
          print('');
          print(style.dim('  To choose, one record at a time:'));
          print(bullet(style.cyan('statenest sync repair')));
          process.exitCode = 1;
          break;
        }

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
    .option('--verbose', 'include the underlying git detail')
    .action(async (options: { verbose?: boolean }) => {
      const { workspace } = await openContext();
      const sync = new ProfileSync(
        workspace.profilePaths,
        workspace.paths.home,
        preserveMachineLocations(workspace.store, workspace.machineId),
      );
      const status = await sync.status();
      const local = await readMachineLocalState(
        workspace.paths,
        workspace.profile.name,
        workspace.profile,
      );

      if (wantsJson()) {
        return printJson({
          profile: workspace.profile.name,
          configured: workspace.profile.sync.enabled,
          last_sync_at: local.last_sync_at,
          auto_sync: local.auto_sync,
          auto_push: local.auto_push,
          health: local.sync_health,
          ...status,
        });
      }

      print('');
      heading(`Sync — profile "${workspace.profile.name}"`);
      print('');

      if (!status.initialised) {
        print(`  ${style.dim('not set up')} — everything stays on this machine`);
        print('');
        print(bullet(style.cyan('statenest setup')));
        print('');
        return;
      }

      // The headline is a sentence about StateNest, not a git status line.
      for (const line of healthLines(local.sync_health, local.last_sync_at, status.dirty)) {
        print(`  ${line}`);
      }
      print('');

      if (local.sync_health.state === 'conflict' && local.sync_health.conflicts.length > 0) {
        const nameOf = await projectNameResolver(workspace);
        for (const file of local.sync_health.conflicts.slice(0, 5)) {
          print(`    ${style.yellow(describeRecordPath(file, nameOf))}`);
        }
        print('');
        print(bullet(style.cyan('statenest sync repair')));
        print('');
      }

      if (!local.auto_sync) {
        print(style.dim('  Automatic sync is off on this machine.'));
        print('');
      }

      if (options.verbose) {
        // Git, on request. Normal use never needs this, but when something is
        // genuinely strange the underlying state should not be hidden.
        print(style.dim('  Underlying git state'));
        print(`    remote      ${status.remote ?? style.dim('none')}`);
        print(`    branch      ${status.branch}`);
        print(`    worktree    ${status.dirty ? style.yellow('uncommitted changes') : style.green('clean')}`);
        if (status.ahead !== null) print(`    ahead       ${status.ahead}`);
        if (status.behind !== null) print(`    behind      ${status.behind}`);
        if (status.lastCommit) print(`    last commit ${style.dim(status.lastCommit)}`);
        print('');
      }
    });

  command
    .command('repair')
    .description('Resolve a sync conflict, one record at a time')
    .option('-y, --yes', 'keep this machine\'s version of everything')
    .action(async (options: { yes?: boolean }) => {
      try {
        const { workspace } = await openContext();
        const sync = new ProfileSync(
          workspace.profilePaths,
          workspace.paths.home,
          preserveMachineLocations(workspace.store, workspace.machineId),
        );
        const local = await readMachineLocalState(
          workspace.paths,
          workspace.profile.name,
          workspace.profile,
        );

        const health = local.sync_health;
        if (health.state !== 'conflict' || !health.conflict_remote_sha) {
          print('');
          success('Nothing to repair.');
          print(style.dim('  No sync conflict is recorded on this machine.'));
          print('');
          return;
        }

        // Project names, so the questions are about work rather than paths.
        // Same resolver the conflict notice uses, so the two cannot disagree
        // about what a record is called.
        const nameOf = await projectNameResolver(workspace);

        const sides = await sync.conflictSides(health.conflict_remote_sha, health.conflicts);
        const choices = new Map<string, 'mine' | 'theirs'>();

        print('');
        heading('Sync conflict');
        print('');
        print(style.dim(`  ${sides.length} record(s) were changed on two machines.`));
        print(style.dim('  Nothing is merged. You choose which version to keep.'));
        print('');

        for (const side of sides) {
          const label = labelRecord(side.path, nameOf);
          print('');
          print(`  ${style.bold(label.title)}`);
          print('');
          print(`    This machine:`);
          print(excerpt(side.mine));
          print('');
          print(`    The other machine:`);
          print(excerpt(side.theirs));
          print('');

          if (options.yes) {
            choices.set(side.path, 'mine');
            continue;
          }

          const answer = await select(
            `  Which version of "${label.title}" should StateNest keep?`,
            [
              { label: 'Keep this machine' },
              { label: 'Keep the other machine' },
            ],
            { defaultIndex: 0 },
          );
          choices.set(side.path, answer === 1 ? 'theirs' : 'mine');
        }

        const result = await sync.repair(health.conflict_remote_sha, choices);
        await recordOutcome(workspace, result);

        print('');
        if (result.outcome === 'synced' || result.outcome === 'up-to-date') {
          success('Sync conflict resolved.');
          print(style.dim('  Your choices are now on every machine that syncs this profile.'));
        } else if (result.outcome === 'offline') {
          success('Sync conflict resolved locally.');
          print(style.dim('  StateNest will send it when the network is back.'));
        } else {
          failure(result.message);
          process.exitCode = 1;
        }
        print('');
      } finally {
        closePrompts();
      }
    });

  // The detached runner a hook or a write spawns. Hidden: it is StateNest
  // talking to itself, and an option list is for the user.
  command
    .command('background', { hidden: true })
    .description('Run a scheduled sync in the background')
    .action(async () => {
      await performAutoSync();
    });

  return command;
}

/**
 * Resolve project ids in conflicting paths to the names a person recognises.
 *
 * `projects/prj_57dh4nhah58x/state.md` means nothing to anybody; "harbour —
 * current state" is the same fact in the user's own vocabulary. `sync repair`
 * already did this, so the first notice they see should not be the one that
 * speaks in ids.
 *
 * Built lazily - only when there is a conflict to describe - so an ordinary
 * sync does not pay to load the registry. Reads StateNest's own store and
 * nothing else; no source repository is touched. Any failure falls back to the
 * id, which is unhelpful but never wrong.
 */
async function projectNameResolver(
  workspace: Workspace,
): Promise<(projectId: string) => string | null> {
  try {
    const labels = projectLabels(await new Registry(workspace.store).all());
    return (projectId) => labels.get(projectId) ?? null;
  } catch {
    // A registry that cannot be read is exactly when a conflict is most likely.
    // Degrade to ids rather than failing the command that explains the problem.
    return () => null;
  }
}

/**
 * The one line that says how sync is doing, in StateNest's own terms.
 *
 * Deliberately never mentions rebase, HEAD or origin. A user who has to learn
 * what a detached HEAD is in order to understand their own notes has been let
 * down by the tool, not by git.
 */
function healthLines(
  health: { state: string; detail: string | null; conflicts: string[] },
  lastSyncAt: string | null,
  dirty: boolean,
): string[] {
  const when = lastSyncAt ? style.dim(` (last synced ${relativeTime(lastSyncAt)})`) : '';

  switch (health.state) {
    case 'conflict':
      return [
        `${style.yellow('⚠')} ${health.conflicts.length} item(s) need your attention.`,
        style.dim('  Your local StateNest data is still usable.'),
      ];
    case 'blocked-by-secrets':
      return [
        `${style.yellow('⚠')} Sync is paused: StateNest found data that may contain a credential.`,
        style.dim('  Nothing was sent. Run: statenest privacy audit'),
      ];
    case 'offline':
      return [
        `${style.dim('○')} Offline — local memory is safe.`,
        style.dim('  StateNest will try again later.'),
      ];
    case 'pending':
      return [`${style.dim('○')} Saved on this machine, waiting to sync.${when}`];
    default:
      return dirty
        ? [`${style.dim('○')} Local updates waiting to sync.${when}`]
        : [`${style.green('✓')} StateNest is up to date.${when}`];
  }
}

/** A few lines of one side of a conflict, enough to choose by. */
function excerpt(content: string | null): string {
  if (content === null) return style.dim('      (this machine does not have this record)');
  const lines = content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  if (lines.length === 0) return style.dim('      (empty)');

  const shown = lines.slice(0, 6).map((line) => `      ${line.slice(0, 100)}`);
  if (lines.length > 6) shown.push(style.dim(`      ... ${lines.length - 6} more line(s)`));
  return shown.join('\n');
}
