import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { bullet, print, printJson, pluralize, renderTable, style, success } from '../output.js';
import { closePrompts, multiSelect } from '../prompt.js';
import { readSshConfig, guessEnvironment, usableHosts } from '../../remotes/ssh-config.js';
import { DeploymentSchema, RemoteSchema, type Remote } from '../../core/schema.js';
import { randomId } from '../../util/ids.js';
import { now } from '../../util/time.js';
import { BrainError } from '../../util/errors.js';

export function remoteCommand(): Command {
  const command = new Command('remote').description('Servers you deploy to');

  command
    .command('list', { isDefault: true })
    .alias('ls')
    .description('List registered servers')
    .action(async () => {
      const { workspace } = await openContext();
      const remotes = await workspace.store.listRemotes();
      const projects = await workspace.store.listProjects();

      const usage = new Map<string, string[]>();
      for (const project of projects) {
        for (const deployment of project.deployments) {
          const list = usage.get(deployment.remote_id) ?? [];
          list.push(project.name);
          usage.set(deployment.remote_id, list);
        }
      }

      if (wantsJson()) {
        return printJson({
          remotes: remotes.map((remote) => ({ ...remote, projects: usage.get(remote.id) ?? [] })),
        });
      }

      if (remotes.length === 0) {
        print('No servers registered yet.');
        print('');
        print(bullet(style.cyan('pb remote import-ssh') + style.dim('   pick from your ~/.ssh/config')));
        print(bullet(style.cyan('pb remote add <name> --ssh-alias <alias>')));
        return;
      }

      print('');
      print(
        renderTable(remotes, [
          { header: 'server', value: (r) => r.name, paint: (t) => style.bold(t) },
          { header: 'environment', value: (r) => r.environment },
          { header: 'address', value: (r) => r.ssh_alias ?? r.host ?? style.dim('not set') },
          { header: 'type', value: (r) => r.type, optional: true },
          {
            header: 'projects',
            value: (r) => (usage.get(r.id) ?? []).join(', '),
            optional: true,
            maxWidth: 34,
            paint: (t) => style.dim(t),
          },
        ]),
      );
      print('');
      print(style.dim('Project Brain stores addresses only. Authentication stays with your ssh config.'));
      print('');
    });

  command
    .command('add')
    .description('Register a server')
    .argument('<name>', 'what to call it')
    .option('--ssh-alias <alias>', 'alias from your ~/.ssh/config')
    .option('--host <host>', 'hostname or IP')
    .option('--user <user>', 'login user')
    .option('--port <port>', 'ssh port', (v) => Number.parseInt(v, 10))
    .option('--env <environment>', 'production | staging | development | testing | other', 'production')
    .option('--type <type>', 'vps | dedicated | cloud-instance | container-host | other', 'vps')
    .option('--provider <provider>', 'who hosts it')
    .option('--notes <text>', 'anything worth remembering')
    .action(async (name: string, options: AddRemoteOptions) => {
      const { workspace } = await openContext();

      if (!options.sshAlias && !options.host) {
        throw new BrainError('MISSING_ADDRESS', 'A server needs an ssh alias or a hostname.', {
          hints: [
            `pb remote add ${name} --ssh-alias ${name}`,
            `pb remote add ${name} --host 203.0.113.10 --user deploy`,
          ],
        });
      }

      const timestamp = now();
      const remote = RemoteSchema.parse({
        id: randomId('remote', 8),
        name,
        type: options.type,
        environment: options.env,
        ...(options.sshAlias ? { ssh_alias: options.sshAlias } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.user ? { user: options.user } : {}),
        ...(options.port ? { port: options.port } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.notes ? { notes: options.notes } : {}),
        created_at: timestamp,
        updated_at: timestamp,
      });

      await workspace.store.saveRemote(remote);
      if (wantsJson()) return printJson(remote);
      success(`Registered ${style.bold(remote.name)} (${remote.environment})`);
    });

  command
    .command('remove')
    .alias('rm')
    .description('Remove a server record')
    .argument('<name>', 'server name or id')
    .action(async (term: string) => {
      const { workspace } = await openContext();
      const remote = await resolveRemote(workspace, term);
      await workspace.store.deleteRemote(remote.id);
      success(`Removed ${remote.name}`);
    });

  command
    .command('import-ssh')
    .description('Pick servers to register from your ~/.ssh/config')
    .option('--file <path>', 'a different ssh config file')
    .option('--include-includes', 'also read files named by Include directives')
    .option('-y, --yes', 'register every candidate without asking')
    .action(async (options: ImportOptions) => {
      try {
        const { workspace } = await openContext();
        const candidates = usableHosts(
          await readSshConfig(options.file, {
            ...(options.includeIncludes ? { followIncludes: true } : {}),
          }),
        );

        if (candidates.length === 0) {
          print('No usable hosts found in your ssh config.');
          return;
        }

        const existing = await workspace.store.listRemotes();
        const known = new Set(existing.map((remote) => remote.ssh_alias).filter(Boolean));
        const fresh = candidates.filter((candidate) => !known.has(candidate.alias));

        if (fresh.length === 0) {
          print(`All ${candidates.length} ssh hosts are already registered.`);
          return;
        }

        if (wantsJson()) {
          return printJson({
            candidates: fresh.map((candidate) => ({
              alias: candidate.alias,
              hostname: candidate.hostname,
              user: candidate.user,
              port: candidate.port,
              suggested_environment: guessEnvironment(candidate.alias),
            })),
            note: 'Nothing was imported. Run without --json to choose interactively.',
          });
        }

        print('');
        print(style.dim('Project Brain will store only the alias, hostname, user and port.'));
        print(style.dim('It never reads or stores keys, passwords or anything they point to.'));

        // Nothing is pre-ticked. An ssh config routinely holds employer and
        // client infrastructure, so importing is opt-in per host, every time.
        const chosen = await multiSelect(
          style.bold(`\nWhich of these should Project Brain remember?`),
          fresh.map((candidate) => ({
            label: candidate.alias,
            hint: [
              candidate.hostname,
              candidate.user ? `as ${candidate.user}` : null,
              candidate.port ? `:${candidate.port}` : null,
              guessEnvironment(candidate.alias),
            ]
              .filter(Boolean)
              .join('  '),
            selected: false,
          })),
          { assumeDefaults: Boolean(options.yes) },
        );

        const selected = options.yes ? fresh.map((_, index) => index) : chosen;
        if (selected.length === 0) {
          print('');
          print('Nothing imported.');
          return;
        }

        const timestamp = now();
        for (const index of selected) {
          const candidate = fresh[index]!;
          await workspace.store.saveRemote(
            RemoteSchema.parse({
              id: randomId('remote', 8),
              name: candidate.alias,
              type: 'vps',
              environment: guessEnvironment(candidate.alias),
              ssh_alias: candidate.alias,
              ...(candidate.hostname ? { host: candidate.hostname } : {}),
              ...(candidate.user ? { user: candidate.user } : {}),
              ...(candidate.port ? { port: candidate.port } : {}),
              created_at: timestamp,
              updated_at: timestamp,
            }),
          );
        }

        print('');
        success(`Registered ${pluralize(selected.length, 'server')}`);
        print('');
        print(bullet(style.cyan('pb remote list')));
        print(bullet(style.cyan('pb deploy add <project> --remote <server> --path /opt/app')));
      } finally {
        closePrompts();
      }
    });

  return command;
}

/** `pb deploy` links a project to a server. Kept separate from `pb remote`. */
export function deployCommand(): Command {
  const command = new Command('deploy').description('Where a project is deployed');

  command
    .command('add', { isDefault: true })
    .description('Record that a project is deployed to a server')
    .argument('<project>', 'project name, alias or id')
    .requiredOption('--remote <server>', 'registered server name or id')
    .option('--env <environment>', 'production | staging | development | testing | other', 'production')
    .option('--path <path>', 'deploy path on the server')
    .option('--branch <branch>', 'branch that is deployed')
    .option('--service <name>', 'systemd unit, pm2 name or container')
    .option('--url <url>', 'public URL')
    .option('--notes <text>', 'anything worth remembering')
    .action(async (term: string, options: DeployOptions) => {
      const { workspace, registry } = await openContext();
      const project = await registry.resolveOrThrow(term);
      const remote = await resolveRemote(workspace, options.remote);

      const deployment = DeploymentSchema.parse({
        id: randomId('dep', 6),
        remote_id: remote.id,
        environment: options.env,
        ...(options.path ? { path: options.path } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
        ...(options.service ? { service: options.service } : {}),
        ...(options.url ? { url: options.url } : {}),
        ...(options.notes ? { notes: options.notes } : {}),
        updated_at: now(),
      });

      // One deployment per (server, environment) pair: re-recording the same
      // target updates it rather than accumulating duplicates.
      const others = project.deployments.filter(
        (existing) =>
          !(existing.remote_id === remote.id && existing.environment === deployment.environment),
      );

      const saved = await registry.save({
        ...project,
        deployments: [...others, deployment],
      });

      if (wantsJson()) return printJson({ project: saved.name, deployment });
      success(
        `${style.bold(project.name)} → ${style.cyan(remote.name)} (${deployment.environment})` +
          (deployment.path ? ` at ${deployment.path}` : ''),
      );
    });

  command
    .command('remove')
    .alias('rm')
    .description('Remove a deployment record')
    .argument('<project>', 'project name, alias or id')
    .requiredOption('--remote <server>', 'registered server name or id')
    .option('--env <environment>', 'which environment to remove')
    .action(async (term: string, options: { remote: string; env?: string }) => {
      const { workspace, registry } = await openContext();
      const project = await registry.resolveOrThrow(term);
      const remote = await resolveRemote(workspace, options.remote);

      const remaining = project.deployments.filter(
        (deployment) =>
          !(
            deployment.remote_id === remote.id &&
            (!options.env || deployment.environment === options.env)
          ),
      );

      if (remaining.length === project.deployments.length) {
        print(`${project.name} has no deployment on ${remote.name}.`);
        return;
      }

      await registry.save({ ...project, deployments: remaining });
      success(`Removed ${project.name}'s deployment on ${remote.name}`);
    });

  return command;
}

interface AddRemoteOptions {
  sshAlias?: string;
  host?: string;
  user?: string;
  port?: number;
  env: string;
  type: string;
  provider?: string;
  notes?: string;
}

interface ImportOptions {
  file?: string;
  includeIncludes?: boolean;
  yes?: boolean;
}

interface DeployOptions {
  remote: string;
  env: string;
  path?: string;
  branch?: string;
  service?: string;
  url?: string;
  notes?: string;
}

async function resolveRemote(
  workspace: Awaited<ReturnType<typeof openContext>>['workspace'],
  term: string,
): Promise<Remote> {
  const remotes = await workspace.store.listRemotes();
  const needle = term.toLowerCase();

  const exact = remotes.filter(
    (remote) =>
      remote.id === term ||
      remote.name.toLowerCase() === needle ||
      remote.ssh_alias?.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;

  const partial = remotes.filter(
    (remote) =>
      remote.name.toLowerCase().includes(needle) ||
      (remote.ssh_alias?.toLowerCase().includes(needle) ?? false),
  );
  if (partial.length === 1) return partial[0]!;

  if (partial.length > 1) {
    throw new BrainError('AMBIGUOUS_REMOTE', `"${term}" matches more than one server.`, {
      details: partial.map((remote) => `${remote.name} (${remote.environment})`),
      hints: ['Use the full server name.'],
    });
  }

  throw new BrainError('UNKNOWN_REMOTE', `No server matches "${term}".`, {
    hints: ['pb remote list', 'pb remote import-ssh'],
  });
}
