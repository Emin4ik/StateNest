import { Command } from 'commander';
import { homedir } from 'node:os';
import { Workspace } from '../../core/workspace.js';
import { resolveBrainHome } from '../../core/paths.js';
import { Registry } from '../../core/registry.js';
import { getGlobalOptions, resetContext, wantsJson } from '../context.js';
import { bullet, heading, print, printJson, pluralize, style, success } from '../output.js';
import { ask, closePrompts, confirm, multiSelect } from '../prompt.js';
import { scanForProjects } from '../../discovery/scanner.js';
import { defaultRoots } from './scan.js';
import { gitVersion } from '../../git/exec.js';
import { detectOs, suggestMachineName } from '../../machines/identity.js';
import { contractHome, resolveUserPath } from '../../util/paths.js';
import { pathExists } from '../../util/fs-atomic.js';
import { effectiveActivity } from './projects.js';
import { installClaudeIntegration, describeClaudeInstall } from '../../integrations/claude/install.js';
import { hasLocationOnAnotherMachine } from '../../core/registry.js';
import { updateMachineLocalState } from '../../core/machine-local.js';
import { ProfileSync } from '../../sync/git-sync.js';
import { preserveMachineLocations } from '../../core/adoption.js';
import { writeDataRepoScaffolding } from '../../core/workspace.js';
import { recordOutcome } from '../../sync/auto-sync.js';

export function initCommand(): Command {
  return buildSetupCommand('init', 'Set up StateNest on this machine');
}

/**
 * The same command under the name people reach for.
 *
 * One implementation, two names, rather than a second onboarding path that
 * drifts from the first. `init` is what existing scripts and documentation
 * already say; `setup` is what someone types when they have just installed the
 * thing and want it working.
 */
export function setupCommand(): Command {
  return buildSetupCommand(
    'setup',
    'Set StateNest up on this machine, end to end',
  );
}

function buildSetupCommand(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .option('-y, --yes', 'accept every default, ask nothing')
    .option('--machine-name <name>', 'what to call this computer')
    .option('--roots <dirs...>', 'directories that contain your projects')
    .option('--no-scan', 'set up without scanning for projects')
    .option('--no-claude', 'skip the Claude Code integration offer')
    .option('--no-sync', 'skip the sync offer')
    .action(async (options: InitOptions) => {
      try {
        await runInit(options);
      } finally {
        closePrompts();
      }
    });
}

interface InitOptions {
  yes?: boolean;
  machineName?: string;
  roots?: string[];
  scan: boolean;
  claude: boolean;
  sync: boolean;
}

async function runInit(options: InitOptions): Promise<void> {
  const assumeDefaults = Boolean(options.yes) || wantsJson();
  const globals = getGlobalOptions();

  if (!wantsJson()) printWelcome();

  // -- Environment ---------------------------------------------------------
  const os = detectOs();
  const git = await gitVersion();
  if (!git && !wantsJson()) {
    print('');
    print(style.yellow('git was not found on this machine.'));
    print(
      style.dim(
        'StateNest works without it, but it cannot read branches, commits or uncommitted changes.',
      ),
    );
  }

  // -- Privacy summary, before anything is written -------------------------
  // The home is resolved (not created) first, so the summary can name the real
  // location while still being shown before a single file exists.
  const homePath = resolveBrainHome(process.env, homedir());
  if (!wantsJson()) printPrivacySummary(globals.home ?? homePath);

  // -- Home and profile ----------------------------------------------------
  // `--profile` is a global option, parsed wherever it appears in the command
  // line. Declaring it again on this subcommand meant the global one always
  // consumed the value and this one silently kept its default, so `statenest init
  // --profile work` created a profile called "personal".
  const workspace = await Workspace.initialize({
    ...(globals.home ? { home: globals.home } : {}),
    profileName: globals.profile ?? 'personal',
  });
  resetContext();

  // -- Machine -------------------------------------------------------------
  const suggestedName = options.machineName ?? suggestMachineName();
  const machineName = await ask('\nWhat should this computer be called?', {
    defaultValue: suggestedName,
    assumeDefaults,
  });
  const machine = await workspace.touchMachine(machineName);

  // -- Project roots -------------------------------------------------------
  let chosenRoots: string[] = [];
  if (options.scan) {
    chosenRoots = await chooseRoots(options.roots, assumeDefaults);
    if (chosenRoots.length > 0) {
      // Machine-local: these are this computer's directories, and sharing them
      // would have another machine scanning paths it does not have.
      await updateMachineLocalState(
        workspace.paths,
        workspace.profile.name,
        workspace.profile,
        (state) => ({ ...state, project_roots: chosenRoots.map((root) => contractHome(root)) }),
      );
    }
  }

  // -- Scan ----------------------------------------------------------------
  const registry = new Registry(workspace.store);
  let registered = 0;
  let linked = 0;
  let extraCopies = 0;

  if (chosenRoots.length > 0) {
    if (!wantsJson()) process.stderr.write(style.dim('\nScanning...'));
    const scan = await scanForProjects(chosenRoots, {
      maxDepth: workspace.config.discovery.max_depth,
    });
    if (!wantsJson()) process.stderr.write('\r'.padEnd(40, ' ') + '\r');

    for (const candidate of scan.candidates) {
      const result = await registry.register(candidate.path, { machineId: workspace.machineId });
      if (result.outcome === 'created') registered++;
      else if (result.outcome === 'location-added') {
        if (hasLocationOnAnotherMachine(result.project, workspace.machineId)) linked++;
        else extraCopies++;
      }
    }
  }

  // -- Claude Code ---------------------------------------------------------
  let claudeResult: Awaited<ReturnType<typeof installClaudeIntegration>> | null = null;
  const claudeAvailable = await pathExists(`${homedir()}/.claude`);

  if (options.claude && claudeAvailable) {
    const wanted = await confirm('\nInstall the Claude Code integration?', {
      defaultValue: true,
      assumeYes: assumeDefaults,
    });
    if (wanted) claudeResult = await installClaudeIntegration({ assumeDefaults });
  }

  // -- Sync ----------------------------------------------------------------
  //
  // Offered here because "set StateNest up" and "make this work on my other
  // computer" are one intention, and splitting them across two commands is how
  // a second machine ends up joined in the wrong order.
  let syncResult: 'connected' | 'received' | 'skipped' | 'failed' = 'skipped';
  if (options.sync !== false && !workspace.profile.sync.enabled) {
    syncResult = await offerSync(workspace, assumeDefaults);
  }

  // -- Report --------------------------------------------------------------
  const projects = await registry.all();
  const activeRecently = projects.filter((project) => isRecent(project, 30)).length;
  const deployments = projects.reduce((sum, project) => sum + project.deployments.length, 0);

  if (wantsJson()) {
    printJson({
      home: workspace.paths.home,
      profile: workspace.profile.name,
      machine: { id: machine.id, name: machine.name, os },
      git_version: git,
      roots: chosenRoots,
      projects_registered: registered,
      locations_linked: linked,
      extra_copies_linked: extraCopies,
      projects_total: projects.length,
      claude_integration: claudeResult?.status ?? 'skipped',
      sync: syncResult,
    });
    return;
  }

  print('');
  success('StateNest initialised');
  print(`  ${style.dim(contractHome(workspace.paths.home))}`);
  success(`Machine registered: ${style.bold(machine.name)} ${style.dim(`(${os})`)}`);
  if (claudeResult) {
    success(`Claude Code integration: ${describeClaudeInstall(claudeResult)}`);
  }
  if (syncResult === 'connected') success('Sync connected');
  if (syncResult === 'received') {
    success('Sync connected');
    success('Existing StateNest memory received');
  }
  if (chosenRoots.length > 0) {
    success(`${pluralize(projects.length, 'project')} discovered`);
    if (linked > 0) success(`${linked} already known from another machine, now linked here`);
    if (extraCopies > 0) {
      success(`${pluralize(extraCopies, 'extra copy', 'extra copies')} of a known project linked`);
    }
    if (activeRecently > 0) success(`${activeRecently} active in the last 30 days`);
    if (deployments > 0) success(`${pluralize(deployments, 'deployment')} registered`);
  }

  print('');
  if (claudeResult && claudeResult.status !== 'failed') {
    success('Ready');
    print('');
    print('  Open Claude Code inside a git project.');
    print(style.dim('  StateNest will recognise it, restore your context, and remember'));
    print(style.dim('  what happened — without you running anything.'));
    print('');
    print(style.dim('To look at what it knows:'));
  } else {
    print(style.dim('Try:'));
  }
  print(bullet(style.cyan('statenest projects')));
  print(bullet(style.cyan('statenest recent')));
  print(bullet(style.cyan('statenest resume <project>')));
  print(bullet(style.cyan('statenest doctor')));
  print('');
}

/**
 * Offer to connect this profile to the user's own private repository.
 *
 * Joining an established profile and starting a new one are the same two
 * commands in the same order, so the user never has to know which case they
 * are in - the sync itself works that out. That is the whole point of doing it
 * here rather than leaving `sync init` to be discovered later.
 */
async function offerSync(
  workspace: Workspace,
  assumeDefaults: boolean,
): Promise<'connected' | 'received' | 'skipped' | 'failed'> {
  if (assumeDefaults) return 'skipped';

  const wanted = await confirm('\nSync across your computers?', { defaultValue: false });
  if (!wanted) return 'skipped';

  print('');
  print(style.dim('  A PRIVATE git repository you own. It will hold project names,'));
  print(style.dim('  notes, server addresses and deploy paths — never credentials.'));
  const remote = (await ask('  Private repository')).trim();
  if (remote === '') return 'skipped';

  try {
    const sync = new ProfileSync(
      workspace.profilePaths,
      workspace.paths.home,
      preserveMachineLocations(workspace.store, workspace.machineId),
    );
    await sync.initialise(remote);
    await writeDataRepoScaffolding(workspace.profilePaths);
    await workspace.saveProfile({
      ...workspace.profile,
      sync: { ...workspace.profile.sync, enabled: true, remote, branch: 'main' },
    });

    // Run it now. A setup that ends with "and it might work later" is not a
    // setup; joining an existing profile has to visibly succeed here.
    const result = await sync.sync();
    await recordOutcome(workspace, result);
    return result.pulled > 0 ? 'received' : result.outcome === 'offline' ? 'failed' : 'connected';
  } catch {
    print('');
    print(style.yellow('  Could not connect sync. Everything else is set up.'));
    print(style.dim('  You can try again with: statenest sync init <url>'));
    return 'failed';
  }
}

function printWelcome(): void {
  print('');
  heading('StateNest');
  print(style.dim('A local-first memory for your projects, machines and deployments.'));
}

/**
 * Shown before any data is written.
 *
 * A tool that reads a developer's whole home directory has to earn that on
 * first contact, in plain language, without being asked.
 */
function printPrivacySummary(homePath: string): void {
  print('');
  print(style.bold('What this stores'));
  print(style.dim('  Project metadata and short checkpoints, on this machine, at'));
  print(style.dim(`  ${contractHome(homePath)}`));
  print('');
  print(style.bold('What it never stores'));
  for (const item of [
    'your source code',
    '.env files or their contents',
    'SSH keys, passwords or access tokens',
    'raw AI transcripts',
  ]) {
    print(style.dim(`  • ${item}`));
  }
  print('');
  print(style.dim('  Nothing leaves this machine. Optional sync to a private git'));
  print(style.dim('  repository you own can be enabled later with: statenest sync init'));
}

async function chooseRoots(
  explicit: string[] | undefined,
  assumeDefaults: boolean,
): Promise<string[]> {
  if (explicit && explicit.length > 0) {
    return explicit.map((root) => resolveUserPath(root));
  }

  const suggestions = await defaultRoots();

  if (suggestions.length === 0) {
    const answer = await ask('\nWhich directory holds your projects?', {
      defaultValue: `${homedir()}/Projects`,
      assumeDefaults,
    });
    const resolved = resolveUserPath(answer);
    return (await pathExists(resolved)) ? [resolved] : [];
  }

  const chosen = await multiSelect(
    style.bold('Which of these hold your projects?'),
    suggestions.map((path) => ({ label: contractHome(path), selected: true })),
    { assumeDefaults },
  );

  return chosen.map((index) => suggestions[index]!).filter(Boolean);
}

function isRecent(project: Parameters<typeof effectiveActivity>[0], days: number): boolean {
  const activity = effectiveActivity(project);
  if (!activity) return false;
  return Date.now() - new Date(activity).getTime() < days * 86_400_000;
}
