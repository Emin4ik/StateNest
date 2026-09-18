import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { heading, print, printJson, style } from '../output.js';
import { buildResumeBrief, type ResumeBrief } from '../../core/context.js';
import { readRepoFull } from '../../git/repo.js';
import { relativeTime } from '../../util/time.js';
import { contractHome } from '../../util/paths.js';
import { pathExists } from '../../util/fs-atomic.js';
import type { Machine } from '../../core/schema.js';

export function resumeCommand(): Command {
  return new Command('resume')
    .description('Everything you need to pick a project back up')
    .argument('<project>', 'project name, alias or id')
    .option('--full', 'include the full text of recent checkpoints')
    .option('--checkpoints <n>', 'how many checkpoints to read', (v) => Number.parseInt(v, 10), 5)
    .option('--no-refresh', 'skip re-reading live git state')
    .action(async (term: string, options: ResumeOptions) => {
      const { workspace, registry } = await openContext();
      const project = await registry.resolveOrThrow(term);

      const brief = await buildResumeBrief(workspace.store, project, {
        machineId: workspace.machineId,
        checkpointLimit: options.checkpoints ?? 5,
      });

      const live = options.refresh ? await refreshLocalState(brief) : null;
      const machines = await workspace.store.listMachines();
      const machineById = new Map(machines.map((machine) => [machine.id, machine]));

      if (wantsJson()) {
        printJson(toJson(brief, live, machineById));
        return;
      }

      render(brief, live, machineById, Boolean(options.full));
    });
}

interface ResumeOptions {
  full?: boolean;
  checkpoints?: number;
  refresh: boolean;
}

interface LiveState {
  branch: string | null;
  shortSha: string | null;
  subject: string | null;
  dirty: boolean;
  changedCount: number;
  ahead: number | null;
  behind: number | null;
  pathMissing: boolean;
}

/**
 * Re-read git for the copy on this machine.
 *
 * The stored branch and commit are whatever they were at the last checkpoint,
 * which can be days old. Someone resuming a project needs to know what the
 * working tree looks like *now* - especially whether they left it dirty.
 */
async function refreshLocalState(brief: ResumeBrief): Promise<LiveState | null> {
  const location = brief.hereLocation;
  if (!location) return null;

  if (!(await pathExists(location.path))) {
    return {
      branch: location.branch ?? null,
      shortSha: null,
      subject: null,
      dirty: false,
      changedCount: 0,
      ahead: null,
      behind: null,
      pathMissing: true,
    };
  }

  const repo = await readRepoFull(location.path, { changedFileLimit: 10 });
  if (!repo) return null;

  return {
    branch: repo.branch,
    shortSha: repo.lastCommit?.shortSha ?? null,
    subject: repo.lastCommit?.subject ?? null,
    dirty: repo.dirty,
    changedCount: repo.stagedCount + repo.modifiedCount + repo.untrackedCount,
    ahead: repo.ahead,
    behind: repo.behind,
    pathMissing: false,
  };
}

function render(
  brief: ResumeBrief,
  live: LiveState | null,
  machineById: Map<string, Machine>,
  full: boolean,
): void {
  const { project } = brief;

  print('');
  heading(project.name);
  print(
    style.dim(
      [project.status, brief.lastActivityRelative, project.type !== 'unknown' ? project.type : '']
        .filter(Boolean)
        .join('  ·  '),
    ),
  );

  if (project.description) {
    print('');
    print(`  ${project.description}`);
  }

  // -- Where ---------------------------------------------------------------
  print('');
  if (brief.hereLocation) {
    const bits: string[] = [contractHome(brief.hereLocation.path)];
    if (live?.pathMissing) {
      bits.push(style.yellow('path no longer exists'));
    } else {
      const branch = live?.branch ?? brief.hereLocation.branch;
      if (branch) bits.push(style.cyan(branch));
      if (live?.shortSha) bits.push(style.dim(live.shortSha));
      if (live?.dirty) bits.push(style.yellow(`${live.changedCount} uncommitted`));
      if (live && live.behind) bits.push(style.yellow(`${live.behind} behind`));
      if (live && live.ahead) bits.push(`${live.ahead} ahead`);
    }
    print(labelled('Here', bits.join('  ·  ')));
  } else {
    print(labelled('Here', style.dim('not on this machine')));
  }

  for (const other of brief.otherLocations.slice(0, 3)) {
    const name = other.machine?.name ?? 'another machine';
    print(labelled('Also', `${style.dim(name)}  ${other.location.path}`));
  }

  if (project.repository?.web_url) {
    print(labelled('Repo', style.dim(project.repository.web_url)));
  } else if (project.repository) {
    print(labelled('Repo', style.dim(project.repository.identity)));
  }

  // -- The actual brief ----------------------------------------------------
  section('Current focus', brief.currentFocus ? [brief.currentFocus] : []);
  // The single most useful sentence in the whole brief when no explicit focus
  // has been set, and it was previously only visible behind --full.
  if (!brief.currentFocus && brief.lastSummary) {
    print('');
    print(`  ${style.bold('Last session')}`);
    print(`    ${brief.lastSummary}`);
  }
  section('Recently completed', brief.recentlyCompleted.slice(0, 5));
  section('Blockers', brief.blockers, style.yellow);
  numberedSection('Next', brief.nextActions.slice(0, 6));

  if (brief.keyDecisions.length > 0) {
    print('');
    print(`  ${style.bold('Decisions worth knowing')}`);
    for (const decision of brief.keyDecisions.slice(0, 4)) {
      print(`    ${style.dim('•')} ${decision.title} ${style.dim(`(${relativeTime(decision.timestamp)})`)}`);
    }
  }

  if (brief.deployments.length > 0) {
    print('');
    print(`  ${style.bold('Deployed')}`);
    for (const deployment of brief.deployments) {
      const host = deployment.remote?.ssh_alias ?? deployment.remote?.name ?? style.dim('unknown host');
      print(`    ${deployment.environment.padEnd(12)} ${host}${deployment.path ? `:${deployment.path}` : ''}`);
    }
  }

  // -- Checkpoints ---------------------------------------------------------
  if (brief.checkpoints.length > 0) {
    print('');
    if (full) {
      print(`  ${style.bold('Checkpoints')}`);
      for (const checkpoint of brief.checkpoints) {
        print('');
        print(`    ${style.dim(relativeTime(checkpoint.meta.timestamp))}  ${checkpoint.meta.branch ?? ''}`);
        for (const line of checkpoint.body.split('\n')) print(`    ${style.dim(line)}`);
      }
    } else {
      const last = brief.checkpoints[0]!;
      const count = brief.checkpoints.length;
      // "3 loaded" described the program's internals, not the user's
      // situation. Say what is there and how to read it.
      print(
        style.dim(
          count === 1
            ? `  One checkpoint, ${relativeTime(last.meta.timestamp)}. Read it with --full.`
            : `  ${count} checkpoints, most recent ${relativeTime(last.meta.timestamp)}. ` +
              `Read them with --full.`,
        ),
      );
    }
  } else {
    print('');
    print(style.dim('  No checkpoints yet. Run `pb checkpoint` after your next session.'));
  }

  print('');
}

function labelled(label: string, value: string): string {
  return `  ${style.dim(label.padEnd(6))} ${value}`;
}

function section(title: string, items: readonly string[], paint = (text: string) => text): void {
  if (items.length === 0) return;
  print('');
  print(`  ${style.bold(title)}`);
  for (const item of items) print(`    ${style.dim('•')} ${paint(item)}`);
}

function numberedSection(title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  print('');
  print(`  ${style.bold(title)}`);
  items.forEach((item, index) => print(`    ${style.dim(`${index + 1}.`)} ${item}`));
}

function toJson(
  brief: ResumeBrief,
  live: LiveState | null,
  machineById: Map<string, Machine>,
): Record<string, unknown> {
  return {
    project: {
      id: brief.project.id,
      name: brief.project.name,
      description: brief.project.description ?? null,
      status: brief.project.status,
      type: brief.project.type,
      repository: brief.project.repository ?? null,
    },
    last_activity_at: brief.lastActivityAt,
    current_focus: brief.currentFocus,
    recently_completed: brief.recentlyCompleted,
    blockers: brief.blockers,
    next_actions: brief.nextActions,
    open_tasks: brief.openTasks,
    decisions: brief.keyDecisions,
    here: brief.hereLocation
      ? { ...brief.hereLocation, live }
      : null,
    other_locations: brief.otherLocations.map((entry) => ({
      ...entry.location,
      machine: machineById.get(entry.location.machine_id)?.name ?? null,
    })),
    deployments: brief.deployments,
    checkpoints: brief.checkpoints.map((checkpoint) => ({
      ...checkpoint.meta,
      summary: checkpoint.summary,
      completed: checkpoint.completed,
      blockers: checkpoint.blockers,
      next: checkpoint.next,
    })),
  };
}
