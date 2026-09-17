import { readFile } from 'node:fs/promises';
import {
  ConfigSchema,
  LocalMachineIdentitySchema,
  ProfileSchema,
  SCHEMA_VERSION,
  type Config,
  type LocalMachineIdentity,
  type Machine,
  type Profile,
} from './schema.js';
import { createPaths, type BrainPaths, type ProfilePaths } from './paths.js';
import { Store } from '../storage/store.js';
import { readYamlFile, writeYamlFile } from '../storage/yaml-file.js';
import { ensureDir, pathExists, readFileOrNull, writeFileAtomic } from '../util/fs-atomic.js';
import { BrainError } from '../util/errors.js';
import { contractHome } from '../util/paths.js';
import { describeThisMachine, newMachineId, suggestMachineName } from '../machines/identity.js';
import { now } from '../util/time.js';

export const PROFILE_ENV_VAR = 'PROJECT_BRAIN_PROFILE';

export interface OpenOptions {
  /** Override the Project Brain home. Used by tests and by `--home`. */
  home?: string;
  /** Override the active profile. Used by `--profile`. */
  profile?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * An opened Project Brain home, bound to one active profile.
 *
 * Everything the rest of the code needs hangs off this: the resolved paths,
 * the config, the active profile, a store scoped to that profile, and this
 * machine's id. Nothing reaches outside the active profile's directory, which
 * is what keeps a work project from ever being written into personal data.
 */
export class Workspace {
  private constructor(
    readonly paths: BrainPaths,
    readonly config: Config,
    readonly profile: Profile,
    readonly store: Store,
    readonly machineId: string,
  ) {}

  get profilePaths(): ProfilePaths {
    return this.store.paths;
  }

  /** Open an existing home, or fail with instructions to create one. */
  static async open(options: OpenOptions = {}): Promise<Workspace> {
    const env = options.env ?? process.env;
    const paths = createPaths(options.home, env);

    if (!(await pathExists(paths.configFile))) {
      throw new BrainError('NOT_INITIALIZED', 'Project Brain is not set up on this machine yet.', {
        details: [`Expected to find ${contractHome(paths.configFile)}`],
        hints: ['pb init'],
      });
    }

    const config = await readConfig(paths);
    const profileName = resolveProfileName(config, options, env);
    const profilePaths = paths.profile(profileName);
    const store = new Store(profilePaths);

    const profile = await store.readProfile();
    if (!profile) {
      const available = await listProfileNames(paths);
      throw new BrainError('UNKNOWN_PROFILE', `No profile named "${profileName}".`, {
        details:
          available.length > 0
            ? [`Available profiles: ${available.join(', ')}`]
            : ['No profiles exist yet.'],
        hints: ['pb profile list', `pb profile create ${profileName}`],
      });
    }

    const machineId = await readOrCreateMachineId(paths);
    return new Workspace(paths, config, profile, store, machineId);
  }

  /**
   * Create the home directory and a first profile.
   *
   * Safe to call on an already-initialised home: existing config and profiles
   * are read rather than overwritten, so `pb init` can be re-run to add a
   * profile or repair a partially-created layout without losing anything.
   */
  static async initialize(
    options: OpenOptions & { profileName?: string; projectRoots?: string[] } = {},
  ): Promise<Workspace> {
    const env = options.env ?? process.env;
    const paths = createPaths(options.home, env);
    const profileName = options.profileName ?? options.profile ?? 'personal';

    await Promise.all([
      ensureDir(paths.home),
      ensureDir(paths.profilesDir),
      ensureDir(paths.cacheDir),
      ensureDir(paths.logsDir),
    ]);

    const existingConfig = await readYamlFile(paths.configFile, ConfigSchema);
    const config =
      existingConfig.value ??
      (await writeYamlFile(paths.configFile, ConfigSchema, {
        schema_version: SCHEMA_VERSION,
        default_profile: profileName,
      }));

    const profilePaths = paths.profile(profileName);
    const store = new Store(profilePaths);
    await store.ensureLayout();

    let profile = await store.readProfile();
    if (!profile) {
      profile = await store.writeProfile(
        ProfileSchema.parse({
          schema_version: SCHEMA_VERSION,
          name: profilePaths.name,
          project_roots: options.projectRoots ?? [],
          created_at: now(),
        }),
      );
      await writeDataRepoScaffolding(profilePaths);
    }

    const machineId = await readOrCreateMachineId(paths);
    const workspace = new Workspace(paths, config, profile, store, machineId);
    await workspace.touchMachine();
    return workspace;
  }

  /**
   * Record that this machine is alive, creating its record on first contact
   * with this profile.
   *
   * `first_seen_at` is preserved across calls; everything else is refreshed, so
   * an OS upgrade or a hostname change is picked up without losing history.
   */
  async touchMachine(name?: string): Promise<Machine> {
    const existing = await this.store.getMachine(this.machineId);
    const machine = describeThisMachine(this.machineId, {
      ...(name ?? existing?.name ? { name: name ?? existing!.name } : {}),
      ...(existing?.first_seen_at ? { firstSeenAt: existing.first_seen_at } : {}),
      ...(existing?.type ? { type: existing.type } : {}),
    });
    // Preserve any fields a user hand-edited or a newer version wrote.
    return this.store.saveMachine({ ...existing, ...machine });
  }

  /** This machine's record in the active profile, if it has one yet. */
  async currentMachine(): Promise<Machine | null> {
    return this.store.getMachine(this.machineId);
  }

  async saveConfig(config: Config): Promise<Config> {
    return writeYamlFile(this.paths.configFile, ConfigSchema, config);
  }

  async saveProfile(profile: Profile): Promise<Profile> {
    return this.store.writeProfile(profile);
  }

  /** A store for a *different* profile. Used only by explicitly cross-profile commands. */
  storeFor(profileName: string): Store {
    return new Store(this.paths.profile(profileName));
  }
}

export async function readConfig(paths: BrainPaths): Promise<Config> {
  const { value, issue } = await readYamlFile(paths.configFile, ConfigSchema);
  if (issue) {
    throw new BrainError('CORRUPT_CONFIG', `Could not read ${contractHome(paths.configFile)}`, {
      details: [issue.reason],
      hints: [
        'Fix the file by hand, or move it aside and run: pb init',
        'Your projects and checkpoints are stored separately and are not affected.',
      ],
    });
  }
  return value ?? ConfigSchema.parse({});
}

export function resolveProfileName(
  config: Config,
  options: OpenOptions,
  env: NodeJS.ProcessEnv,
): string {
  const explicit = options.profile?.trim();
  if (explicit) return explicit;
  const fromEnv = env[PROFILE_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  return config.default_profile;
}

export async function listProfileNames(paths: BrainPaths): Promise<string[]> {
  const { listDirectories } = await import('../storage/store.js');
  const dirs = await listDirectories(paths.profilesDir);
  const found: string[] = [];
  for (const dir of dirs) {
    if (await pathExists(paths.profile(dir).profileFile)) found.push(dir);
  }
  return found.sort();
}

/**
 * This machine's id, generated exactly once and then reused forever.
 *
 * Stored at the top level of the home directory rather than inside a profile,
 * so it is structurally outside anything sync can reach: a data repository
 * cloned to a second machine must not tell that machine it is the first one.
 */
export async function readOrCreateMachineId(paths: BrainPaths): Promise<string> {
  const raw = await readFileOrNull(paths.machineIdentityFile);
  if (raw !== null) {
    try {
      const parsed = LocalMachineIdentitySchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data.machine_id;
    } catch {
      // Fall through and regenerate: a machine id is cheap to recreate, and
      // refusing to start because of one unreadable file would be worse.
    }
  }

  const identity: LocalMachineIdentity = {
    schema_version: SCHEMA_VERSION,
    machine_id: newMachineId(),
    created_at: now(),
  };
  await writeFileAtomic(paths.machineIdentityFile, `${JSON.stringify(identity, null, 2)}\n`);
  return identity.machine_id;
}

/**
 * Files that make a profile directory behave well as a git repository.
 *
 * `.gitattributes` is the important one: decisions.md and state.md are
 * append-or-replace documents that two machines can legitimately write
 * independently, and `merge=union` resolves that by keeping both sides
 * instead of producing a conflict the user has to hand-edit.
 */
export async function writeDataRepoScaffolding(profilePaths: ProfilePaths): Promise<void> {
  const gitattributes = [
    '# Project Brain data repository',
    '#',
    '# Checkpoints are immutable, one file each, so they never conflict.',
    '# Decisions are append-only: keep both sides rather than conflicting.',
    'projects/*/decisions.md merge=union',
    '',
    '# Normalise line endings so a Windows machine and a macOS machine',
    '# syncing the same profile do not rewrite every file.',
    '* text=auto eol=lf',
    '',
  ].join('\n');

  const gitignore = [
    '# Nothing derived or machine-local belongs in a data repository.',
    '# These paths live outside the profile directory by design; this file',
    '# exists so that an accidental copy is still never committed.',
    'machine.json',
    'cache/',
    'logs/',
    '*.tmp',
    '.DS_Store',
    '',
  ].join('\n');

  const readme = [
    '# Project Brain data',
    '',
    'This directory is your own developer memory. It is plain YAML and Markdown',
    'on purpose: you can read, grep, edit and diff all of it without Project',
    'Brain installed.',
    '',
    '| Path | What it holds |',
    '| --- | --- |',
    '| `profile.yaml` | Settings for this profile |',
    '| `projects/<id>/project.yaml` | Where a project lives, and its repository |',
    '| `projects/<id>/state.md` | What is happening in it right now |',
    '| `projects/<id>/tasks.yaml` | Next actions |',
    '| `projects/<id>/decisions.md` | Decisions and why they were made |',
    '| `checkpoints/<id>/YYYY/MM/DD/` | One file per checkpoint, never rewritten |',
    '| `machines/` | The computers this profile has been used from |',
    '| `remotes/` | Servers you deploy to (addresses only, never credentials) |',
    '',
    'If you sync this directory to a git repository, use a **private** one.',
    '',
  ].join('\n');

  await Promise.all([
    writeIfAbsent(`${profilePaths.root}/.gitattributes`, gitattributes),
    writeIfAbsent(`${profilePaths.root}/.gitignore`, gitignore),
    writeIfAbsent(`${profilePaths.root}/README.md`, readme),
  ]);
}

async function writeIfAbsent(filePath: string, contents: string): Promise<void> {
  if (await pathExists(filePath)) return;
  await writeFileAtomic(filePath, contents);
}

/** Read this package's version, for `pb --version` and `pb doctor`. */
export async function readPackageVersion(packageJsonPath: string): Promise<string> {
  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    // Running from a build without a package.json beside it.
  }
  return '0.0.0';
}

export { suggestMachineName };
