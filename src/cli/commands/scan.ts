import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openContext, wantsJson } from '../context.js';
import { bullet, heading, print, printJson, pluralize, style } from '../output.js';
import { scanForProjects, type Candidate } from '../../discovery/scanner.js';
import { pathExists } from '../../util/fs-atomic.js';
import { contractHome, resolveUserPath } from '../../util/paths.js';
import type { Registry } from '../../core/registry.js';
import { hasLocationOnAnotherMachine } from '../../core/registry.js';
import type { Workspace } from '../../core/workspace.js';

export function scanCommand(): Command {
  return new Command('scan')
    .description('Find git repositories under one or more directories and register them')
    .argument('[roots...]', 'directories to scan (defaults to the profile\'s project roots)')
    .option('--depth <n>', 'how deep to descend', (value) => Number.parseInt(value, 10))
    .option('--dry-run', 'show what would be registered, change nothing')
    .option('--include-non-git', 'also register project-looking directories without a repository')
    .option('--nested', 'keep descending inside repositories to find nested ones')
    .option('--save-roots', 'remember these directories as the profile\'s scan roots')
    .action(async (roots: string[], options: ScanOptions) => {
      const context = await openContext();
      const { workspace } = context;

      const targets = await resolveRoots(roots, workspace);
      if (targets.length === 0) {
        heading('Nothing to scan.');
        print('');
        print('Name the directories your projects live in:');
        print('');
        print(bullet(style.cyan('statenest scan ~/Projects ~/Work --save-roots')));
        return;
      }

      const result = await runScan(context, targets, options);

      if (wantsJson()) {
        printJson(result.json);
        return;
      }

      renderHumanReport(result, targets, options);
    });
}

interface ScanOptions {
  depth?: number;
  dryRun?: boolean;
  includeNonGit?: boolean;
  nested?: boolean;
  saveRoots?: boolean;
}

interface ScanReport {
  created: string[];
  locationsAdded: string[];
  linkedFromOtherMachine: string[];
  alreadyKnown: number;
  skipped: number;
  durationMs: number;
  visited: number;
  permissionErrors: number;
  unreadableRoots: { path: string; reason: string }[];
  candidates: Candidate[];
  json: Record<string, unknown>;
}

async function runScan(
  context: { workspace: Workspace; registry: Registry },
  targets: string[],
  options: ScanOptions,
): Promise<ScanReport> {
  const { workspace, registry } = context;
  const interactive = Boolean(process.stderr.isTTY) && !wantsJson();

  const scan = await scanForProjects(targets, {
    maxDepth: options.depth ?? workspace.config.discovery.max_depth,
    exclude: workspace.config.discovery.exclude,
    ...(options.includeNonGit ? { includeNonGit: true } : {}),
    ...(options.nested ? { nested: true } : {}),
    ...(interactive
      ? {
          onProgress: (visited: number, found: number) => {
            process.stderr.write(`\r${style.dim(`scanning... ${visited} directories, ${found} found`)}`);
          },
        }
      : {}),
  });

  if (interactive) process.stderr.write('\r'.padEnd(60, ' ') + '\r');

  const created: string[] = [];
  const locationsAdded: string[] = [];
  const linkedFromOtherMachine: string[] = [];
  let alreadyKnown = 0;

  if (!options.dryRun) {
    // Sequential on purpose: registration reads and writes the shared project
    // list, and a parallel pass would race two candidates of the same
    // repository into two records.
    for (const candidate of scan.candidates) {
      const result = await registry.register(candidate.path, { machineId: workspace.machineId });
      if (result.outcome === 'created') created.push(result.project.name);
      else if (result.outcome === 'location-added') {
        // Distinguish a second copy on this computer from a project that really
        // does live on another one. Both produce `location-added`.
        if (hasLocationOnAnotherMachine(result.project, workspace.machineId)) {
          linkedFromOtherMachine.push(result.project.name);
        } else {
          locationsAdded.push(result.project.name);
        }
      } else alreadyKnown++;
    }
  }

  if (options.saveRoots && !options.dryRun) {
    const existing = new Set(workspace.profile.project_roots);
    for (const target of targets) existing.add(contractHome(target));
    await workspace.saveProfile({ ...workspace.profile, project_roots: [...existing].sort() });
  }

  return {
    created,
    locationsAdded,
    linkedFromOtherMachine,
    alreadyKnown,
    skipped: scan.stats.directoriesPruned,
    durationMs: scan.stats.durationMs,
    visited: scan.stats.directoriesVisited,
    permissionErrors: scan.stats.permissionErrors,
    unreadableRoots: scan.unreadableRoots,
    candidates: scan.candidates,
    json: {
      roots: targets,
      dry_run: Boolean(options.dryRun),
      found: scan.candidates.length,
      created: created.length,
      locations_added: locationsAdded.length + linkedFromOtherMachine.length,
      locations_added_this_machine: locationsAdded.length,
      locations_linked_from_other_machine: linkedFromOtherMachine.length,
      already_known: alreadyKnown,
      duration_ms: scan.stats.durationMs,
      directories_visited: scan.stats.directoriesVisited,
      permission_errors: scan.stats.permissionErrors,
      unreadable_roots: scan.unreadableRoots,
      candidates: scan.candidates.map((candidate) => ({
        path: candidate.path,
        is_git_repo: candidate.isGitRepo,
        marker: candidate.marker,
      })),
    },
  };
}

function renderHumanReport(report: ScanReport, targets: string[], options: ScanOptions): void {
  const where = targets.map((target) => contractHome(target)).join(', ');

  if (report.candidates.length === 0) {
    print(`No projects found under ${where}.`);
    if (report.permissionErrors > 0) {
      print(style.dim(`${report.permissionErrors} directories could not be read.`));
    }
    return;
  }

  if (options.dryRun) {
    heading(`Found ${pluralize(report.candidates.length, 'project')} under ${where}:`);
    print('');
    for (const candidate of report.candidates.slice(0, 40)) {
      print(bullet(contractHome(candidate.path), candidate.isGitRepo ? 'git' : 'dir'));
    }
    if (report.candidates.length > 40) {
      print(style.dim(`  ... and ${report.candidates.length - 40} more`));
    }
    print('');
    print(style.dim('Nothing was registered. Re-run without --dry-run to register them.'));
    return;
  }

  const lines: string[] = [];
  if (report.created.length > 0) {
    lines.push(`${pluralize(report.created.length, 'new project')} registered`);
  }
  if (report.locationsAdded.length > 0) {
    lines.push(
      `${pluralize(report.locationsAdded.length, 'extra copy', 'extra copies')} of a known project linked`,
    );
  }
  if (report.linkedFromOtherMachine.length > 0) {
    lines.push(
      `${report.linkedFromOtherMachine.length} already known from another machine, now linked here`,
    );
  }
  if (report.alreadyKnown > 0) lines.push(`${report.alreadyKnown} already up to date`);

  heading(`Scanned ${where} in ${report.durationMs}ms`);
  print('');
  for (const line of lines) print(bullet(line, '✓'));

  if (report.created.length > 0) {
    print('');
    for (const name of report.created.slice(0, 12)) print(`    ${style.bold(name)}`);
    if (report.created.length > 12) {
      print(style.dim(`    ... and ${report.created.length - 12} more`));
    }
  }

  if (report.permissionErrors > 0) {
    print('');
    print(style.dim(`${report.permissionErrors} directories could not be read (permission denied).`));
  }
  for (const root of report.unreadableRoots) {
    print(style.dim(`${contractHome(root.path)}: ${root.reason}`));
  }

  print('');
  print(style.dim('Next:'));
  print(bullet(style.cyan('statenest projects')));
  print(bullet(style.cyan('statenest recent')));
}

/**
 * Work out what to scan.
 *
 * An explicit argument always wins. Otherwise the profile's remembered roots
 * are used, and if there are none, the directories most developers actually
 * keep code in - but only the ones that exist, so the first run never reports
 * errors for folders the user does not have.
 */
export async function resolveRoots(roots: string[], workspace: Workspace): Promise<string[]> {
  if (roots.length > 0) return roots.map((root) => resolveUserPath(root));

  const remembered = workspace.profile.project_roots;
  if (remembered.length > 0) return remembered.map((root) => resolveUserPath(root));

  return defaultRoots();
}

const COMMON_PROJECT_DIRS = [
  'Projects',
  'projects',
  'code',
  'Code',
  'src',
  'dev',
  'Developer',
  'Development',
  'work',
  'Work',
  'repos',
  'git',
  'workspace',
  'sites',
];

/** Conventional project directories that actually exist on this machine. */
export async function defaultRoots(home = homedir()): Promise<string[]> {
  const found: string[] = [];
  await Promise.all(
    COMMON_PROJECT_DIRS.map(async (name) => {
      const path = join(home, name);
      if (await pathExists(path)) found.push(path);
    }),
  );
  return found.sort();
}
