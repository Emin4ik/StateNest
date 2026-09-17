import { homedir } from 'node:os';
import { join } from 'node:path';
import { datePathSegments, timeFilePrefix, type Timestamp } from '../util/time.js';
import { safeDirName } from '../util/ids.js';
import { resolveUserPath } from '../util/paths.js';

export const DEFAULT_HOME_DIR_NAME = '.project-brain';
export const HOME_ENV_VAR = 'PROJECT_BRAIN_HOME';

/**
 * Where Project Brain keeps everything.
 *
 * The layout separates what may be synced from what must never be:
 *
 *   ~/.project-brain/
 *     config.yaml          global settings
 *     machine.json         THIS computer's id - outside every profile, so it
 *                          can never end up in a data repository
 *     profiles/
 *       personal/          <- a self-contained, independently syncable unit
 *         profile.yaml
 *         projects/<id>/{project.yaml,state.md,tasks.yaml,decisions.md}
 *         machines/<id>.yaml
 *         remotes/<id>.yaml
 *         checkpoints/<project-id>/YYYY/MM/DD/HHMMSS_<id>.md
 *       work/              <- a different profile, a different git remote
 *     cache/               derived, disposable, never synced
 *     logs/                never synced
 *     backups/             never synced
 *
 * Making each profile its own directory subtree is what turns "a work project
 * must never sync to a personal repository" from a rule the code has to
 * remember into a structural property: sync operates on one profile directory,
 * and a different profile's files are simply not inside it.
 */
export interface BrainPaths {
  readonly home: string;
  readonly configFile: string;
  readonly machineIdentityFile: string;
  readonly profilesDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly logFile: string;
  readonly backupsDir: string;
  profile(name: string): ProfilePaths;
  cacheFor(profileName: string): string;
}

export interface ProfilePaths {
  readonly name: string;
  /** The directory a data repository is initialised in. Sync never leaves it. */
  readonly root: string;
  readonly profileFile: string;
  readonly projectsDir: string;
  readonly machinesDir: string;
  readonly remotesDir: string;
  readonly checkpointsDir: string;
  projectDir(projectId: string): string;
  projectFile(projectId: string): string;
  stateFile(projectId: string): string;
  tasksFile(projectId: string): string;
  decisionsFile(projectId: string): string;
  machineFile(machineId: string): string;
  remoteFile(remoteId: string): string;
  checkpointDir(projectId: string): string;
  checkpointFile(projectId: string, timestamp: Timestamp, checkpointId: string): string;
}

export function resolveBrainHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env[HOME_ENV_VAR];
  if (override && override.trim() !== '') {
    return resolveUserPath(override.trim(), process.cwd(), home);
  }
  return join(home, DEFAULT_HOME_DIR_NAME);
}

export function createPaths(homeOverride?: string, env: NodeJS.ProcessEnv = process.env): BrainPaths {
  const home = homeOverride ?? resolveBrainHome(env);
  const profilesDir = join(home, 'profiles');
  const cacheDir = join(home, 'cache');
  const logsDir = join(home, 'logs');

  return {
    home,
    configFile: join(home, 'config.yaml'),
    machineIdentityFile: join(home, 'machine.json'),
    profilesDir,
    cacheDir,
    logsDir,
    logFile: join(logsDir, 'project-brain.log'),
    backupsDir: join(home, 'backups'),
    cacheFor: (profileName: string) => join(cacheDir, sanitizeProfileName(profileName)),
    profile: (name: string) => createProfilePaths(profilesDir, name),
  };
}

export function createProfilePaths(profilesDir: string, name: string): ProfilePaths {
  const safeName = sanitizeProfileName(name);
  const root = join(profilesDir, safeName);
  const projectsDir = join(root, 'projects');
  const checkpointsDir = join(root, 'checkpoints');
  const machinesDir = join(root, 'machines');
  const remotesDir = join(root, 'remotes');

  const projectDir = (projectId: string) => join(projectsDir, sanitizeIdForPath(projectId));

  return {
    name: safeName,
    root,
    profileFile: join(root, 'profile.yaml'),
    projectsDir,
    machinesDir,
    remotesDir,
    checkpointsDir,
    projectDir,
    projectFile: (id) => join(projectDir(id), 'project.yaml'),
    stateFile: (id) => join(projectDir(id), 'state.md'),
    tasksFile: (id) => join(projectDir(id), 'tasks.yaml'),
    decisionsFile: (id) => join(projectDir(id), 'decisions.md'),
    machineFile: (id) => join(machinesDir, `${sanitizeIdForPath(id)}.yaml`),
    remoteFile: (id) => join(remotesDir, `${sanitizeIdForPath(id)}.yaml`),
    checkpointDir: (id) => join(checkpointsDir, sanitizeIdForPath(id)),
    checkpointFile: (projectId, timestamp, checkpointId) => {
      const [year, month, day] = datePathSegments(timestamp);
      return join(
        checkpointsDir,
        sanitizeIdForPath(projectId),
        year,
        month,
        day,
        `${timeFilePrefix(timestamp)}_${sanitizeIdForPath(checkpointId)}.md`,
      );
    },
  };
}

export function sanitizeProfileName(name: string): string {
  return safeDirName(name, 32);
}

/**
 * Ids are generated from a fixed alphabet, but a hand-edited or imported file
 * could carry anything. Refuse to let an id become a path traversal.
 */
export function sanitizeIdForPath(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '_');
  return cleaned === '' ? '_' : cleaned.slice(0, 96);
}
