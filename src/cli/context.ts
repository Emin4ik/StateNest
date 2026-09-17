import { Workspace, type OpenOptions } from '../core/workspace.js';
import { Registry } from '../core/registry.js';
import { configureColor, warn } from './output.js';
import { contractHome } from '../util/paths.js';

/**
 * Options every command shares.
 *
 * Held in a module-level holder rather than threaded through every command,
 * because commander gives subcommands no clean access to root options and the
 * alternative is an extra parameter on twenty functions.
 */
export interface GlobalOptions {
  home?: string;
  profile?: string;
  json: boolean;
  quiet: boolean;
  color: boolean;
}

let globals: GlobalOptions = { json: false, quiet: false, color: true };

export function setGlobalOptions(options: Partial<GlobalOptions>): void {
  globals = { ...globals, ...options };
  configureColor({ noColor: !globals.color });
}

export function getGlobalOptions(): GlobalOptions {
  return globals;
}

export function wantsJson(): boolean {
  return globals.json;
}

/** An opened workspace plus the registry over it. */
export interface CommandContext {
  workspace: Workspace;
  registry: Registry;
}

let cached: CommandContext | null = null;

/**
 * Open the workspace for this invocation.
 *
 * Cached so that a command which needs the registry twice does not re-read
 * every project file. Commands that do not touch stored data (`pb --version`,
 * `pb doctor` on an uninitialised machine) never call this.
 */
export async function openContext(overrides: OpenOptions = {}): Promise<CommandContext> {
  if (cached) return cached;

  const workspace = await Workspace.open({
    ...(globals.home ? { home: globals.home } : {}),
    ...(globals.profile ? { profile: globals.profile } : {}),
    ...overrides,
  });

  const context: CommandContext = { workspace, registry: new Registry(workspace.store) };

  // Corrupt files are surfaced once per invocation rather than swallowed, but
  // they never stop the command the user actually asked for.
  reportLoadIssues(context);

  cached = context;
  return context;
}

/** Test seam: forget the cached workspace between runs in one process. */
export function resetContext(): void {
  cached = null;
}

function reportLoadIssues(context: CommandContext): void {
  const issues = context.workspace.store.getIssues();
  if (issues.length === 0 || globals.quiet || globals.json) return;
  for (const issue of issues.slice(0, 3)) {
    warn(`${contractHome(issue.filePath)} could not be read (${issue.reason})`);
  }
  if (issues.length > 3) warn(`${issues.length - 3} more files could not be read. Run: pb doctor`);
}

/**
 * Report issues that appeared *after* the workspace was opened, such as a
 * checkpoint that failed to parse while building a resume brief.
 */
export function reportLateIssues(context: CommandContext, alreadyReported = 0): void {
  const issues = context.workspace.store.getIssues().slice(alreadyReported);
  if (issues.length === 0 || globals.quiet || globals.json) return;
  warn(`${issues.length} file(s) could not be read while running this command. Run: pb doctor`);
}
