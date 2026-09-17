import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { errnoCode } from './errors.js';

/**
 * Durable file replacement.
 *
 * Write to a sibling temp file, flush it to disk, then rename over the target.
 * `rename` within a directory is atomic on every filesystem we support, so a
 * crash mid-write leaves either the old file or the new one - never a
 * half-written registry that makes the whole tool look corrupt.
 *
 * The temp file is a *sibling* rather than in the OS temp dir on purpose:
 * rename across filesystems is not atomic (and fails outright with EXDEV).
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tempPath, 'wx', options.mode ?? 0o600);
    try {
      await handle.writeFile(data);
      // Without the flush, rename can be durable while the *contents* are not:
      // the metadata operation reaches disk before the data blocks do.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath);
    await syncDirectory(dir);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * On Windows, `rename` over an existing file intermittently fails with EPERM
 * or EBUSY when a virus scanner or an editor briefly holds the target open.
 * The operation succeeds on retry; failing the user's checkpoint over a
 * transient scanner lock would be a bad trade.
 */
async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoCode(error);
      const retriable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retriable || attempt >= attempts - 1) throw error;
      await delay(Math.min(2 ** attempt * 5, 200));
    }
  }
}

/**
 * fsync the containing directory so the rename itself survives a power loss.
 * Windows cannot open a directory as a file and returns EPERM/EISDIR here;
 * that is expected, not an error worth propagating.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Best effort by design - see above.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append a line to a file, creating it if needed.
 *
 * Appends under `O_APPEND` are atomic for writes below the pipe buffer size on
 * POSIX, which is what makes the activity journal safe to write from several
 * concurrent Claude Code sessions without a lock.
 */
export async function appendLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${line}\n`, { flag: 'a', mode: 0o600 });
}

export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
