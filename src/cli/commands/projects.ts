import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import {
  bullet,
  heading,
  print,
  printJson,
  pluralize,
  renderTable,
  statusColor,
  style,
  type Column,
} from '../output.js';
import { latest } from '../../core/context.js';
import { relativeTime } from '../../util/time.js';
import { contractHome } from '../../util/paths.js';
import type { Project } from '../../core/schema.js';

export function projectsCommand(): Command {
  return new Command('projects')
    .alias('ls')
    .description('List every project Project Brain knows about')
    .option('--active', 'only projects with status "active"')
    .option('--paused', 'only projects with status "paused"')
    .option('--archived', 'only projects with status "archived"')
    .option('--stale [days]', 'only projects untouched for this many days', '30')
    .option('--dirty', 'only projects with uncommitted local changes')
    .option('--deployed', 'only projects with a registered deployment')
    .option('--tag <tag>', 'only projects carrying this tag', collect, [])
    .option('--type <type>', 'only projects of this ecosystem')
    .option('--all', 'include archived projects (excluded by default)')
    .option('--sort <field>', 'name | activity | status', 'activity')
    .action(async (options: ProjectFilters, command: Command) => {
      const { workspace, registry } = await openContext();
      const all = await registry.all();
      const machines = await workspace.store.listMachines();
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));

      // `--stale` carries a default so `pb projects --stale` works without an
      // argument, which means its presence must be read from the option source
      // rather than its value - otherwise every listing filters by staleness.
      const staleRequested = command.getOptionValueSource('stale') === 'cli';
      const filtered = filterProjects(all, { ...options, staleRequested }, workspace.machineId);
      const sorted = sortProjects(filtered, options.sort ?? 'activity');

      if (wantsJson()) {
        printJson({
          profile: workspace.profile.name,
          count: sorted.length,
          projects: sorted.map((project) => toJson(project, workspace.machineId, machineNames)),
        });
        return;
      }

      if (sorted.length === 0) {
        printEmptyState(all.length, options);
        return;
      }

      print(renderTable(sorted, projectColumns(workspace.machineId, machineNames)));
      print('');
      print(style.dim(summaryLine(all, sorted, workspace.profile.name)));
    });
}

interface ProjectFilters {
  active?: boolean;
  paused?: boolean;
  archived?: boolean;
  stale?: string | boolean;
  dirty?: boolean;
  deployed?: boolean;
  tag?: string[];
  type?: string;
  all?: boolean;
  sort?: string;
  /** Set by the caller from commander's option source, not by commander. */
  staleRequested?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function filterProjects(
  projects: readonly Project[],
  options: ProjectFilters,
  machineId: string,
): Project[] {
  const statusFilters = new Set<string>();
  if (options.active) statusFilters.add('active');
  if (options.paused) statusFilters.add('paused');
  if (options.archived) statusFilters.add('archived');

  const staleDays = options.staleRequested
    ? Number.parseInt(typeof options.stale === 'string' ? options.stale : '30', 10)
    : null;

  return projects.filter((project) => {
    if (statusFilters.size > 0 && !statusFilters.has(project.status)) return false;

    // Archived projects are noise in a default listing but must never vanish:
    // `--all` or `--archived` brings them back.
    if (!options.all && statusFilters.size === 0 && project.status === 'archived') return false;

    if (options.type && project.type !== options.type) return false;
    if (options.tag && options.tag.length > 0) {
      if (!options.tag.every((tag) => project.tags.includes(tag))) return false;
    }
    if (options.deployed && project.deployments.length === 0) return false;

    if (options.dirty) {
      const here = project.local_locations.filter(
        (location) => location.machine_id === machineId,
      );
      if (!here.some((location) => location.dirty === true)) return false;
    }

    if (staleDays !== null && Number.isFinite(staleDays)) {
      const activity = effectiveActivity(project);
      if (!activity) return true;
      const days = (Date.now() - new Date(activity).getTime()) / 86_400_000;
      if (days < staleDays) return false;
    }

    return true;
  });
}

export function sortProjects(projects: readonly Project[], sort: string): Project[] {
  const copy = [...projects];
  switch (sort) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'status':
      return copy.sort(
        (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
      );
    default:
      return copy.sort((a, b) => {
        const left = effectiveActivity(a) ?? '';
        const right = effectiveActivity(b) ?? '';
        return right.localeCompare(left) || a.name.localeCompare(b.name);
      });
  }
}

export function effectiveActivity(project: Project): string | null {
  return latest(
    project.last_activity_at,
    project.last_checkpoint_at,
    ...project.local_locations.map((location) => location.last_seen_at),
  );
}

function projectColumns(
  machineId: string,
  machineNames: Map<string, string>,
): Column<Project>[] {
  return [
    {
      header: 'project',
      value: (project) => project.name,
      maxWidth: 32,
      paint: (text) => style.bold(text),
    },
    {
      header: 'status',
      value: (project) => project.status,
      paint: (text) => statusColor(text.trimEnd()) + ' '.repeat(text.length - text.trimEnd().length),
    },
    {
      header: 'last active',
      value: (project) => relativeTime(effectiveActivity(project)),
    },
    {
      header: 'where',
      value: (project) => describeWhere(project, machineId, machineNames),
      optional: true,
      maxWidth: 28,
    },
    {
      header: 'next',
      value: (project) => project.current_focus ?? '',
      optional: true,
      maxWidth: 40,
      paint: (text) => style.dim(text),
    },
  ];
}

/**
 * Where a project lives, in one short phrase.
 *
 * "local + 2 machines + prod" is more useful at a glance than a list of paths,
 * which `pb where` shows in full when the user actually wants them.
 */
export function describeWhere(
  project: Project,
  machineId: string,
  machineNames: Map<string, string>,
): string {
  const parts: string[] = [];
  const here = project.local_locations.some((location) => location.machine_id === machineId);
  const otherMachines = new Set(
    project.local_locations
      .filter((location) => location.machine_id !== machineId)
      .map((location) => location.machine_id),
  );

  if (here) parts.push('local');
  if (otherMachines.size === 1) {
    const [only] = [...otherMachines];
    parts.push(machineNames.get(only!) ?? 'another machine');
  } else if (otherMachines.size > 1) {
    parts.push(`${otherMachines.size} machines`);
  }

  const environments = new Set(project.deployments.map((deployment) => deployment.environment));
  if (environments.has('production')) parts.push('prod');
  else if (environments.size > 0) parts.push([...environments][0]!);

  return parts.join(' + ') || style.dim('unknown');
}

function toJson(
  project: Project,
  machineId: string,
  machineNames: Map<string, string>,
): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    status: project.status,
    type: project.type,
    tags: project.tags,
    last_activity_at: effectiveActivity(project),
    current_focus: project.current_focus ?? null,
    repository: project.repository ?? null,
    where: describeWhere(project, machineId, machineNames),
    locations: project.local_locations.map((location) => ({
      machine_id: location.machine_id,
      machine: machineNames.get(location.machine_id) ?? null,
      path: location.path,
      branch: location.branch,
      dirty: location.dirty,
    })),
    deployments: project.deployments,
    blockers: project.blockers,
  };
}

function summaryLine(all: readonly Project[], shown: readonly Project[], profile: string): string {
  const parts = [`${pluralize(shown.length, 'project')} shown`];
  if (shown.length !== all.length) parts.push(`${all.length} total`);
  parts.push(`profile: ${profile}`);
  return parts.join(' · ');
}

function printEmptyState(totalKnown: number, options: ProjectFilters): void {
  if (totalKnown === 0) {
    heading('No projects registered yet.');
    print('');
    print('Project Brain finds projects by scanning directories you name:');
    print('');
    print(bullet(style.cyan('pb scan ~/Projects ~/Work')));
    print(bullet(style.cyan('pb add .') + style.dim('   (register the current directory)')));
    return;
  }

  const hasFilter = Boolean(
    options.active || options.paused || options.archived || options.dirty || options.deployed || options.type || (options.tag?.length ?? 0) > 0,
  );
  print(
    hasFilter
      ? `No projects match that filter. ${totalKnown} project(s) are registered.`
      : `No projects to show. ${totalKnown} project(s) are registered.`,
  );
  if (!options.all) print(style.dim('Archived projects are hidden. Use --all to include them.'));
}

export { contractHome };
