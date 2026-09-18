import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { heading, print, printJson, style } from '../output.js';
import { pathExists } from '../../util/fs-atomic.js';
import { relativeTime } from '../../util/time.js';
import type { Machine, Project, Remote } from '../../core/schema.js';

/**
 * `statenest where` answers one question completely: where does this project exist?
 *
 * Local copies on every machine, and every environment it is deployed to,
 * with the exact paths and ssh aliases needed to get there - the things a
 * developer would otherwise dig out of shell history or a half-remembered
 * README.
 */
export function whereCommand(): Command {
  return new Command('where')
    .description('Show every place a project exists: machines, paths and deployments')
    .argument('<project>', 'project name, alias or id')
    .option('--path-only', 'print just the local path, for shell use')
    .action(async (term: string, options: { pathOnly?: boolean }) => {
      const { workspace, registry } = await openContext();
      const project = await registry.resolveOrThrow(term);

      const machines = await workspace.store.listMachines();
      const remotes = await workspace.store.listRemotes();
      const machineById = new Map(machines.map((machine) => [machine.id, machine]));
      const remoteById = new Map(remotes.map((remote) => [remote.id, remote]));

      const here = project.local_locations.filter(
        (location) => location.machine_id === workspace.machineId,
      );

      // `cd "$(statenest where taxi --path-only)"` is the whole point of this flag,
      // so it prints one bare path and nothing else - no colour, no label.
      if (options.pathOnly) {
        const path = here[0]?.path;
        if (!path) {
          process.exitCode = 1;
          process.stderr.write(`${project.name} is not on this machine.\n`);
          return;
        }
        process.stdout.write(`${path}\n`);
        return;
      }

      if (wantsJson()) {
        printJson(await toJson(project, workspace.machineId, machineById, remoteById));
        return;
      }

      await render(project, workspace.machineId, machineById, remoteById);
    });
}

async function render(
  project: Project,
  currentMachineId: string,
  machineById: Map<string, Machine>,
  remoteById: Map<string, Remote>,
): Promise<void> {
  print('');
  heading(project.name);

  if (project.local_locations.length === 0 && project.deployments.length === 0) {
    print('');
    print(style.dim('  No locations recorded yet.'));
    print('');
    print(style.dim('  Register where it lives:'));
    print(`    ${style.cyan('statenest add /path/to/project')}`);
    print('');
    return;
  }

  const grouped = new Map<string, typeof project.local_locations>();
  for (const location of project.local_locations) {
    const existing = grouped.get(location.machine_id) ?? [];
    existing.push(location);
    grouped.set(location.machine_id, existing);
  }

  if (grouped.size > 0) {
    print('');
    print(`  ${style.bold('Local')}`);
    for (const [machineId, locations] of grouped) {
      const machine = machineById.get(machineId);
      const isHere = machineId === currentMachineId;
      const label = machine?.name ?? style.dim('unknown machine');
      print('');
      print(`    ${style.cyan(label)}${isHere ? style.dim('  (this machine)') : ''}`);

      for (const location of locations) {
        // Only the current machine's paths can be checked; another machine's
        // filesystem is not ours to make claims about.
        const missing = isHere && !(await pathExists(location.path));
        const parts: string[] = [];
        if (location.is_worktree) parts.push('worktree');
        if (location.branch) parts.push(location.branch);
        if (missing) parts.push(style.yellow('path not found'));
        else if (location.missing_since) parts.push(style.yellow('missing at last check'));

        const suffix = parts.length > 0 ? style.dim(`  (${parts.join(', ')})`) : '';
        print(`      ${location.path}${suffix}`);
        print(`      ${style.dim(`last seen ${relativeTime(location.last_seen_at)}`)}`);
      }
    }
  }

  if (project.deployments.length > 0) {
    print('');
    print(`  ${style.bold('Deployed')}`);
    for (const deployment of project.deployments) {
      const remote = remoteById.get(deployment.remote_id);
      print('');
      print(`    ${style.cyan(deployment.environment)}`);
      if (remote) {
        if (remote.ssh_alias) print(`      ssh alias   ${remote.ssh_alias}`);
        if (remote.host) {
          print(`      host        ${remote.user ? `${remote.user}@` : ''}${remote.host}${remote.port ? `:${remote.port}` : ''}`);
        }
        print(`      server      ${remote.name}${remote.provider ? style.dim(` (${remote.provider})`) : ''}`);
      } else {
        print(`      ${style.yellow('server record is missing')} ${style.dim(deployment.remote_id)}`);
      }
      if (deployment.path) print(`      path        ${deployment.path}`);
      if (deployment.branch) print(`      branch      ${deployment.branch}`);
      if (deployment.service) print(`      service     ${deployment.service}`);
      if (deployment.url) print(`      url         ${deployment.url}`);
    }
  }

  if (project.repository) {
    print('');
    print(`  ${style.bold('Repository')}`);
    print(`    ${project.repository.web_url ?? project.repository.identity}`);
  }

  print('');
}

async function toJson(
  project: Project,
  currentMachineId: string,
  machineById: Map<string, Machine>,
  remoteById: Map<string, Remote>,
): Promise<Record<string, unknown>> {
  const locations = await Promise.all(
    project.local_locations.map(async (location) => {
      const isHere = location.machine_id === currentMachineId;
      return {
        machine_id: location.machine_id,
        machine: machineById.get(location.machine_id)?.name ?? null,
        is_current_machine: isHere,
        path: location.path,
        exists: isHere ? await pathExists(location.path) : null,
        is_worktree: location.is_worktree,
        branch: location.branch,
        last_seen_at: location.last_seen_at,
      };
    }),
  );

  return {
    project: { id: project.id, name: project.name },
    repository: project.repository ?? null,
    local: locations,
    deployments: project.deployments.map((deployment) => {
      const remote = remoteById.get(deployment.remote_id) ?? null;
      return {
        environment: deployment.environment,
        path: deployment.path ?? null,
        branch: deployment.branch ?? null,
        service: deployment.service ?? null,
        url: deployment.url ?? null,
        remote: remote
          ? {
              id: remote.id,
              name: remote.name,
              ssh_alias: remote.ssh_alias ?? null,
              host: remote.host ?? null,
              user: remote.user ?? null,
              port: remote.port ?? null,
              provider: remote.provider ?? null,
            }
          : null,
      };
    }),
  };
}
