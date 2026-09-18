import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/**
 * A tripwire against writing outside an allowed root.
 *
 * Project Brain's test suite creates temporary homes and drives the real code
 * against them. A single wrong path - a default that resolves to the developer's
 * actual `~/.project-brain`, a fixture that leaks an absolute path - would have
 * the tests quietly rewriting the author's own data, and the failure would look
 * like a passing test run.
 *
 * Setting `PROJECT_BRAIN_WRITE_ROOT` arms this guard: every atomic write is
 * then checked, and anything outside that root throws before touching the
 * filesystem. It is inert in normal use (one undefined env lookup), so it costs
 * production nothing.
 *
 * This lives in src rather than in the test helpers deliberately: it has to sit
 * in the write path itself to catch a write the tests did not intend to make.
 */
const ENV_VAR = 'PROJECT_BRAIN_WRITE_ROOT';

export class WriteGuardError extends Error {
  constructor(attempted: string, allowedRoot: string) {
    super(
      `Refusing to write outside the allowed root.\n` +
        `  attempted: ${attempted}\n` +
        `  allowed:   ${allowedRoot}\n` +
        `This guard is armed by ${ENV_VAR} and exists to stop a test writing to a real home directory.`,
    );
    this.name = 'WriteGuardError';
  }
}

/**
 * Throw if `filePath` is outside the armed root.
 *
 * Several roots may be given, separated by the platform path delimiter, because
 * a test legitimately writes to both a temp home and a temp project tree.
 */
export function assertWritable(filePath: string): void {
  const configured = process.env[ENV_VAR];
  if (!configured) return;

  const target = canonicalize(filePath);
  const roots = configured
    .split(process.platform === 'win32' ? ';' : ':')
    .map((root) => root.trim())
    .filter((root) => root !== '')
    .map(canonicalize);

  if (roots.length === 0) return;

  const permitted = roots.some((root) => target === root || target.startsWith(root + sep));
  if (!permitted) throw new WriteGuardError(target, roots.join(', '));
}

/**
 * Resolve a path through symlinks, even when it does not exist yet.
 *
 * `resolve()` alone is not enough. On macOS the temp directory is reached as
 * `/var/...` but really lives at `/private/var/...`, so a guard comparing an
 * unresolved target against a resolved root rejects a perfectly legitimate
 * write. (The same resolve-versus-realpath distinction has already caused one
 * bug in this codebase, where one directory registered as two locations.)
 *
 * Writes routinely target files that do not exist, so this walks up to the
 * nearest ancestor that does, resolves that, and re-attaches the remainder.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);

  let existing = absolute;
  const trailing: string[] = [];

  for (let depth = 0; depth < 64; depth++) {
    try {
      return [realpathSync(existing), ...trailing].join(sep);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      trailing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }

  return absolute;
}

/** True when the guard is armed. Used by the test bootstrap to prove isolation. */
export function isWriteGuardArmed(): boolean {
  return Boolean(process.env[ENV_VAR]);
}
