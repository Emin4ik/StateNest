import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pathExists, readFileOrNull } from '../../util/fs-atomic.js';
import { errnoCode } from '../../util/errors.js';
import { INSTALL_COMMAND } from '../../core/metadata.js';

const execFileAsync = promisify(execFile);

/**
 * Installing the Claude Code integration.
 *
 * The important decision here is what this does *not* do: it never edits
 * `~/.claude/settings.json`. Claude Code's plugin system owns hook
 * registration, MCP server registration and enablement, and it has a CLI for
 * all of it. Hand-editing a user's settings file to inject hooks would be
 * fragile, hard to reverse cleanly, and exactly the kind of thing the brief
 * rules out.
 *
 * So: register this package's own directory as a local marketplace, then ask
 * Claude Code to install the plugin from it. Uninstalling is the same two
 * commands in reverse, and anything the user configured themselves is
 * untouched throughout.
 */

export type InstallStatus =
  | 'installed'
  | 'already-installed'
  | 'updated'
  | 'claude-not-found'
  | 'plugin-dir-not-found'
  | 'build-missing'
  | 'failed'
  | 'skipped';

export interface InstallResult {
  status: InstallStatus;
  /** The plugin directory that was registered, when one was found. */
  pluginDir: string | null;
  marketplaceName: string;
  pluginName: string;
  /** Commands actually run, so `statenest doctor` and the docs can show them. */
  commands: string[];
  /** Human explanation, always safe to print. */
  message: string;
}

export const MARKETPLACE_NAME = 'statenest';
export const PLUGIN_NAME = 'statenest';

/**
 * Locate the plugin root: the directory holding `.claude-plugin/plugin.json`.
 *
 * When installed from npm this is the package root; in a source checkout it is
 * the repository root. Walking up from this module handles both without
 * needing to know which one we are in.
 */
export async function findPluginDir(startDir?: string): Promise<string | null> {
  const here = startDir ?? dirname(fileURLToPath(import.meta.url));
  let current = resolve(here);

  for (let depth = 0; depth < 8; depth++) {
    if (await pathExists(join(current, '.claude-plugin', 'plugin.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export async function isClaudeCodeInstalled(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['--version'], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where Claude Code keeps its configuration.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own setting for relocating this, and
 * honouring it is not optional: CONTRIBUTING.md tells contributors to point it
 * at a scratch directory before testing an integration, precisely so they do
 * not touch their real configuration. Reading `~/.claude` regardless made that
 * instruction false — the most dangerous kind of documentation, because the
 * person following it believes they are protected.
 */
export function claudeConfigDir(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR']?.trim();
  return configured ? configured : join(homedir(), '.claude');
}

/** Claude Code's home directory, if the user has ever run it. */
export async function claudeHomeExists(): Promise<boolean> {
  return pathExists(claudeConfigDir());
}

export interface InstallOptions {
  assumeDefaults?: boolean;
  /** Re-run installation even when the plugin is already registered. */
  repair?: boolean;
  /** Override the directory registered as the marketplace. Used by tests. */
  pluginDir?: string;
}

export async function installClaudeIntegration(
  options: InstallOptions = {},
): Promise<InstallResult> {
  const pluginDir = options.pluginDir ?? (await findPluginDir());
  const base: Omit<InstallResult, 'status' | 'message'> = {
    pluginDir,
    marketplaceName: MARKETPLACE_NAME,
    pluginName: PLUGIN_NAME,
    commands: [],
  };

  if (!pluginDir) {
    return {
      ...base,
      status: 'plugin-dir-not-found',
      message:
        `Could not find the bundled Claude Code plugin. Reinstall StateNest with: ${INSTALL_COMMAND}`,
    };
  }

  // The hooks and MCP server run from dist/. Registering a plugin whose entry
  // points do not exist would produce a plugin that silently does nothing.
  if (!(await pathExists(join(pluginDir, 'dist-plugin', 'hook.js')))) {
    return {
      ...base,
      status: 'build-missing',
      pluginDir,
      message:
        'The plugin is present but not built. Run `npm run build` in the StateNest ' +
        `checkout, or install the published package with: ${INSTALL_COMMAND}`,
    };
  }

  if (!(await isClaudeCodeInstalled())) {
    return {
      ...base,
      status: 'claude-not-found',
      pluginDir,
      message:
        'Claude Code was not found on the PATH. Install it, then run: statenest integrate claude',
    };
  }

  const alreadyEnabled = await isPluginEnabled();
  if (alreadyEnabled && !options.repair) {
    return {
      ...base,
      status: 'already-installed',
      pluginDir,
      message: 'Already installed. Use --repair to reinstall.',
    };
  }

  const commands: string[] = [];

  // `marketplace add` is idempotent for a path already registered, but a
  // repair should pick up a moved or upgraded package directory.
  if (options.repair) {
    await runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], commands, {
      ignoreFailure: true,
    });
  }

  const added = await runClaude(['plugin', 'marketplace', 'add', pluginDir], commands, {
    ignoreFailure: true,
  });
  if (!added.ok && !/already/i.test(added.output)) {
    return {
      ...base,
      status: 'failed',
      pluginDir,
      commands,
      message: `Could not register the plugin marketplace: ${firstLine(added.output)}`,
    };
  }

  const installed = await runClaude(
    ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
    commands,
    { ignoreFailure: true },
  );
  if (!installed.ok && !/already/i.test(installed.output)) {
    return {
      ...base,
      status: 'failed',
      pluginDir,
      commands,
      message: `Could not install the plugin: ${firstLine(installed.output)}`,
    };
  }

  return {
    ...base,
    status: alreadyEnabled ? 'updated' : 'installed',
    pluginDir,
    commands,
    message: 'Restart Claude Code, or run /plugin, to pick it up.',
  };
}

export async function uninstallClaudeIntegration(
  options: { removeMarketplace?: boolean } = {},
): Promise<{ removed: boolean; commands: string[]; message: string }> {
  const commands: string[] = [];

  if (!(await isClaudeCodeInstalled())) {
    return { removed: false, commands, message: 'Claude Code is not installed; nothing to remove.' };
  }

  const uninstalled = await runClaude(
    ['plugin', 'uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
    commands,
    { ignoreFailure: true },
  );

  if (options.removeMarketplace) {
    await runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], commands, {
      ignoreFailure: true,
    });
  }

  return {
    removed: uninstalled.ok,
    commands,
    message: uninstalled.ok
      ? 'Claude Code integration removed. Your StateNest data is untouched.'
      : `Could not remove the plugin: ${firstLine(uninstalled.output)}`,
  };
}

/**
 * Is the plugin currently enabled?
 *
 * Read from `~/.claude/settings.json` rather than by shelling out, because
 * this runs inside `statenest doctor` where a 200ms process spawn per check adds up.
 * The file is only ever read here, never written.
 */
export async function isPluginEnabled(): Promise<boolean> {
  const raw = await readFileOrNull(join(claudeConfigDir(), 'settings.json'));
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const enabled = (parsed as { enabledPlugins?: unknown }).enabledPlugins;
    if (typeof enabled !== 'object' || enabled === null) return false;
    return Object.entries(enabled as Record<string, unknown>).some(
      ([key, value]) => key.startsWith(`${PLUGIN_NAME}@`) && value !== false,
    );
  } catch {
    return false;
  }
}

export function describeClaudeInstall(result: InstallResult): string {
  switch (result.status) {
    case 'installed':
      return 'installed';
    case 'updated':
      return 'reinstalled';
    case 'already-installed':
      return 'already installed';
    case 'claude-not-found':
      return 'skipped (Claude Code not found)';
    case 'build-missing':
      return 'skipped (plugin not built)';
    case 'plugin-dir-not-found':
      return 'skipped (plugin files missing)';
    case 'skipped':
      return 'skipped';
    default:
      return `failed — ${result.message}`;
  }
}

async function runClaude(
  args: string[],
  commands: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  commands.push(`claude ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync('claude', args, {
      timeout: 120_000,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { ok: false, output: 'claude was not found' };
    const shaped = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${shaped.stdout ?? ''}${shaped.stderr ?? ''}`.trim() || shaped.message || 'unknown error';
    if (!options.ignoreFailure) throw error;
    return { ok: false, output };
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text.trim();
}
