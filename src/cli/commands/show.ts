import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { heading, print, printJson, renderFields, style } from '../output.js';
import { buildResumeBrief } from '../../core/context.js';
import { relativeTime, formatLocal } from '../../util/time.js';
import { contractHome } from '../../util/paths.js';

export function showCommand(): Command {
  return new Command('show')
    .description('Everything Project Brain knows about one project')
    .argument('<project>', 'project name, alias or id')
    .action(async (term: string) => {
      const { workspace, registry } = await openContext();
      const project = await registry.resolveOrThrow(term);

      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
        checkpointLimit: 5,
      });
      const machines = await workspace.store.listMachines();
      const machineById = new Map(machines.map((machine) => [machine.id, machine]));

      if (wantsJson()) {
        printJson({
          ...project,
          last_activity_at: brief.lastActivityAt,
          open_tasks: brief.openTasks,
          decisions: brief.keyDecisions,
          checkpoints: brief.checkpoints.map((checkpoint) => checkpoint.meta),
        });
        return;
      }

      print('');
      heading(project.name);

      const fields: [string, string][] = [
        ['id', style.dim(project.id)],
        ['description', project.description ?? style.dim('none')],
        ['status', project.status],
        ['type', project.type],
        ['tags', project.tags.join(', ')],
        ['aliases', project.aliases.join(', ')],
        ['repository', project.repository?.identity ?? style.dim('none')],
        ['branch', project.repository?.default_branch ?? ''],
        ['last activity', `${relativeTime(brief.lastActivityAt)} ${style.dim(formatLocal(brief.lastActivityAt))}`],
        ['discovered', style.dim(formatLocal(project.discovered_at))],
      ];
      print('');
      print(renderFields(fields));

      if (project.local_locations.length > 0) {
        print('');
        print(style.bold('  Locations'));
        for (const location of project.local_locations) {
          const machine = machineById.get(location.machine_id)?.name ?? location.machine_id;
          const marks = [location.branch, location.is_worktree ? 'worktree' : null]
            .filter(Boolean)
            .join(', ');
          print(
            `    ${style.cyan(machine.padEnd(16))} ${contractHome(location.path)}` +
              (marks ? style.dim(`  (${marks})`) : ''),
          );
        }
      }

      if (project.deployments.length > 0) {
        print('');
        print(style.bold('  Deployments'));
        for (const deployment of brief.deployments) {
          const host = deployment.remote?.ssh_alias ?? deployment.remote?.name ?? 'unknown';
          print(`    ${deployment.environment.padEnd(16)} ${host}${deployment.path ? `:${deployment.path}` : ''}`);
        }
      }

      list('Current focus', brief.currentFocus ? [brief.currentFocus] : []);
      list('Blockers', brief.blockers, style.yellow);
      list('Next', brief.nextActions);

      if (brief.keyDecisions.length > 0) {
        print('');
        print(style.bold('  Decisions'));
        for (const decision of brief.keyDecisions) {
          print(`    ${style.dim('•')} ${decision.title} ${style.dim(relativeTime(decision.timestamp))}`);
        }
      }

      if (brief.checkpoints.length > 0) {
        print('');
        print(style.bold('  Recent checkpoints'));
        for (const checkpoint of brief.checkpoints) {
          print(
            `    ${style.dim(relativeTime(checkpoint.meta.timestamp).padEnd(12))} ` +
              `${(checkpoint.meta.branch ?? '').padEnd(16)} ${truncateLine(checkpoint.summary, 60)}`,
          );
        }
      }

      print('');
      print(style.dim(`pb resume ${project.name}   to pick this back up`));
      print(style.dim(`pb where ${project.name}    to see every copy and deployment`));
      print('');
    });
}

function list(title: string, items: readonly string[], paint = (text: string) => text): void {
  if (items.length === 0) return;
  print('');
  print(style.bold(`  ${title}`));
  for (const item of items) print(`    ${style.dim('•')} ${paint(item)}`);
}

function truncateLine(text: string, maxLength: number): string {
  const line = text.split('\n')[0] ?? '';
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}
