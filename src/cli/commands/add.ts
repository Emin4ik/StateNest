import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { bullet, print, printJson, style, success } from '../output.js';
import { contractHome, resolveUserPath } from '../../util/paths.js';
import { pathExists } from '../../util/fs-atomic.js';
import { BrainError } from '../../util/errors.js';
import { closePrompts, confirm } from '../prompt.js';
import { hasLocationOnAnotherMachine } from '../../core/registry.js';

export function addCommand(): Command {
  return new Command('add')
    .description('Register a directory as a project')
    .argument('[path]', 'directory to register', '.')
    .option('--name <name>', 'display name (defaults to the repository or folder name)')
    .option('--tag <tag>', 'tag the project (repeatable)', collect, [])
    .option('--no-detect', 'skip reading manifests and README for a description')
    .action(async (rawPath: string, options: AddOptions) => {
      const { workspace, registry } = await openContext();
      const path = resolveUserPath(rawPath);

      if (!(await pathExists(path))) {
        throw new BrainError('PATH_NOT_FOUND', `${contractHome(path)} does not exist.`, {
          hints: ['statenest add .', 'statenest scan ~/Projects'],
        });
      }

      const result = await registry.register(path, {
        machineId: workspace.machineId,
        ...(options.name ? { name: options.name } : {}),
        ...(options.detect ? {} : { skipDetection: true }),
        tags: options.tag,
      });

      if (wantsJson()) {
        printJson({ outcome: result.outcome, project: result.project });
        return;
      }

      const { project, outcome } = result;
      switch (outcome) {
        case 'created':
          success(`Registered ${style.bold(project.name)}`);
          break;
        case 'location-added':
          // Only claim another machine when one is actually recorded. The same
          // repository cloned twice here produces this outcome as well.
          success(
            hasLocationOnAnotherMachine(project, workspace.machineId)
              ? `${style.bold(project.name)} was already known from another machine — linked this copy`
              : `${style.bold(project.name)} was already registered — linked this copy too`,
          );
          break;
        default:
          success(`${style.bold(project.name)} was already registered — details refreshed`);
      }

      print(`  ${style.dim(contractHome(path))}`);
      if (project.repository) print(`  ${style.dim(project.repository.identity)}`);
      if (project.description) print(`  ${style.dim(project.description)}`);
      if (!project.repository) {
        print('');
        print(
          style.dim(
            '  No git remote found, so this project is identified by a local id.\n' +
              '  Add a remote and re-run `statenest add` to link it across machines.',
          ),
        );
      }

      print('');
      print(bullet(style.cyan(`statenest show ${project.name}`)));
    });
}

interface AddOptions {
  name?: string;
  tag: string[];
  detect: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function removeCommand(): Command {
  return new Command('remove')
    .alias('rm')
    .description('Forget a project (its checkpoints are kept unless you say otherwise)')
    .argument('<project>', 'project name, alias or id')
    .option('--with-history', 'also delete its checkpoints permanently')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (term: string, options: { withHistory?: boolean; yes?: boolean }) => {
      try {
        const { workspace, registry } = await openContext();
        const project = await registry.resolveOrThrow(term);

        const checkpoints = await workspace.store.listCheckpointFiles(project.id);

        print('');
        print(`About to forget ${style.bold(project.name)}.`);
        print(
          style.dim(
            options.withHistory
              ? `  Its ${checkpoints.length} checkpoint(s) will be deleted permanently.`
              : `  Its ${checkpoints.length} checkpoint(s) will be kept on disk.`,
          ),
        );
        print(style.dim('  Your actual project files are never touched.'));
        print('');

        const confirmed = await confirm('Continue?', {
          defaultValue: false,
          assumeYes: Boolean(options.yes),
        });
        if (!confirmed) {
          print('Cancelled.');
          return;
        }

        await workspace.store.deleteProject(project.id, {
          ...(options.withHistory ? { withHistory: true } : {}),
        });
        registry.invalidate();

        success(`Forgot ${project.name}`);
        if (!options.withHistory && checkpoints.length > 0) {
          print(style.dim(`  ${checkpoints.length} checkpoint file(s) remain under the profile's checkpoints/ directory.`));
        }
      } finally {
        closePrompts();
      }
    });
}
