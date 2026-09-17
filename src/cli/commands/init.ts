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

export function initCommand(): Command {
  return new Command('init')
    .description('Set up Project Brain on this machine')
    .option('-y, --yes', 'accept every default, ask nothing')
    .option('--profile <name>', 'profile to create or use', 'personal')
    .option('--machine-name <name>', 'what to call this computer')
    .option('--roots <dirs...>', 'directories that contain your projects')
    .option('--no-scan', 'set up without scanning for projects')
    .option('--no-claude', 'skip the Claude Code integration offer')
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
  profile: string;
  machineName?: string;
  roots?: string[];
  scan: boolean;
  claude: boolean;
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
        'Project Brain works without it, but it cannot read branches, commits or uncommitted changes.',
      ),
    );
  }

  // -- Privacy summary, before anything is written -------------------------
  // The home is resolved (not created) first, so the summary can name the real
  // location while still being shown before a single file exists.
  const homePath = resolveBrainHome(process.env, homedir());
  if (!wantsJson()) printPrivacySummary(globals.home ?? homePath);

  // -- Home and profile ----------------------------------------------------
  const workspace = await Workspace.initialize({
    ...(globals.home ? { home: globals.home } : {}),
    profileName: options.profile,
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
      await workspace.saveProfile({
        ...workspace.profile,
        project_roots: chosenRoots.map((root) => contractHome(root)),
      });
    }
  }

  // -- Scan ----------------------------------------------------------------
  const registry = new Registry(workspace.store);
  let registered = 0;
  let linked = 0;

  if (chosenRoots.length > 0) {
    if (!wantsJson()) process.stderr.write(style.dim('\nScanning...'));
    const scan = await scanForProjects(chosenRoots, {
      maxDepth: workspace.config.discovery.max_depth,
    });
    if (!wantsJson()) process.stderr.write('\r'.padEnd(40, ' ') + '\r');

    for (const candidate of scan.candidates) {
      const result = await registry.register(candidate.path, { machineId: workspace.machineId });
      if (result.outcome === 'created') registered++;
      else if (result.outcome === 'location-added') linked++;
    }
  }

  // -- Claude Code ---------------------------------------------------------
  let claudeResult: Awaited<ReturnType<typeof installClaudeIntegration>> | null = null;
  const claudeAvailable = await pathExists(`${homedir()}/.claude`);

  if (options.claude && claudeAvailable) {
    const wanted = await confirm('\nInstall the Claude Code integration?', {
      defaultValue: true,
      assumeDefaults,
    });
    if (wanted) claudeResult = await installClaudeIntegration({ assumeDefaults });
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
      projects_total: projects.length,
      claude_integration: claudeResult?.status ?? 'skipped',
    });
    return;
  }

  print('');
  success('Project Brain initialised');
  print(`  ${style.dim(contractHome(workspace.paths.home))}`);
  success(`Machine registered: ${style.bold(machine.name)} ${style.dim(`(${os})`)}`);
  if (claudeResult) {
    success(`Claude Code integration: ${describeClaudeInstall(claudeResult)}`);
  }
  if (chosenRoots.length > 0) {
    success(`${pluralize(projects.length, 'project')} discovered`);
    if (linked > 0) success(`${linked} already known from another machine, now linked here`);
    if (activeRecently > 0) success(`${activeRecently} active in the last 30 days`);
    if (deployments > 0) success(`${pluralize(deployments, 'deployment')} registered`);
  }

  print('');
  print(style.dim('Try:'));
  print(bullet(style.cyan('pb projects')));
  print(bullet(style.cyan('pb recent')));
  print(bullet(style.cyan('pb resume <project>')));
  print(bullet(style.cyan('pb doctor')));
  print('');
}

function printWelcome(): void {
  print('');
  heading('Project Brain');
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
  print(style.dim('  repository you own can be enabled later with: pb sync init'));
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
