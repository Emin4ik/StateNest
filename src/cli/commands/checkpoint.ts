import { Command } from 'commander';
import { openContext, wantsJson , scheduleSyncAfterWrite } from '../context.js';
import { bullet, print, printJson, style, success } from '../output.js';
import { createCheckpoint, isCheckpointWorthwhile } from '../../checkpoints/create.js';
import { readRepoFull } from '../../git/repo.js';
import { contractHome } from '../../util/paths.js';
import { now } from '../../util/time.js';
import { BrainError } from '../../util/errors.js';

export function checkpointCommand(): Command {
  return new Command('checkpoint')
    .description('Record what you just accomplished in a project')
    .argument('[project]', 'project (defaults to the current directory)')
    .option('-m, --message <text>', 'one-line summary of what changed')
    .option('--did <item>', 'something completed (repeatable)', collect, [])
    .option('--next <item>', 'something still to do (repeatable)', collect, [])
    .option('--blocked <item>', 'something blocking progress (repeatable)', collect, [])
    .option('--decided <item>', 'a decision made (repeatable)', collect, [])
    .option('--tag <tag>', 'tag the checkpoint (repeatable)', collect, [])
    .option('--force', 'write even if nothing appears to have changed')
    .action(async (term: string | undefined, options: CheckpointOptions) => {
      const { workspace, registry } = await openContext();

      const project = term
        ? await registry.resolveOrThrow(term)
        : await identifyHere(registry, workspace.machineId);

      const location = project.local_locations.find(
        (entry) => entry.machine_id === workspace.machineId,
      );
      const repoPath = location?.path ?? process.cwd();
      const repo = await readRepoFull(repoPath, { changedFileLimit: 30 });

      const hasNarrative =
        Boolean(options.message) ||
        options.did.length > 0 ||
        options.next.length > 0 ||
        options.blocked.length > 0 ||
        options.decided.length > 0;

      // A checkpoint the user typed is always meaningful. The worthwhile check
      // exists to stop *automatic* checkpoints piling up, not to second-guess
      // someone who just told us what they did.
      if (!hasNarrative && !options.force) {
        const [last] = await workspace.store.listCheckpoints(project.id, { limit: 1 });
        const verdict = isCheckpointWorthwhile({
          lastCheckpoint: last ?? null,
          repo,
          minIntervalMinutes: workspace.config.checkpoint.min_interval_minutes,
        });
        if (!verdict.worthwhile) {
          print(`Nothing to record for ${style.bold(project.name)} — ${verdict.reason}.`);
          print('');
          print(style.dim('Add a summary to record one anyway:'));
          print(bullet(style.cyan(`statenest checkpoint ${project.name} -m "what you did"`)));
          print(bullet(style.cyan('statenest checkpoint --force')));
          return;
        }
      }

      const result = await createCheckpoint(
        workspace.store,
        project,
        {
          ...(options.message ? { summary: options.message } : {}),
          ...(options.did.length > 0 ? { completed: options.did } : {}),
          ...(options.next.length > 0 ? { next: options.next } : {}),
          ...(options.blocked.length > 0 ? { blockers: options.blocked } : {}),
          ...(options.decided.length > 0 ? { decisions: options.decided } : {}),
          tags: options.tag,
        },
        { machineId: workspace.machineId, source: 'cli', repo },
      );

      // Keep the project record in step, so `statenest projects` sorts correctly
      // without having to read the checkpoint tree.
      await registry.save({
        ...project,
        last_checkpoint_at: result.meta.timestamp,
        last_activity_at: now(),
        ...(options.blocked.length > 0 ? { blockers: dedupe([...project.blockers, ...options.blocked]) } : {}),
      });

      if (wantsJson()) {
        printJson({
          checkpoint: result.meta,
          file: result.filePath,
          redactions: result.redactions,
        });
        return;
      }

      await scheduleSyncAfterWrite(workspace);

      success(`Checkpoint saved for ${style.bold(project.name)}`);
      print(`  ${style.dim(contractHome(result.filePath))}`);
      if (repo?.branch) {
        print(
          `  ${style.dim(`${repo.branch}${repo.lastCommit ? ` @ ${repo.lastCommit.shortSha}` : ''}${repo.dirty ? `, ${result.meta.changed_files} uncommitted` : ', clean'}`)}`,
        );
      }
      if (result.redactions > 0) {
        print(
          `  ${style.yellow(`${result.redactions} value(s) that looked like secrets were redacted before saving.`)}`,
        );
      }
    });
}

interface CheckpointOptions {
  message?: string;
  did: string[];
  next: string[];
  blocked: string[];
  decided: string[];
  tag: string[];
  force?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

/**
 * Work out which project the user is standing in.
 *
 * Failing here has a specific, actionable message: the brief is explicit that
 * "could not identify this project" must say what was checked and what to run.
 */
export async function identifyHere(
  registry: Awaited<ReturnType<typeof openContext>>['registry'],
  machineId: string,
) {
  const cwd = process.cwd();
  const { project, repoRoot } = await registry.identify(cwd, machineId);
  if (project) return project;

  throw new BrainError('UNKNOWN_PROJECT', 'StateNest could not identify this project.', {
    details: [
      `Current directory: ${contractHome(cwd)}`,
      repoRoot
        ? `Git repository found at ${contractHome(repoRoot)}, but it is not registered.`
        : 'No git repository was found above this directory.',
    ],
    hints: ['statenest add .', 'statenest checkpoint <project>'],
  });
}
