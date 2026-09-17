import { Command, Option } from 'commander';
import { setGlobalOptions } from './context.js';
import { printError, style } from './output.js';
import { closePrompts } from './prompt.js';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { projectsCommand } from './commands/projects.js';
import { showCommand } from './commands/show.js';
import { whereCommand } from './commands/where.js';
import { recentCommand } from './commands/recent.js';
import { resumeCommand } from './commands/resume.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { searchCommand } from './commands/search.js';
import { statusCommand } from './commands/status.js';
import { addCommand, removeCommand } from './commands/add.js';
import { taskCommand } from './commands/task.js';
import { decisionCommand } from './commands/decision.js';
import { machineCommand } from './commands/machine.js';
import { deployCommand, remoteCommand } from './commands/remote.js';
import { doctorCommand } from './commands/doctor.js';
import { privacyCommand } from './commands/privacy.js';
import { integrateCommand } from './commands/integrate.js';

/**
 * The `pb` command tree.
 *
 * The naming rule throughout: commands answer questions a developer actually
 * asks out loud. `pb where taxi`, not `pb project lookup --field
 * deployment.machine`. Anything that reads like a database query belongs
 * behind a flag, not in the command name.
 */
export function buildProgram(version: string): Command {
  const program = new Command();

  program
    .name('pb')
    .description(
      'Project Brain — remembers your projects, machines, deployments and where you left off.',
    )
    .version(version, '-v, --version', 'print the version')
    .option('--home <dir>', 'use a different Project Brain home')
    .option('--profile <name>', 'use a specific profile')
    .option('--json', 'machine-readable output')
    .option('-q, --quiet', 'suppress warnings')
    .addOption(new Option('--no-color', 'disable colored output'))
    .showHelpAfterError('(run `pb --help` for a list of commands)')
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: false })
    .hook('preAction', (thisCommand) => {
      const options = thisCommand.opts<{
        home?: string;
        profile?: string;
        json?: boolean;
        quiet?: boolean;
        color?: boolean;
      }>();
      setGlobalOptions({
        ...(options.home ? { home: options.home } : {}),
        ...(options.profile ? { profile: options.profile } : {}),
        json: Boolean(options.json),
        quiet: Boolean(options.quiet),
        color: options.color !== false,
      });
    });

  // Getting started
  program.addCommand(initCommand());
  program.addCommand(doctorCommand());

  // Everyday
  program.addCommand(recentCommand());
  program.addCommand(projectsCommand());
  program.addCommand(resumeCommand());
  program.addCommand(showCommand());
  program.addCommand(whereCommand());
  program.addCommand(statusCommand());
  program.addCommand(searchCommand());
  program.addCommand(checkpointCommand());

  // Registering things
  program.addCommand(scanCommand());
  program.addCommand(addCommand());
  program.addCommand(removeCommand());

  // Memory
  program.addCommand(taskCommand());
  program.addCommand(decisionCommand());

  // Infrastructure
  program.addCommand(machineCommand());
  program.addCommand(remoteCommand());
  program.addCommand(deployCommand());

  // Setup and safety
  program.addCommand(integrateCommand());
  program.addCommand(privacyCommand());

  program.addHelpText(
    'after',
    `
${style.bold('Examples')}
  ${style.cyan('pb init')}                        set up and find your projects
  ${style.cyan('pb recent')}                      what you have been working on
  ${style.cyan('pb resume world-war')}            pick a project back up
  ${style.cyan('pb where taxi')}                  every copy and deployment
  ${style.cyan('pb checkpoint -m "..."')}         record what you just did
  ${style.cyan('pb search "refinery"')}           search your own history

${style.dim('Everything is stored locally as YAML and Markdown. Nothing is uploaded.')}
`,
  );

  return program;
}

/**
 * Run the CLI.
 *
 * All error rendering funnels through here so that every failure gets the same
 * treatment: what happened, the relevant context, and a command that fixes it.
 */
export async function run(argv: string[], version: string): Promise<number> {
  const program = buildProgram(version);

  try {
    await program.parseAsync(argv);
    // A command may have set a non-zero exit code without throwing.
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    // commander throws for --help and --version, which are not failures.
    if (isCommanderExit(error)) {
      const code = (error as { exitCode?: unknown }).exitCode;
      return typeof code === 'number' ? code : 0;
    }
    printError(error);
    return 1;
  } finally {
    closePrompts();
  }
}

function isCommanderExit(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('commander.')
  );
}
