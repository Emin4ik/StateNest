import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { heading, print, printJson, pluralize, style } from '../output.js';
import { effectiveActivity } from './projects.js';
import { readRepoFull } from '../../git/repo.js';
import { relativeTime } from '../../util/time.js';
import { contractHome } from '../../util/paths.js';
import type { Project } from '../../core/schema.js';

/**
 * `pb status` is the "where do things stand" overview.
 *
 * It answers the questions a developer asks on a Monday morning: what is
 * active, what is blocked, what did I leave uncommitted, and what have I not
 * touched in a month.
 */
export function statusCommand(): Command {
  return new Command('status')
    .description('An overview of everything: active, blocked, stale and uncommitted')
    .option('--stale-days <n>', 'how old counts as stale', (v) => Number.parseInt(v, 10), 30)
    .action(async (options: { staleDays?: number }) => {
      const { workspace, registry } = await openContext();
      const projects = await registry.all();
      const staleDays = options.staleDays ?? 30;

      const byStatus = new Map<string, number>();
      for (const project of projects) {
        byStatus.set(project.status, (byStatus.get(project.status) ?? 0) + 1);
      }

      const blocked = projects.filter((project) => project.blockers.length > 0);
      const stale = projects.filter((project) => {
        if (project.status === 'archived') return false;
        const activity = effectiveActivity(project);
        if (!activity) return true;
        return Date.now() - new Date(activity).getTime() > staleDays * 86_400_000;
      });

      const deployments = projects.reduce((sum, project) => sum + project.deployments.length, 0);

      // Checking the working tree means touching the filesystem for every
      // local copy, so it is done once here and reused.
      const dirty = await findDirtyProjects(projects, workspace.machineId);

      if (wantsJson()) {
        printJson({
          profile: workspace.profile.name,
          machine_id: workspace.machineId,
          totals: {
            projects: projects.length,
            by_status: Object.fromEntries(byStatus),
            deployments,
          },
          dirty: dirty.map((entry) => ({
            project: entry.name,
            path: entry.path,
            branch: entry.branch,
          })),
          blocked: blocked.map((project) => ({ project: project.name, blockers: project.blockers })),
          stale: stale.map((project) => ({
            project: project.name,
            last_activity_at: effectiveActivity(project),
          })),
        });
        return;
      }

      print('');

      if (projects.length === 0) {
        heading('Nothing tracked yet.');
        print('');
        print(style.dim('  Project Brain finds projects by scanning directories you name:'));
        print('');
        print(`    ${style.cyan('pb scan ~/Projects ~/Work')}`);
        print(`    ${style.cyan('pb add .')}                   ${style.dim('register the current directory')}`);
        print('');
        print(style.dim(`  profile: ${workspace.profile.name}  ·  ${contractHome(workspace.paths.home)}`));
        print('');
        return;
      }

      heading(`${pluralize(projects.length, 'project')}`);
      print('');
      for (const status of ['active', 'paused', 'waiting', 'archived'] as const) {
        const count = byStatus.get(status) ?? 0;
        if (count > 0) print(`  ${status.padEnd(12)} ${String(count).padStart(4)}`);
      }

      if (deployments > 0) {
        print('');
        print(`  ${pluralize(deployments, 'deployment')} across ${pluralize(await countRemotes(workspace), 'server')}`);
      }

      if (dirty.length > 0) {
        print('');
        print(style.bold('  Uncommitted work'));
        for (const entry of dirty.slice(0, 10)) {
          print(
            `    ${style.yellow(entry.name.padEnd(24))} ${style.dim(entry.branch ?? '')}  ${style.dim(contractHome(entry.path))}`,
          );
        }
        if (dirty.length > 10) print(style.dim(`    ... and ${dirty.length - 10} more`));
      }

      if (blocked.length > 0) {
        print('');
        print(style.bold('  Blocked'));
        for (const project of blocked.slice(0, 8)) {
          print(`    ${project.name.padEnd(24)} ${style.dim(project.blockers[0] ?? '')}`);
        }
      }

      if (stale.length > 0) {
        print('');
        print(style.bold(`  Untouched for over ${staleDays} days`));
        for (const project of stale.slice(0, 8)) {
          print(
            `    ${project.name.padEnd(24)} ${style.dim(relativeTime(effectiveActivity(project)))}`,
          );
        }
        if (stale.length > 8) print(style.dim(`    ... and ${stale.length - 8} more`));
        print('');
        print(style.dim(`  pb projects --stale ${staleDays}   to review them`));
      }

      // A status report with nothing to report should say so, and point
      // somewhere useful, rather than trailing off after a table of counts.
      if (dirty.length === 0 && blocked.length === 0 && stale.length === 0) {
        print('');
        print(`  ${style.green('Nothing needs attention.')}`);
        print('');
        print(style.dim('  pb recent    what you have been working on'));
        print(style.dim('  pb projects  everything Project Brain knows about'));
      }

      print('');
      print(
        style.dim(
          `  profile: ${workspace.profile.name}  \u00b7  machine: ${(await workspace.currentMachine())?.name ?? workspace.machineId}`,
        ),
      );
      print('');
    });
}

interface DirtyEntry {
  name: string;
  path: string;
  branch: string | null;
}

/**
 * Which local copies have uncommitted changes.
 *
 * Working-tree dirtiness genuinely cannot be determined without git, so this
 * pays for a real `git status` per local copy - but with bounded concurrency
 * and a short timeout, because `pb status` across fifty repositories would
 * otherwise spawn fifty git processes at once.
 *
 * Unreadable or missing paths are skipped rather than reported as clean: an
 * absent answer is honest, a fabricated one is not.
 */
async function findDirtyProjects(
  projects: readonly Project[],
  machineId: string,
  concurrency = 8,
): Promise<DirtyEntry[]> {
  const candidates: { project: Project; path: string; branch: string | null }[] = [];
  for (const project of projects) {
    for (const location of project.local_locations) {
      if (location.machine_id !== machineId) continue;
      candidates.push({ project, path: location.path, branch: location.branch ?? null });
    }
  }

  const entries: DirtyEntry[] = [];
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const batch = candidates.slice(offset, offset + concurrency);
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const repo = await readRepoFull(candidate.path, {
          changedFileLimit: 1,
          timeoutMs: 3_000,
        });
        return repo?.dirty ? candidate : null;
      }),
    );
    for (const result of results) {
      if (result) {
        entries.push({
          name: result.project.name,
          path: result.path,
          branch: result.branch,
        });
      }
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function countRemotes(
  workspace: Awaited<ReturnType<typeof openContext>>['workspace'],
): Promise<number> {
  return (await workspace.store.listRemotes()).length;
}
