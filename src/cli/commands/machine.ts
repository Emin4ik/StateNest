import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { print, printJson, renderTable, style, success } from '../output.js';
import { relativeTime } from '../../util/time.js';
import type { Machine } from '../../core/schema.js';

export function machineCommand(): Command {
  const command = new Command('machine').description('The computers this profile has been used from');

  command
    .command('list', { isDefault: true })
    .alias('ls')
    .description('List known machines')
    .action(async () => {
      const { workspace } = await openContext();
      const machines = await workspace.store.listMachines();
      const projects = await workspace.store.listProjects();

      const projectCount = new Map<string, number>();
      for (const project of projects) {
        for (const machineId of new Set(project.local_locations.map((l) => l.machine_id))) {
          projectCount.set(machineId, (projectCount.get(machineId) ?? 0) + 1);
        }
      }

      if (wantsJson()) {
        return printJson({
          current: workspace.machineId,
          machines: machines.map((machine) => ({
            ...machine,
            is_current: machine.id === workspace.machineId,
            project_count: projectCount.get(machine.id) ?? 0,
          })),
        });
      }

      if (machines.length === 0) {
        print('No machines recorded yet.');
        return;
      }

      print('');
      print(
        renderTable(machines, [
          {
            header: 'machine',
            value: (machine) =>
              machine.id === workspace.machineId ? `${machine.name} *` : machine.name,
            paint: (text, machine) =>
              machine.id === workspace.machineId ? style.bold(text) : text,
          },
          { header: 'os', value: (machine) => machine.os },
          { header: 'type', value: (machine) => machine.type, optional: true },
          { header: 'projects', value: (machine) => String(projectCount.get(machine.id) ?? 0), align: 'right' },
          { header: 'last seen', value: (machine) => relativeTime(machine.last_seen_at) },
          { header: 'id', value: (machine) => machine.id, optional: true, paint: (t) => style.dim(t) },
        ]),
      );
      print('');
      print(style.dim('* this machine'));
      print('');
    });

  command
    .command('current')
    .description('Show this machine\'s record')
    .action(async () => {
      const { workspace } = await openContext();
      const machine = await workspace.currentMachine();

      if (wantsJson()) return printJson(machine ?? { id: workspace.machineId });

      if (!machine) {
        print(`This machine is ${style.bold(workspace.machineId)} but has no record yet.`);
        return;
      }
      print('');
      printMachine(machine);
      print('');
    });

  command
    .command('rename')
    .description('Rename this machine')
    .argument('<name>', 'new name')
    .action(async (name: string) => {
      const { workspace } = await openContext();
      const machine = await workspace.touchMachine(name);
      if (wantsJson()) return printJson(machine);
      success(`This machine is now called ${style.bold(machine.name)}`);
    });

  return command;
}

function printMachine(machine: Machine): void {
  const rows: [string, string | undefined][] = [
    ['name', machine.name],
    ['id', machine.id],
    ['type', machine.type],
    ['os', `${machine.os}${machine.os_release ? ` (${machine.os_release})` : ''}`],
    ['hostname', machine.hostname],
    ['architecture', machine.architecture],
    ['first seen', relativeTime(machine.first_seen_at)],
    ['last seen', relativeTime(machine.last_seen_at)],
  ];
  for (const [key, value] of rows) {
    if (value) print(`  ${style.dim(key.padEnd(14))} ${value}`);
  }
}
