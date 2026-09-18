import { Command } from 'commander';
import { join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { getGlobalOptions, wantsJson } from '../context.js';
import { failure, heading, print, printJson, pluralize, style, success } from '../output.js';
import { Workspace, listProfileNames, readPackageVersion } from '../../core/workspace.js';
import { Registry } from '../../core/registry.js';
import { createPaths } from '../../core/paths.js';
import { gitVersion } from '../../git/exec.js';
import { pathExists } from '../../util/fs-atomic.js';
import { contractHome } from '../../util/paths.js';
import {
  claudeHomeExists,
  findPluginDir,
  isClaudeCodeInstalled,
  isPluginEnabled,
} from '../../integrations/claude/install.js';
import { SCHEMA_VERSION } from '../../core/schema.js';
import { fileURLToPath } from 'node:url';
import { INSTALL_COMMAND } from '../../core/metadata.js';

type Level = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  name: string;
  level: Level;
  detail: string;
  /** A command that would fix it. Shown verbatim. */
  fix?: string;
}

/**
 * `pb doctor` has one job: turn "it isn't working" into a command to run.
 *
 * Every failing check carries a fix. A check that can only say "something is
 * wrong" is not worth having, because the user is no better off than before
 * they ran it.
 */
export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check the installation and say exactly how to fix anything broken')
    .option('--repair', 'attempt safe automatic repairs')
    .action(async (options: { repair?: boolean }) => {
      const checks: Check[] = [];
      const globals = getGlobalOptions();
      const paths = createPaths(globals.home);

      // -- Runtime -----------------------------------------------------------
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      checks.push({
        name: 'Node.js',
        level: nodeMajor >= 22 ? 'ok' : 'fail',
        detail: `v${process.versions.node}`,
        ...(nodeMajor >= 22 ? {} : { fix: 'Install Node.js 22.12 or newer.' }),
      });

      const pluginDir = await findPluginDir(fileURLToPath(import.meta.url));
      const version = pluginDir
        ? await readPackageVersion(join(pluginDir, 'package.json'))
        : '0.0.0';
      checks.push({ name: 'Project Brain', level: 'ok', detail: `v${version}` });

      const git = await gitVersion();
      checks.push({
        name: 'git',
        level: git ? 'ok' : 'warn',
        detail: git ? git : 'not found',
        ...(git
          ? {}
          : { fix: 'Install git. Without it, branches and uncommitted changes cannot be read.' }),
      });

      // -- Data home ---------------------------------------------------------
      const homeExists = await pathExists(paths.configFile);
      checks.push({
        name: 'Data directory',
        level: homeExists ? 'ok' : 'fail',
        detail: contractHome(paths.home),
        ...(homeExists ? {} : { fix: 'pb init' }),
      });

      if (!homeExists) {
        return report(checks, options, null);
      }

      checks.push(await checkWritable(paths.home));

      // -- Workspace ---------------------------------------------------------
      let workspace: Workspace | null = null;
      try {
        workspace = await Workspace.open({
          ...(globals.home ? { home: globals.home } : {}),
          ...(globals.profile ? { profile: globals.profile } : {}),
        });
        checks.push({
          name: 'Active profile',
          level: 'ok',
          detail: workspace.profile.name,
        });
      } catch (error) {
        checks.push({
          name: 'Active profile',
          level: 'fail',
          detail: error instanceof Error ? error.message : String(error),
          fix: 'pb profile list',
        });
      }

      const profiles = await listProfileNames(paths);
      checks.push({
        name: 'Profiles',
        level: profiles.length > 0 ? 'ok' : 'warn',
        detail: profiles.join(', ') || 'none',
      });

      if (workspace) {
        // -- Schema ----------------------------------------------------------
        const configVersion = workspace.config.schema_version;
        checks.push({
          name: 'Schema version',
          level: configVersion <= SCHEMA_VERSION ? 'ok' : 'warn',
          detail:
            configVersion === SCHEMA_VERSION
              ? `v${configVersion}`
              : `data is v${configVersion}, this build understands v${SCHEMA_VERSION}`,
          ...(configVersion <= SCHEMA_VERSION
            ? {}
            : { fix: `Update Project Brain: ${INSTALL_COMMAND}@latest` }),
        });

        // -- Data integrity ---------------------------------------------------
        const registry = new Registry(workspace.store);
        const projects = await registry.all();
        let checkpointCount = 0;
        for (const project of projects) {
          checkpointCount += (await workspace.store.listCheckpointFiles(project.id)).length;
        }

        checks.push({
          name: 'Projects',
          level: 'ok',
          detail: `${pluralize(projects.length, 'project')} registered, ${pluralize(checkpointCount, 'checkpoint')}`,
        });

        const missingPaths: string[] = [];
        for (const project of projects) {
          for (const location of project.local_locations) {
            if (location.machine_id !== workspace.machineId) continue;
            if (!(await pathExists(location.path))) {
              missingPaths.push(`${project.name}: ${contractHome(location.path)}`);
            }
          }
        }
        checks.push({
          name: 'Local paths',
          level: missingPaths.length === 0 ? 'ok' : 'warn',
          detail:
            missingPaths.length === 0
              ? 'all registered paths exist'
              : `${missingPaths.length} registered path(s) no longer exist`,
          ...(missingPaths.length === 0 ? {} : { fix: 'pb scan   (re-detects moved projects)' }),
        });

        const issues = workspace.store.getIssues();
        checks.push({
          name: 'File integrity',
          level: issues.length === 0 ? 'ok' : 'warn',
          detail:
            issues.length === 0
              ? 'every file parsed cleanly'
              : `${issues.length} file(s) could not be parsed`,
          ...(issues.length === 0
            ? {}
            : {
                fix:
                  'Inspect them directly; Project Brain never deletes files it cannot read:\n    ' +
                  issues
                    .slice(0, 5)
                    .map((issue) => `${contractHome(issue.filePath)} (${issue.reason})`)
                    .join('\n    '),
              }),
        });

        // -- Sync -------------------------------------------------------------
        const syncEnabled = workspace.profile.sync.enabled;
        const hasGitDir = await pathExists(join(workspace.profilePaths.root, '.git'));
        checks.push({
          name: 'Sync',
          level: syncEnabled && !hasGitDir ? 'warn' : 'ok',
          detail: syncEnabled
            ? hasGitDir
              ? `enabled → ${workspace.profile.sync.remote ?? 'no remote set'}`
              : 'enabled in config but the profile is not a git repository'
            : 'disabled (everything stays on this machine)',
          ...(syncEnabled && !hasGitDir ? { fix: 'pb sync init' } : {}),
        });
      }

      // -- Claude Code -------------------------------------------------------
      checks.push(...(await claudeChecks(pluginDir)));

      report(checks, options, workspace);
    });
}

async function claudeChecks(pluginDir: string | null): Promise<Check[]> {
  const checks: Check[] = [];

  const installed = await isClaudeCodeInstalled();
  const homeThere = await claudeHomeExists();

  if (!installed && !homeThere) {
    checks.push({
      name: 'Claude Code',
      level: 'skip',
      detail: 'not installed — Project Brain works fine without it',
    });
    return checks;
  }

  checks.push({
    name: 'Claude Code',
    level: installed ? 'ok' : 'warn',
    detail: installed ? 'found on PATH' : 'config directory exists but CLI is not on PATH',
  });

  if (!pluginDir) {
    checks.push({
      name: 'Plugin files',
      level: 'fail',
      detail: 'the bundled plugin could not be located',
      fix: INSTALL_COMMAND,
    });
    return checks;
  }

  // Hooks and the MCP server are the compiled entry points. If the build is
  // missing, the plugin installs successfully and then silently does nothing -
  // which is precisely the failure this check exists to name.
  const hookBuilt = await pathExists(join(pluginDir, 'dist-plugin', 'hook.js'));
  const mcpBuilt = await pathExists(join(pluginDir, 'dist-plugin', 'server.js'));
  checks.push({
    name: 'Plugin build',
    level: hookBuilt && mcpBuilt ? 'ok' : 'fail',
    detail: hookBuilt && mcpBuilt ? 'hook and MCP entry points present' : 'compiled output missing',
    ...(hookBuilt && mcpBuilt
      ? {}
      : { fix: `npm run build   (in a checkout), or: ${INSTALL_COMMAND}` }),
  });

  const enabled = await isPluginEnabled();
  checks.push({
    name: 'Plugin enabled',
    level: enabled ? 'ok' : 'warn',
    detail: enabled ? 'enabled in Claude Code' : 'not installed in Claude Code',
    ...(enabled ? {} : { fix: 'pb integrate claude' }),
  });

  for (const [label, relative] of [
    ['Hooks config', join('hooks', 'hooks.json')],
    ['MCP config', '.mcp.json'],
  ] as const) {
    const exists = await pathExists(join(pluginDir, relative));
    checks.push({
      name: label,
      level: exists ? 'ok' : 'fail',
      detail: exists ? relative : `${relative} is missing from the plugin`,
      ...(exists ? {} : { fix: `Reinstall: ${INSTALL_COMMAND}` }),
    });
  }

  return checks;
}

async function checkWritable(dir: string): Promise<Check> {
  try {
    await access(dir, constants.W_OK);
    return { name: 'Permissions', level: 'ok', detail: 'data directory is writable' };
  } catch {
    return {
      name: 'Permissions',
      level: 'fail',
      detail: `${contractHome(dir)} is not writable`,
      fix: `Fix ownership, for example: chown -R "$USER" ${contractHome(dir)}`,
    };
  }
}

function report(checks: Check[], options: { repair?: boolean }, workspace: Workspace | null): void {
  const failed = checks.filter((check) => check.level === 'fail');
  const warned = checks.filter((check) => check.level === 'warn');

  if (wantsJson()) {
    printJson({
      healthy: failed.length === 0,
      failures: failed.length,
      warnings: warned.length,
      checks,
    });
    process.exitCode = failed.length > 0 ? 1 : 0;
    return;
  }

  print('');
  heading('Project Brain doctor');
  print('');

  for (const check of checks) {
    const mark =
      check.level === 'ok'
        ? style.green('✓')
        : check.level === 'warn'
          ? style.yellow('!')
          : check.level === 'fail'
            ? style.red('✗')
            : style.dim('·');
    print(`  ${mark} ${check.name.padEnd(18)} ${style.dim(check.detail)}`);
  }

  const needingFixes = checks.filter((check) => check.fix);
  if (needingFixes.length > 0) {
    print('');
    print(style.bold('  How to fix'));
    for (const check of needingFixes) {
      print('');
      print(`    ${check.name}`);
      for (const line of check.fix!.split('\n')) print(`      ${style.cyan(line)}`);
    }
  }

  print('');
  if (failed.length === 0 && warned.length === 0) {
    success('Everything checks out.');
  } else if (failed.length === 0) {
    print(style.yellow(`${warned.length} warning(s), nothing broken.`));
  } else {
    failure(`${failed.length} problem(s) found.`);
    process.exitCode = 1;
  }

  if (options.repair) {
    print('');
    print(
      style.dim(
        'Automatic repair does not delete or rewrite your data. Run the commands above instead.',
      ),
    );
  }

  if (workspace) {
    print('');
    print(style.dim(`  data: ${contractHome(workspace.paths.home)}`));
  }
  print('');
}
