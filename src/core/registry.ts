import { basename } from 'node:path';
import type { Store } from '../storage/store.js';
import {
  ProjectSchema,
  SCHEMA_VERSION,
  type Project,
  type ProjectLocation,
} from './schema.js';
import { deterministicId, randomId } from '../util/ids.js';
import { now, type Timestamp } from '../util/time.js';
import { pathKey, resolveRealPath } from '../util/paths.js';
import { findRepoRoot, readRepoFast, type FastRepoInfo } from '../git/repo.js';
import { detectProjectMetadata, suggestProjectName } from '../discovery/detect.js';
import { resolveProject, type Resolution } from './resolve.js';
import { BrainError } from '../util/errors.js';
import { normalizeRemoteUrl } from '../git/remote-url.js';

/**
 * Derive a project's id.
 *
 * For a repository with a real remote, the id is a hash of the normalized
 * remote identity. Two machines that have never communicated therefore compute
 * the same id for the same repository, which is what allows a synced data
 * directory to merge cleanly instead of accumulating duplicate projects.
 *
 * Without a usable remote there is nothing stable to hash - a local path means
 * different things on different machines - so a random id is minted once and
 * travels with the data.
 */
export function deriveProjectId(repo: FastRepoInfo | null): string {
  const remote = repo?.primaryRemote;
  if (remote && remote.stableAcrossMachines) {
    return deterministicId('prj', remote.identity);
  }
  return randomId('prj', 10);
}

/** The id a given remote URL would produce. Used by tests and by `pb add`. */
export function projectIdForRemote(remoteUrl: string): string | null {
  const normalized = normalizeRemoteUrl(remoteUrl);
  if (!normalized || !normalized.stableAcrossMachines) return null;
  return deterministicId('prj', normalized.identity);
}

export interface RegisterOptions {
  machineId: string;
  /** Override the generated display name. */
  name?: string;
  /** Skip reading manifests and README. */
  skipDetection?: boolean;
  tags?: string[];
}

export interface RegisterResult {
  project: Project;
  /** What actually happened, so the CLI can say so honestly. */
  outcome: 'created' | 'location-added' | 'location-updated';
  repo: FastRepoInfo | null;
}

/**
 * The project registry for one profile.
 *
 * Projects are loaded once per instance and cached: a single `pb` invocation
 * reads each project file at most once, which keeps the Claude Code
 * SessionStart path to a handful of milliseconds even with hundreds of
 * projects registered.
 */
export class Registry {
  private cache: Project[] | null = null;

  constructor(private readonly store: Store) {}

  async all(): Promise<Project[]> {
    if (this.cache === null) this.cache = await this.store.listProjects();
    return this.cache;
  }

  /** Forget the cached list, after a write by someone else. */
  invalidate(): void {
    this.cache = null;
  }

  async byId(projectId: string): Promise<Project | null> {
    const cached = this.cache?.find((project) => project.id === projectId);
    if (cached) return cached;
    return this.store.getProject(projectId);
  }

  async byRepositoryIdentity(identity: string): Promise<Project | null> {
    const projects = await this.all();
    return projects.find((project) => project.repository?.identity === identity) ?? null;
  }

  /** The project registered at this path on this machine, if any. */
  async byLocation(path: string, machineId: string): Promise<Project | null> {
    const key = pathKey(await resolveRealPath(path));
    const projects = await this.all();
    return (
      projects.find((project) =>
        project.local_locations.some(
          (location) => location.machine_id === machineId && pathKey(location.path) === key,
        ),
      ) ?? null
    );
  }

  async resolve(term: string): Promise<Resolution> {
    return resolveProject(await this.all(), term);
  }

  /**
   * Resolve a term to exactly one project, or throw an error the CLI can print
   * verbatim. Ambiguity is always reported, never guessed at.
   */
  async resolveOrThrow(term: string): Promise<Project> {
    const resolution = await this.resolve(term);
    if (resolution.status === 'found') return resolution.project;

    if (resolution.status === 'ambiguous') {
      throw new BrainError('AMBIGUOUS_PROJECT', `"${term}" matches more than one project.`, {
        details: resolution.matches
          .slice(0, 8)
          .map((match, index) => `${index + 1}. ${match.project.name}`),
        hints: ['Use a longer or more specific name.'],
      });
    }

    throw new BrainError('UNKNOWN_PROJECT', `No project matches "${term}".`, {
      hints: ['pb projects', 'pb add .'],
    });
  }

  /**
   * Identify the project for a working directory.
   *
   * Tries the git remote first, because that is the identity that survives
   * being cloned somewhere else, and falls back to a previously-recorded path
   * for repositories with no remote.
   */
  async identify(
    directory: string,
    machineId: string,
  ): Promise<{ project: Project | null; repo: FastRepoInfo | null; repoRoot: string | null }> {
    const repoRoot = await findRepoRoot(directory);
    const repo = repoRoot ? await readRepoFast(repoRoot) : null;

    if (repo?.primaryRemote?.stableAcrossMachines) {
      // Fast path. Because a project's id is a deterministic hash of its remote
      // identity, the file can be addressed directly - one read instead of
      // loading every project in the registry. This is what keeps the Claude
      // Code SessionStart hook cheap for a user with hundreds of projects.
      const direct = await this.byId(deriveProjectId(repo));
      if (direct?.repository?.identity === repo.primaryRemote.identity) {
        return { project: direct, repo, repoRoot };
      }

      // Miss: the project may predate its remote and carry a random id, so
      // fall back to a full scan before concluding it is unregistered.
      const byIdentity = await this.byRepositoryIdentity(repo.primaryRemote.identity);
      if (byIdentity) return { project: byIdentity, repo, repoRoot };
    }

    // A linked worktree is another view of the same project, so match on the
    // main working tree's path as well as this one's. Paths are resolved
    // through symlinks first, so `/tmp/x` and `/private/tmp/x` are one place.
    const searchPaths = [await resolveRealPath(repoRoot ?? directory)];
    if (repo?.worktreeOf) searchPaths.push(await resolveRealPath(repo.worktreeOf));

    for (const path of searchPaths) {
      const byPath = await this.byLocation(path, machineId);
      if (byPath) return { project: byPath, repo, repoRoot };
    }

    return { project: null, repo, repoRoot };
  }

  /**
   * Register a directory, or record it as another location of a project that
   * is already known.
   *
   * This is what makes the same project on a MacBook and a workstation one
   * project with two locations rather than two unrelated entries.
   */
  async register(directory: string, options: RegisterOptions): Promise<RegisterResult> {
    const { project: existing, repo, repoRoot } = await this.identify(directory, options.machineId);
    // Store the resolved path, so the same directory reached through a symlink
    // is recognised as the location it already is.
    const root = await resolveRealPath(repoRoot ?? directory);
    const timestamp = now();

    if (existing) {
      const updated = upsertLocation(existing, buildLocation(root, repo, options.machineId, timestamp));
      const outcome =
        updated.local_locations.length === existing.local_locations.length
          ? 'location-updated'
          : 'location-added';
      const saved = await this.save({ ...updated, last_activity_at: mostRecent(existing.last_activity_at, repo?.lastRefActivityAt) });
      return { project: saved, outcome, repo };
    }

    const detected = options.skipDetection
      ? { type: 'unknown' as const, description: null, declaredName: null, readFiles: [] }
      : await detectProjectMetadata(root);

    const candidate = ProjectSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: deriveProjectId(repo),
      name: options.name ?? suggestProjectName(root, detected.declaredName),
      ...(detected.description ? { description: detected.description } : {}),
      aliases: aliasesFor(root, repo),
      type: detected.type,
      status: 'active',
      tags: options.tags ?? [],
      created_at: timestamp,
      discovered_at: timestamp,
      last_activity_at: repo?.lastRefActivityAt ?? timestamp,
      repository: repo?.primaryRemote
        ? {
            identity: repo.primaryRemote.identity,
            url: repo.primaryRemote.sanitized,
            host: repo.primaryRemote.host,
            path: repo.primaryRemote.path,
            owner: repo.primaryRemote.owner,
            name: repo.primaryRemote.name,
            web_url: repo.primaryRemote.webUrl,
            ...(repo.branch ? { default_branch: repo.branch } : {}),
          }
        : null,
      local_locations: [buildLocation(root, repo, options.machineId, timestamp)],
      deployments: [],
      blockers: [],
    });

    const saved = await this.save(candidate);
    return { project: saved, outcome: 'created', repo };
  }

  async save(project: Project): Promise<Project> {
    const saved = await this.store.saveProject(project);
    if (this.cache) {
      const index = this.cache.findIndex((entry) => entry.id === saved.id);
      if (index >= 0) this.cache[index] = saved;
      else this.cache.push(saved);
    }
    return saved;
  }

  /**
   * Record that work happened in a project, without touching anything else.
   *
   * Called from the Claude Code hooks, so it stays a single read-modify-write
   * of one small file.
   */
  async touchActivity(
    projectId: string,
    machineId: string,
    path: string,
    repo: FastRepoInfo | null,
  ): Promise<Project | null> {
    const project = await this.byId(projectId);
    if (!project) return null;
    const timestamp = now();
    const resolved = await resolveRealPath(path);
    const updated = upsertLocation(project, buildLocation(resolved, repo, machineId, timestamp));
    return this.save({ ...updated, last_activity_at: timestamp });
  }
}

function buildLocation(
  path: string,
  repo: FastRepoInfo | null,
  machineId: string,
  timestamp: Timestamp,
): ProjectLocation {
  return {
    machine_id: machineId,
    path,
    is_worktree: repo?.isWorktree ?? false,
    worktree_of: repo?.worktreeOf ?? null,
    branch: repo?.branch ?? null,
    head: repo?.head ?? null,
    dirty: null,
    last_seen_at: timestamp,
    missing_since: null,
  };
}

/**
 * Add or refresh a location, matching on machine + path.
 *
 * Two worktrees of one repository are two locations on the same machine, which
 * is why the key is the pair and not the machine alone.
 */
export function upsertLocation(project: Project, location: ProjectLocation): Project {
  const key = pathKey(location.path);
  const locations = [...project.local_locations];
  const index = locations.findIndex(
    (existing) => existing.machine_id === location.machine_id && pathKey(existing.path) === key,
  );

  if (index >= 0) {
    // Keep fields the caller had no opinion about, such as a dirty flag set by
    // a slower full read.
    locations[index] = { ...locations[index], ...location };
  } else {
    locations.push(location);
  }

  return { ...project, local_locations: locations };
}

function aliasesFor(root: string, repo: FastRepoInfo | null): string[] {
  const aliases = new Set<string>();
  const dirName = basename(root);
  if (dirName) aliases.add(dirName.toLowerCase());
  const repoName = repo?.primaryRemote?.name;
  if (repoName) aliases.add(repoName.toLowerCase());
  return [...aliases];
}

function mostRecent(...values: (Timestamp | null | undefined)[]): Timestamp | null {
  let best: Timestamp | null = null;
  for (const value of values) {
    if (!value) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}
