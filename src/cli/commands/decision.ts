import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { print, printJson, style, success } from '../output.js';
import { identifyHere } from './checkpoint.js';
import { DecisionSchema } from '../../core/schema.js';
import { randomId } from '../../util/ids.js';
import { formatLocal, now, relativeTime } from '../../util/time.js';
import { redactSecrets } from '../../security/redact.js';
import { ask, closePrompts } from '../prompt.js';
import type { Registry } from '../../core/registry.js';

/**
 * Decisions record *why*.
 *
 * Git history shows that the match timer was removed. It does not show that it
 * was removed because players preferred long base-building sessions, and that
 * a configurable timer was considered and rejected. That reasoning is what
 * stops the same decision being quietly reversed six months later.
 */
export function decisionCommand(): Command {
  const command = new Command('decision').description('Record and review why things were decided');

  command
    .command('add', { isDefault: true })
    .description('Record a decision')
    .argument('[title...]', 'what was decided')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .option('-r, --reason <text>', 'why')
    .option('--instead <option>', 'an alternative that was rejected (repeatable)', collect, [])
    .option('--tag <tag>', 'tag it (repeatable)', collect, [])
    .action(async (words: string[], options: AddOptions) => {
      try {
        const { workspace, registry } = await openContext();
        const project = await resolve(registry, workspace.machineId, options.project);

        const title = words.length > 0 ? words.join(' ') : await ask('What was decided?');
        if (!title.trim()) {
          print('Nothing recorded.');
          return;
        }
        const reason = options.reason ?? (await ask('Why? (enter to skip)'));

        // Decisions are prose about a working session, which is exactly the
        // kind of text a pasted credential ends up in.
        const safeTitle = redactSecrets(title).text;
        const safeReason = redactSecrets(reason ?? '').text;

        const decision = DecisionSchema.parse({
          id: randomId('dec', 6),
          project_id: project.id,
          timestamp: now(),
          machine_id: workspace.machineId,
          title: safeTitle,
          ...(safeReason.trim() ? { reason: safeReason } : {}),
          alternatives: options.instead.map((item) => redactSecrets(item).text),
          tags: options.tag,
        });

        await workspace.store.appendDecision(decision);

        if (wantsJson()) return printJson(decision);
        success(`Recorded for ${style.bold(project.name)}: ${decision.title}`);
      } finally {
        closePrompts();
      }
    });

  command
    .command('list')
    .alias('ls')
    .description('Show decisions for a project')
    .option('-p, --project <name>', 'project (defaults to the current directory)')
    .option('-n, --limit <n>', 'how many to show', (v) => Number.parseInt(v, 10), 20)
    .action(async (options: { project?: string; limit?: number }) => {
      const { workspace, registry } = await openContext();
      const project = await resolve(registry, workspace.machineId, options.project);
      const decisions = (await workspace.store.readDecisions(project.id)).slice(
        0,
        options.limit ?? 20,
      );

      if (wantsJson()) return printJson({ project: project.name, decisions });

      if (decisions.length === 0) {
        print(`No decisions recorded for ${project.name}.`);
        print('');
        print(style.dim('Record one:'));
        print(`  ${style.cyan(`statenest decision add "..." --reason "..."`)}`);
        return;
      }

      print('');
      print(style.bold(project.name));
      for (const decision of decisions) {
        print('');
        print(`  ${style.bold(decision.title)}`);
        print(
          `  ${style.dim(`${formatLocal(decision.timestamp)}  (${relativeTime(decision.timestamp)})`)}`,
        );
        if (decision.reason) {
          for (const line of decision.reason.split('\n')) print(`    ${line}`);
        }
        if (decision.alternatives.length > 0) {
          print(`    ${style.dim('Considered instead:')}`);
          for (const alternative of decision.alternatives) print(`      • ${alternative}`);
        }
        if (decision.superseded_by) {
          print(`    ${style.yellow(`superseded by ${decision.superseded_by}`)}`);
        }
      }
      print('');
    });

  return command;
}

interface AddOptions {
  project?: string;
  reason?: string;
  instead: string[];
  tag: string[];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function resolve(registry: Registry, machineId: string, term: string | undefined) {
  return term ? registry.resolveOrThrow(term) : identifyHere(registry, machineId);
}
