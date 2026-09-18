import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { bullet, failure, print, printJson, style, success } from '../output.js';
import {
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  describeClaudeInstall,
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from '../../integrations/claude/install.js';
import { contractHome } from '../../util/paths.js';

/**
 * `statenest integrate claude` wires StateNest into Claude Code.
 *
 * It does this entirely through Claude Code's own plugin CLI. The user's
 * `settings.json` is read but never written: plugin installation, hook
 * registration and MCP registration are all Claude Code's to manage, and
 * hand-editing its config would make uninstalling messy and upgrades fragile.
 */
export function integrateCommand(): Command {
  const command = new Command('integrate').description('Connect StateNest to a coding agent');

  command
    .command('claude')
    .description('Install the Claude Code plugin (hooks, skills and MCP tools)')
    .option('--repair', 'reinstall even if it is already present')
    .option('-y, --yes', 'do not prompt')
    .action(async (options: { repair?: boolean; yes?: boolean }) => {
      const result = await installClaudeIntegration({
        ...(options.repair ? { repair: true } : {}),
        ...(options.yes ? { assumeDefaults: true } : {}),
      });

      if (wantsJson()) {
        printJson(result);
        if (result.status === 'failed') process.exitCode = 1;
        return;
      }

      print('');
      if (result.status === 'failed') {
        failure(`Could not install the Claude Code plugin.`);
        print(`  ${style.dim(result.message)}`);
        print('');
        print(style.dim('  You can install it by hand:'));
        print(bullet(style.cyan(`claude plugin marketplace add ${result.pluginDir ?? '<plugin dir>'}`)));
        print(bullet(style.cyan(`claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`)));
        process.exitCode = 1;
        return;
      }

      if (result.status === 'installed' || result.status === 'updated' || result.status === 'already-installed') {
        success(`Claude Code integration ${describeClaudeInstall(result)}`);
        if (result.pluginDir) print(`  ${style.dim(contractHome(result.pluginDir))}`);
        print(`  ${style.dim(result.message)}`);
        print('');
        print(style.dim('  In Claude Code you now have:'));
        print(`    ${style.cyan('/statenest:resume')}      pick a project back up`);
        print(`    ${style.cyan('/statenest:checkpoint')}  record what you just did`);
        print(`    ${style.cyan('/statenest:where')}       find a project's copies and servers`);
        print('');
        print(
          style.dim(
            '  A short brief is injected when you start Claude Code inside a registered project.',
          ),
        );
      } else {
        print(`${style.yellow('Skipped')} — ${result.message}`);
      }
      print('');
    });

  command
    .command('status')
    .description('Show which integrations are active')
    .action(async () => {
      const { workspace } = await openContext();
      const { isPluginEnabled, isClaudeCodeInstalled } = await import(
        '../../integrations/claude/install.js'
      );

      const claudeInstalled = await isClaudeCodeInstalled();
      const pluginEnabled = await isPluginEnabled();

      if (wantsJson()) {
        printJson({
          profile: workspace.profile.name,
          claude_code: { installed: claudeInstalled, plugin_enabled: pluginEnabled },
        });
        return;
      }

      print('');
      print(
        `  Claude Code   ${claudeInstalled ? style.green('installed') : style.dim('not found')}`,
      );
      print(
        `  Plugin        ${pluginEnabled ? style.green('enabled') : style.yellow('not installed')}`,
      );
      if (!pluginEnabled && claudeInstalled) {
        print('');
        print(bullet(style.cyan('statenest integrate claude')));
      }
      print('');
    });

  command
    .command('remove')
    .description('Remove a coding-agent integration; your data is untouched')
    .argument('[agent]', 'which integration to remove', 'claude')
    .option('--purge', 'also remove the registered marketplace entry')
    .action(async (agent: string, options: { purge?: boolean }) => {
      if (agent !== 'claude') {
        failure(`Unknown integration "${agent}". The only one available is: claude`);
        process.exitCode = 1;
        return;
      }

      const result = await uninstallClaudeIntegration({
        ...(options.purge ? { removeMarketplace: true } : {}),
      });

      if (wantsJson()) return printJson(result);

      print('');
      if (result.removed) success(result.message);
      else print(`${style.yellow('Note')} — ${result.message}`);
      print('');
    });

  return command;
}
