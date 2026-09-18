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
      const code = errnoCode(error);
      // EEXIST is the normal "someone else holds it". Windows also reports
      // EPERM or EBUSY when the file is being replaced at that instant, which
      // is contention too - treating it as a hard failure would silently drop
      // the update the lock exists to protect.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') return false;

      if (code === 'EEXIST' && (await isStale(lockPath, staleMs))) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }

      if (Date.now() >= deadline) return false;
      await delay(backoffMs(attempt));
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

/**
 * Exponential backoff with jitter.
 *
 * The jitter is the important half. Without it every waiter sleeps for exactly
 * the same interval, wakes together, and collides again — so under real
 * contention one unlucky waiter can lose every race until the deadline and
 * then proceed without the lock, which is precisely the lost update this
 * module exists to prevent. It showed up as 9 of 10 concurrent Stop events
 * being recorded on a loaded CI runner, and never on an idle laptop.
 *
 * Capped well inside the hook deadline: waiting is cheaper than a lost
 * increment, but not at the cost of delaying somebody's session.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(5 * 2 ** Math.min(attempt, 5), 80);
  return base + Math.random() * base;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
