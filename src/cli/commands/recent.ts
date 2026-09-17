import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { heading, print, printJson, style } from '../output.js';
import { buildRecent, type RecentEntry } from '../../core/context.js';
import { activityBucket, relativeTime } from '../../util/time.js';

/**
 * `pb recent` is the command that makes the whole tool worth installing.
 *
 * It answers "what have I been doing?" in one screen, grouped the way people
 * actually think about time - today, yesterday, last week - rather than as a
 * list of timestamps.
 */
export function recentCommand(): Command {
  return new Command('recent')
    .description('What you have been working on, newest first')
    .option('-n, --limit <n>', 'how many entries to show', (v) => Number.parseInt(v, 10), 15)
    .option('--days <n>', 'only the last N days', (v) => Number.parseInt(v, 10))
    .option('--all', 'include archived projects')
    .action(async (options: RecentOptions) => {
      const { workspace, registry } = await openContext();
      const projects = (await registry.all()).filter(
        (project) => options.all || project.status !== 'archived',
      );

      const since =
        options.days && Number.isFinite(options.days)
          ? new Date(Date.now() - options.days * 86_400_000).toISOString().slice(0, 19) + 'Z'
          : undefined;

      const entries = await buildRecent(workspace.store, projects, {
        limit: options.limit ?? 15,
        ...(since ? { since } : {}),
      });

      if (wantsJson()) {
        printJson({
          count: entries.length,
          entries: entries.map(toJson),
        });
        return;
      }

      if (entries.length === 0) {
        printEmpty(projects.length, options);
        return;
      }

      render(entries);
    });
}

interface RecentOptions {
  limit?: number;
  days?: number;
  all?: boolean;
}

function render(entries: readonly RecentEntry[]): void {
  let currentBucket: string | null = null;

  print('');
  for (const entry of entries) {
    const bucket = activityBucket(entry.timestamp);
    if (bucket !== currentBucket) {
      if (currentBucket !== null) print('');
      heading(bucket);
      currentBucket = bucket;
    }

    const branch = entry.checkpoint?.meta.branch;
    const suffix = branch ? style.dim(`  ${branch}`) : '';
    print(`  ${style.bold(entry.project.name)}${suffix}`);
    print(`    ${entry.summary}`);

    // Anything still open is more useful than more history.
    const next = entry.checkpoint?.next?.[0];
    if (next) print(`    ${style.dim(`next: ${next}`)}`);
    const blocker = entry.checkpoint?.blockers?.[0];
    if (blocker) print(`    ${style.yellow(`blocked: ${blocker}`)}`);
  }

  print('');
  print(style.dim('pb resume <project> to pick one back up'));
  print('');
}

function printEmpty(projectCount: number, options: RecentOptions): void {
  print('');
  if (projectCount === 0) {
    heading('Nothing recorded yet.');
    print('');
    print(`  ${style.cyan('pb scan ~/Projects')}   find your projects`);
    print('');
    return;
  }

  print(
    options.days
      ? `No activity in the last ${options.days} days across ${projectCount} projects.`
      : `No activity recorded yet across ${projectCount} projects.`,
  );
  print('');
  print(style.dim('Activity appears here once you work in a project with Claude Code,'));
  print(style.dim('or when you run `pb checkpoint` yourself.'));
  print('');
}

function toJson(entry: RecentEntry): Record<string, unknown> {
  return {
    project_id: entry.project.id,
    project: entry.project.name,
    timestamp: entry.timestamp,
    relative: relativeTime(entry.timestamp),
    bucket: activityBucket(entry.timestamp),
    summary: entry.summary,
    source: entry.source,
    branch: entry.checkpoint?.meta.branch ?? null,
    completed: entry.checkpoint?.completed ?? [],
    blockers: entry.checkpoint?.blockers ?? [],
    next: entry.checkpoint?.next ?? [],
  };
}
