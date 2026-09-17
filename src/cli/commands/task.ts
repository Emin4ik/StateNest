import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { print, printJson, style, success } from '../output.js';
import { identifyHere } from './checkpoint.js';
import { TaskSchema, type Task, type TaskStatus } from '../../core/schema.js';
import { randomId } from '../../util/ids.js';
import { now } from '../../util/time.js';
import { BrainError } from '../../util/errors.js';
import type { Registry } from '../../core/registry.js';

/**
 * Lightweight continuation tasks.
 *
 * Explicitly not an issue tracker. These exist to answer "what was I about to
 * do next?" when picking a project back up, which is a different job from
 * planning work, and one that GitHub Issues does badly precisely because it
 * is built for the other thing.
 */
export function taskCommand(): Command {
  const command = new Command('task').description('Next actions for a project');

  command
    .command('add', { isDefault: true })
    .description('Add a next action')
    .argument('<text...>', 'what needs doing')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .option('--tag <tag>', 'tag it (repeatable)', collect, [])
    .action(async (words: string[], options: { project?: string; tag: string[] }) => {
      const { workspace, registry } = await openContext();
      const project = await resolve(registry, workspace.machineId, options.project);
      const file = await workspace.store.readTasks(project.id);

      const timestamp = now();
      const task = TaskSchema.parse({
        id: randomId('task', 6),
        text: words.join(' '),
        status: 'todo',
        created_at: timestamp,
        updated_at: timestamp,
        tags: options.tag,
        source: 'manual',
      });

      await workspace.store.writeTasks({ ...file, tasks: [...file.tasks, task] });

      if (wantsJson()) return printJson(task);
      success(`Added to ${style.bold(project.name)}: ${task.text}`);
    });

  command
    .command('list')
    .alias('ls')
    .description('Show a project\'s tasks')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .option('--all', 'include completed and cancelled tasks')
    .action(async (options: { project?: string; all?: boolean }) => {
      const { workspace, registry } = await openContext();
      const project = await resolve(registry, workspace.machineId, options.project);
      const file = await workspace.store.readTasks(project.id);

      const visible = options.all
        ? file.tasks
        : file.tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');

      if (wantsJson()) return printJson({ project: project.name, tasks: visible });

      if (visible.length === 0) {
        print(
          options.all
            ? `${project.name} has no tasks.`
            : `${project.name} has nothing open. Use --all to see completed tasks.`,
        );
        return;
      }

      print('');
      print(style.bold(project.name));
      print('');
      for (const task of visible) {
        print(`  ${marker(task.status)} ${style.dim(task.id.padEnd(12))} ${paintText(task)}`);
        if (task.blocked_reason) print(`       ${style.yellow(task.blocked_reason)}`);
      }
      print('');
    });

  command
    .command('done')
    .description('Mark a task complete')
    .argument('<id>', 'task id, or a unique prefix of one')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .action(async (id: string, options: { project?: string }) => {
      await updateStatus(id, options.project, 'done');
    });

  command
    .command('start')
    .description('Mark a task in progress')
    .argument('<id>', 'task id, or a unique prefix of one')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .action(async (id: string, options: { project?: string }) => {
      await updateStatus(id, options.project, 'in_progress');
    });

  command
    .command('block')
    .description('Mark a task blocked')
    .argument('<id>', 'task id, or a unique prefix of one')
    .option('-r, --reason <text>', 'what is blocking it')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .action(async (id: string, options: { project?: string; reason?: string }) => {
      await updateStatus(id, options.project, 'blocked', options.reason);
    });

  command
    .command('cancel')
    .description('Cancel a task without completing it')
    .argument('<id>', 'task id, or a unique prefix of one')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .action(async (id: string, options: { project?: string }) => {
      await updateStatus(id, options.project, 'cancelled');
    });

  return command;
}

async function updateStatus(
  idPrefix: string,
  projectTerm: string | undefined,
  status: TaskStatus,
  reason?: string,
): Promise<void> {
  const { workspace, registry } = await openContext();
  const project = await resolve(registry, workspace.machineId, projectTerm);
  const file = await workspace.store.readTasks(project.id);

  const matches = file.tasks.filter((task) => task.id === idPrefix || task.id.startsWith(idPrefix));
  if (matches.length === 0) {
    throw new BrainError('UNKNOWN_TASK', `No task in ${project.name} matches "${idPrefix}".`, {
      hints: [`pb task list --project ${project.name}`],
    });
  }
  if (matches.length > 1) {
    throw new BrainError('AMBIGUOUS_TASK', `"${idPrefix}" matches ${matches.length} tasks.`, {
      details: matches.map((task) => `${task.id}  ${task.text}`),
      hints: ['Use the full task id.'],
    });
  }

  const target = matches[0]!;
  const timestamp = now();
  const updated: Task = {
    ...target,
    status,
    updated_at: timestamp,
    completed_at: status === 'done' ? timestamp : null,
    ...(reason !== undefined ? { blocked_reason: reason } : {}),
  };

  await workspace.store.writeTasks({
    ...file,
    tasks: file.tasks.map((task) => (task.id === target.id ? updated : task)),
  });

  if (wantsJson()) return printJson(updated);
  success(`${statusVerb(status)}: ${updated.text}`);
}

async function resolve(registry: Registry, machineId: string, term: string | undefined) {
  return term ? registry.resolveOrThrow(term) : identifyHere(registry, machineId);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function marker(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return style.green('[x]');
    case 'in_progress':
      return style.cyan('[~]');
    case 'blocked':
      return style.yellow('[!]');
    case 'cancelled':
      return style.dim('[-]');
    default:
      return '[ ]';
  }
}

function paintText(task: Task): string {
  if (task.status === 'done' || task.status === 'cancelled') return style.dim(task.text);
  return task.text;
}

function statusVerb(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return 'Completed';
    case 'in_progress':
      return 'Started';
    case 'blocked':
      return 'Blocked';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Updated';
  }
}
