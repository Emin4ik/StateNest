import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(input: string, home = homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(home, input.slice(2));
  }
  return input;
}

/** Expand `~`, resolve relative segments, and produce an absolute path. */
export function resolveUserPath(input: string, cwd = process.cwd(), home = homedir()): string {
  const expanded = expandTilde(input, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Collapse the home directory back to `~` for display.
 *
 * Output that says `~/Projects/widget` is both shorter and less likely to leak
 * a username into a screenshot, a bug report, or a pasted terminal session.
 */
export function contractHome(path: string, home = homedir()): string {
  if (path === home) return '~';
  if (home === '') return path;

  // Both separators are accepted regardless of the platform this is running
  // on. A synced profile contains paths recorded by other machines, so macOS
  // routinely displays a Windows path - and using only the local separator
  // meant those were never collapsed.
  const trimmedHome = home.replace(/[/\\]+$/, '');
  const separator = trimmedHome.includes('\\') ? '\\' : sep;

  for (const candidate of [`${trimmedHome}/`, `${trimmedHome}\\`]) {
    if (path.startsWith(candidate)) {
      return `~${separator}${path.slice(candidate.length)}`;
    }
  }
  return path;
}

/**
 * Compare two filesystem paths for equality.
 *
 * macOS and Windows are case-insensitive by default, so `/Users/Emin/code` and
 * `/users/emin/code` are the same directory there but not on Linux. Getting
 * this wrong registers one project twice.
 */
export function pathsEqual(a: string, b: string, platform = process.platform): boolean {
  const left = normalizeSeparators(a).replace(/[/]+$/, '');
  const right = normalizeSeparators(b).replace(/[/]+$/, '');
  return isCaseInsensitiveFs(platform)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** True when `child` is inside `parent` (or is `parent` itself). */
export function isPathInside(child: string, parent: string, platform = process.platform): boolean {
  const normalizedParent = normalizeSeparators(parent).replace(/[/]+$/, '');
  const normalizedChild = normalizeSeparators(child).replace(/[/]+$/, '');
  if (pathsEqual(normalizedChild, normalizedParent, platform)) return true;
  const prefix = `${normalizedParent}/`;
  return isCaseInsensitiveFs(platform)
    ? normalizedChild.toLowerCase().startsWith(prefix.toLowerCase())
    : normalizedChild.startsWith(prefix);
}

export function isCaseInsensitiveFs(platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Forward slashes everywhere, so stored paths compare consistently. */
export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * A key for deduplicating paths within one machine.
 *
 * Deliberately *not* used for cross-machine identity: the same project lives at
 * different paths on different computers, which is exactly why project identity
 * comes from the git remote instead.
 */
export function pathKey(path: string, platform = process.platform): string {
  const normalized = normalizeSeparators(path).replace(/[/]+$/, '');
  return isCaseInsensitiveFs(platform) ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve a path through any symlinks, falling back to the input.
 *
 * Without this, one directory can be recorded as two locations. On macOS
 * `/tmp` is a symlink to `/private/tmp`, so a tool invoked from one and a hook
 * invoked from the other register the same working tree twice on the same
 * machine - which then shows up in `statenest resume` as if the project existed on
 * two computers.
 *
 * Falls back to the input when the path does not exist or cannot be read: a
 * best guess is better than refusing to record a location at all.
 */
export async function resolveRealPath(path: string): Promise<string> {
  const [{ realpath: realpathCb }, { promisify }] = await Promise.all([
    import('node:fs'),
    import('node:util'),
  ]);

  // `native` also expands Windows 8.3 short names, which plain `realpath`
  // leaves alone. Without it one directory can be spelled two ways -
  // `C:\\Users\\RUNNER~1\\...` and `C:\\Users\\runneradmin\\...` are the same place, and
  // `%TEMP%` really is short-form whenever the account name exceeds eight
  // characters. That is the Windows shape of the /tmp -> /private/tmp bug this
  // function already exists to prevent. Only the callback form is typed.
  try {
    return await promisify(realpathCb.native)(path);
  } catch {
    try {
      return await promisify(realpathCb)(path);
    } catch {
      return path;
    }
  }
}
