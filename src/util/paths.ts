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
  const prefix = home.endsWith(sep) ? home : home + sep;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
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
