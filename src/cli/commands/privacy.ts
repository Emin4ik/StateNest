import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { failure, heading, print, printJson, pluralize, style, success } from '../output.js';
import { auditProfile, describeBlock, hasBlockingFindings, totalFindings } from '../../security/audit.js';
import { contractHome } from '../../util/paths.js';

export function privacyCommand(): Command {
  const command = new Command('privacy').description('Check what Project Brain is storing');

  command
    .command('audit', { isDefault: true })
    .description('Scan Project Brain\'s own data for anything that looks like a secret')
    .option('--all-profiles', 'audit every profile, not just the active one')
    .action(async (options: { allProfiles?: boolean }) => {
      const { workspace } = await openContext();

      const profileNames = options.allProfiles
        ? (await import('../../core/workspace.js')).listProfileNames(workspace.paths)
        : Promise.resolve([workspace.profile.name]);

      const results = [];
      for (const name of await profileNames) {
        const paths = workspace.paths.profile(name);
        results.push({ profile: name, result: await auditProfile(paths), root: paths.root });
      }

      if (wantsJson()) {
        printJson({
          profiles: results.map(({ profile, result }) => ({
            profile,
            files_scanned: result.filesScanned,
            findings: totalFindings(result),
            blocking: hasBlockingFindings(result),
            // Findings carry masked fragments only - never the value itself.
            files: result.files.map((file) => ({
              path: file.relativePath,
              findings: file.findings,
            })),
            unreadable: result.unreadable,
          })),
        });
        process.exitCode = results.some(({ result }) => hasBlockingFindings(result)) ? 1 : 0;
        return;
      }

      print('');
      heading('Privacy audit');

      let anyBlocking = false;
      for (const { profile, result, root } of results) {
        const findings = totalFindings(result);
        print('');
        print(`  ${style.bold(profile)}  ${style.dim(contractHome(root))}`);
        print(
          style.dim(
            `  ${pluralize(result.filesScanned, 'file')} scanned in ${result.durationMs}ms`,
          ),
        );

        if (findings === 0) {
          print(`  ${style.green('✓')} nothing that looks like a credential`);
        } else {
          anyBlocking ||= hasBlockingFindings(result);
          print(`  ${style.red('✗')} ${pluralize(findings, 'possible secret')} found`);
          print('');
          for (const line of describeBlock(result)) {
            print(`    ${style.yellow(line)}`);
          }
          const lowOnly = result.files.flatMap((file) =>
            file.findings.filter((finding) => finding.severity === 'medium'),
          );
          if (lowOnly.length > 0) {
            print(`    ${style.dim(`${lowOnly.length} lower-confidence match(es) not listed above`)}`);
          }
        }

        if (result.unreadable.length > 0) {
          print(`    ${style.dim(`${result.unreadable.length} file(s) could not be read`)}`);
        }
      }

      print('');
      if (anyBlocking) {
        failure('Sync is blocked while these are present.');
        print('');
        print(style.dim('  The values above are masked. To resolve:'));
        print(`    ${style.dim('1.')} open the file named and remove the credential`);
        print(`    ${style.dim('2.')} rotate it, since it has been written to disk`);
        print(`    ${style.dim('3.')} re-run ${style.cyan('pb privacy audit')}`);
        process.exitCode = 1;
      } else {
        success('Nothing sensitive found in Project Brain\'s data.');
      }
      print('');
    });

  command
    .command('policy')
    .description('Show exactly what Project Brain does and does not store')
    .action(async () => {
      const { workspace } = await openContext();

      if (wantsJson()) {
        return printJson({
          home: workspace.paths.home,
          profile: workspace.profile.name,
          privacy_level: workspace.profile.privacy,
          telemetry: false,
          sync_enabled: workspace.profile.sync.enabled,
          stores: [
            'project names, descriptions and tags',
            'where each project lives on each machine',
            'git branch, commit sha and change counts',
            'checkpoints you or your coding agent write',
            'decisions, tasks and blockers',
            'server addresses and deploy paths',
          ],
          never_stores: [
            'source code',
            '.env files or their contents',
            'ssh private keys or passwords',
            'API keys or access tokens',
            'raw AI transcripts',
            'anything on a Project Brain server (there is none)',
          ],
        });
      }

      print('');
      heading('What Project Brain stores');
      print('');
      for (const item of [
        'project names, descriptions and tags',
        'where each project lives, on which machine, at which path',
        'git branch, commit sha, and how many files changed',
        'checkpoints: what was done, decided, blocked, and what is next',
        'server addresses and deploy paths',
      ]) {
        print(`  ${style.green('✓')} ${item}`);
      }

      print('');
      heading('What it never stores');
      print('');
      for (const item of [
        'your source code',
        '.env files, or anything inside them',
        'ssh private keys, passwords or API tokens',
        'raw AI transcripts',
      ]) {
        print(`  ${style.red('✗')} ${item}`);
      }

      print('');
      print(`  ${style.dim('Location')}   ${contractHome(workspace.paths.home)}`);
      print(
        `  ${style.dim('Telemetry')}  ${style.green('disabled')} ${style.dim('(there is no telemetry code in this build)')}`,
      );
      print(
        `  ${style.dim('Sync')}       ${workspace.profile.sync.enabled ? workspace.profile.sync.remote ?? 'enabled' : style.dim('off — nothing leaves this machine')}`,
      );
      print('');
      print(style.dim('  Full details: docs/security-model.md'));
      print('');
    });

  return command;
}
