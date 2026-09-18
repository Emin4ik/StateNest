import { open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { errnoCode } from './errors.js';

/**
 * A short-lived advisory lock, for read-modify-write on a shared file.
 *
 * Most of StateNest avoids needing this: checkpoints are immutable files
 * with unique names, and mutable records are replaced atomically, so a
 * concurrent write can never produce a torn file.
 *
 * What atomic replacement does *not* prevent is a lost update. Several Claude
 * Code hooks run as separate processes against the same session record; each
 * reads, increments a counter, and writes. Without serialisation they all read
 * the same starting value and the last writer wins - which in the worst case
 * resets the flag that stops one session being checkpointed twice.
 *
 * `open(..., 'wx')` fails if the file exists, which is an atomic
 * test-and-create on every filesystem we target. The lock records its owner so
 * a crashed process can be detected, and is treated as stale after a short
 * timeout: a hook holding a lock for seconds has already failed, and blocking
 * the user's session behind it would be worse than proceeding.
 */

export interface LockOptions {
  /** How long to keep trying before giving up. */
  timeoutMs?: number;
  /** After this long, an existing lock is assumed to belong to a dead process. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_MS = 10_000;

/**
 * Run `work` while holding the lock for `filePath`.
 *
 * If the lock cannot be taken within the timeout, `work` runs anyway. That is
 * deliberate: this guards a counter in a cache file, and a hook that hangs
 * waiting for a lock would delay somebody's coding session over bookkeeping.
 * Returning a possibly-lost increment is the better failure.
 */
export async function withFileLock<T>(
  filePath: string,
  work: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  const acquired = await acquire(lockPath, timeoutMs, staleMs);
  try {
    return await work();
  } finally {
    if (acquired) await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function acquire(lockPath: string, timeoutMs: number, staleMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {});

  for (let attempt = 0; ; attempt++) {
    try {
      // 'wx' is an atomic create-if-absent: exactly one caller can win.
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') return false;

      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }

      if (Date.now() >= deadline) return false;
      // Back off, but stay well inside the hook deadline.
      await delay(Math.min(5 * 2 ** Math.min(attempt, 5), 100));
    }
  }
}

/**
 * Has this lock outlived any plausible holder?
 *
 * Checked by age rather than by probing the recorded pid: pid reuse makes that
 * unreliable, and a lock held for longer than a hook's entire deadline is
 * abandoned whether or not its process still exists.
 */
async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > staleMs) return true;

    // A zero-length lock is one whose creator died between create and write.
    if (info.size === 0) return Date.now() - info.mtimeMs > 1_000;

    const contents = await readFile(lockPath, 'utf8').catch(() => '');
    const stamp = Number.parseInt(contents.trim().split(/\s+/)[1] ?? '', 10);
    return Number.isFinite(stamp) && Date.now() - stamp > staleMs;
  } catch {
    // Vanished between the EEXIST and the stat: the holder released it.
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
