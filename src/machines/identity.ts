import { arch, homedir, hostname, platform, release, type } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomId, slugify } from '../util/ids.js';
import { now } from '../util/time.js';
import type { Machine } from '../core/schema.js';

export type OsKind = 'macos' | 'linux' | 'windows' | 'wsl' | 'unknown';
export type MachineType = 'laptop' | 'desktop' | 'server' | 'container' | 'vm' | 'unknown';

/**
 * Which operating system is this, really?
 *
 * WSL is reported by Node as plain `linux`, but it matters for StateNest:
 * a repository at `/mnt/c/code/widget` under WSL is the *same working tree* as
 * `C:\code\widget` on the Windows side, and treating the two as separate
 * machines would double-count every project the user has.
 */
export function detectOs(): OsKind {
  switch (platform()) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return isWsl() ? 'wsl' : 'linux';
    default:
      return 'unknown';
  }
}

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform() !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    // Both WSL 1 and WSL 2 identify themselves in the kernel version string.
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Best-effort container detection, used only to label the machine record. */
export function isContainer(): boolean {
  if (process.env.container) return true;
  try {
    readFileSync('/.dockerenv');
    return true;
  } catch {
    // Not a container, or not Linux. Fall through.
  }
  try {
    return /docker|containerd|kubepods|lxc/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A guess at what kind of machine this is, shown in `statenest machine list`.
 *
 * Presented as an editable default rather than a fact: the user can correct it,
 * and nothing depends on it being right.
 */
export function guessMachineType(): MachineType {
  if (isContainer()) return 'container';
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return 'server';
  if (platform() === 'darwin') {
    // "MacBook" in the hostname is the only signal available without shelling
    // out to system_profiler, which is slow and macOS-only.
    return /macbook/i.test(hostname()) ? 'laptop' : 'desktop';
  }
  return 'unknown';
}

/** A readable default name: `emin-macbook` rather than `Emins-MacBook-Pro.local`. */
export function suggestMachineName(rawHostname = hostname()): string {
  const withoutDomain = rawHostname.split('.')[0] ?? rawHostname;
  const slug = slugify(withoutDomain, 40);
  return slug === 'untitled' ? 'machine' : slug;
}

export function newMachineId(): string {
  return randomId('machine', 10);
}

/**
 * Build the descriptive record for this computer.
 *
 * The id is supplied by the caller because it is generated exactly once, when
 * StateNest is first initialised here, and then reused forever. Rebuilding
 * the description on every run is cheap and keeps it accurate after an OS
 * upgrade or a rename.
 */
export function describeThisMachine(
  machineId: string,
  options: { name?: string; firstSeenAt?: string; type?: MachineType } = {},
): Machine {
  const timestamp = now();
  const machine: Machine = {
    schema_version: 1,
    id: machineId,
    name: options.name ?? suggestMachineName(),
    type: options.type ?? guessMachineType(),
    os: detectOs(),
    os_release: `${type()} ${release()}`,
    hostname: hostname(),
    architecture: arch(),
    home_dir: homedir(),
    first_seen_at: options.firstSeenAt ?? timestamp,
    last_seen_at: timestamp,
  };
  return machine;
}
