import { Command } from 'commander';
import { getGlobalOptions, openContext, wantsJson } from '../context.js';
import { bullet, heading, print, printJson, pluralize, renderTable, style, success } from '../output.js';
import { Workspace, listProfileNames, writeDataRepoScaffolding } from '../../core/workspace.js';
import { createPaths } from '../../core/paths.js';
import { Store } from '../../storage/store.js';
import { Registry } from '../../core/registry.js';
import { contractHome } from '../../util/paths.js';
import { BrainError } from '../../util/errors.js';
import { relativeTime } from '../../util/time.js';

/**
 * Managing profiles.
 *
 * Profiles are the mechanism that keeps work and personal data apart, and
 * before this there was no way to create or list one: the only route was
 * `pb init --profile <name>`, and error messages pointed at `pb profile list`
 * and `pb profile create`, neither of which existed. An error that recommends
 * a command that is not there is worse than no error at all.
 */
export function profileCommand(): Command {
  const command = new Command('profile').description(
    'Separate sets of projects - personal, work, a client - each with its own sync',
  );

  command
    .command('list', { isDefault: true })
    .alias('ls')
    .description('Show every profile on this machine')
    .action(async () => {
      const globals = getGlobalOptions();
      const paths = createPaths(globals.home);
      const names = await listProfileNames(paths);

      if (names.length === 0) {
        if (wantsJson()) return printJson({ profiles: [], active: null });
        print('');
        print('No profiles yet.');
        print('');
        print(bullet(style.cyan('pb init')));
        print('');
        return;
      }

      const rows = [];
      for (const name of names) {
        const store = new Store(paths.profile(name));
        const profile = await store.readProfile();
        const projects = await store.listProjects();
        rows.push({
          name,
          projects: projects.length,
          sync: profile?.sync.enabled ? (profile.sync.remote ?? 'enabled') : 'off',
          created: profile?.created_at ?? null,
        });
      }

      // The active profile depends on config and environment, so read it the
      // same way every other command does rather than guessing.
      let active: string | null = null;
      try {
        active = (await Workspace.open()).profile.name;
      } catch {
        active = null;
      }

      if (wantsJson()) {
        return printJson({ active, profiles: rows });
      }

      print('');
      print(
        renderTable(rows, [
          {
            header: 'profile',
            value: (row) => (row.name === active ? `${row.name} *` : row.name),
            paint: (text, row) => (row.name === active ? style.bold(text) : text),
          },
          { header: 'projects', value: (row) => String(row.projects), align: 'right' },
          { header: 'sync', value: (row) => row.sync, maxWidth: 44 },
          {
            header: 'created',
            value: (row) => (row.created ? relativeTime(row.created) : ''),
            optional: true,
          },
        ]),
      );
      print('');
      if (active) print(style.dim(`* active. Use another with: pb --profile <name> <command>`));
      print('');
    });

  command
    .command('create')
    .description('Create a profile')
    .argument('<name>', 'lowercase name, for example: work')
    .option('--roots <dirs...>', 'directories this profile should scan')
    .action(async (name: string, options: { roots?: string[] }) => {
      const globals = getGlobalOptions();
      const paths = createPaths(globals.home);

      if ((await listProfileNames(paths)).includes(name)) {
        throw new BrainError('PROFILE_EXISTS', `A profile called "${name}" already exists.`, {
          hints: ['pb profile list', `pb --profile ${name} projects`],
        });
      }

      const workspace = await Workspace.initialize({
        ...(globals.home ? { home: globals.home } : {}),
        profileName: name,
        ...(options.roots ? { projectRoots: options.roots } : {}),
      });
      await writeDataRepoScaffolding(workspace.profilePaths);

      if (wantsJson()) {
        return printJson({ created: workspace.profile.name, path: workspace.profilePaths.root });
      }

      success(`Created profile ${style.bold(workspace.profile.name)}`);
      print(`  ${style.dim(contractHome(workspace.profilePaths.root))}`);
      print('');
      print(style.dim('  It is completely separate: its own projects, its own sync remote.'));
      print('');
      print(bullet(style.cyan(`pb --profile ${workspace.profile.name} scan ~/Work`)));
      print(bullet(style.cyan(`pb --profile ${workspace.profile.name} sync init <private-repo>`)));
      print('');
      print(
        style.dim(
          `  To avoid typing --profile every time: export PROJECT_BRAIN_PROFILE=${workspace.profile.name}`,
        ),
      );
      print('');
    });

  command
    .command('use')
    .description('Set the profile used when none is given')
    .argument('<name>', 'profile name')
    .action(async (name: string) => {
      const globals = getGlobalOptions();
      const paths = createPaths(globals.home);
      const available = await listProfileNames(paths);

      if (!available.includes(name)) {
        throw new BrainError('UNKNOWN_PROFILE', `No profile called "${name}".`, {
          details: available.length > 0 ? [`Available: ${available.join(', ')}`] : [],
          hints: [`pb profile create ${name}`, 'pb profile list'],
        });
      }

      const workspace = await Workspace.open();
      await workspace.saveConfig({ ...workspace.config, default_profile: name });

      if (wantsJson()) return printJson({ default_profile: name });
      success(`Default profile is now ${style.bold(name)}`);
      print(
        style.dim('  A PROJECT_BRAIN_PROFILE environment variable still takes precedence over this.'),
      );
    });

  command
    .command('show')
    .description('Details of the active profile')
    .action(async () => {
      const { workspace } = await openContext();
      const projects = await new Registry(workspace.store).all();

      if (wantsJson()) {
        return printJson({
          name: workspace.profile.name,
          path: workspace.profilePaths.root,
          projects: projects.length,
          project_roots: workspace.profile.project_roots,
          privacy: workspace.profile.privacy,
          sync: workspace.profile.sync,
        });
      }

      print('');
      heading(workspace.profile.name);
      print('');
      print(`  ${style.dim('data')}         ${contractHome(workspace.profilePaths.root)}`);
      print(`  ${style.dim('projects')}     ${pluralize(projects.length, 'project')}`);
      print(
        `  ${style.dim('scan roots')}   ${workspace.profile.project_roots.join(', ') || style.dim('none set')}`,
      );
      print(
        `  ${style.dim('sync')}         ${
          workspace.profile.sync.enabled
            ? (workspace.profile.sync.remote ?? 'enabled')
            : style.dim('off - nothing leaves this machine')
        }`,
      );
      print('');
    });

  return command;
}
