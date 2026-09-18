import { open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
 * How many times to recreate a vanishing lock directory before giving up.
 *
 * If it disappears this often something else is deleting it, and spinning
 * helps nobody.
 */
const MAX_MISSING_DIR_RETRIES = 10;

/**
 * Run `work` while holding the lock for `filePath`.
 *
 * If the lock cannot be taken within the timeout, `work` runs anyway. That is
 * deliberate: this guards a counter in a cache file, and a hook that hangs
 * waiting for a lock would delay somebody's coding session over bookkeeping.
 * Returning a possibly-lost increment is the better failure.
 */
/**
 * Work already queued for a given file, within this process.
 *
 * The file lock handles *other processes*; it cannot help with concurrency
 * inside one, where it degrades to a timeout and then - because it fails open -
 * to a lost update under load. That concurrency is real: the MCP server is a
 * single process serving tool calls in parallel, and the plugin's hook handlers
 * are invoked in-process too.
 *
 * Chaining onto the previous promise for the same path serialises those exactly,
 * with no I/O, no timeout and nothing to fail open about.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(
  filePath: string,
  work: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const key = resolve(filePath);
  const previous = inFlight.get(key) ?? Promise.resolve();

  // Extended synchronously, so two callers in the same tick cannot both see an
  // empty queue. A rejected predecessor must not cancel the queue, hence the
  // swallow before chaining.
  const run = previous.then(() => lockAcrossProcesses(filePath, work, options));

  // The queued promise must never reject, or it would take out whoever chains
  // onto it. Keep a reference to the exact promise stored, so the cleanup below
  // compares like with like.
  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, queued);

  try {
    return await run;
  } finally {
    // Only clear if nobody queued behind us, or their ordering would be lost.
    if (inFlight.get(key) === queued) inFlight.delete(key);
  }
}

/**
 * Run `work` only if the lock is free, and do nothing at all if it is not.
 *
 * The opposite bargain from `withFileLock`. That one guards a counter, where a
 * possibly-lost increment beats delaying somebody's session, so it proceeds
 * without the lock. This one guards sync, where running twice at once means two
 * processes driving git in the same directory - so a contended lock must mean
 * "somebody else already has this", not "go ahead anyway".
 *
 * Returns `notRun` when the lock was held. Callers treat that as success:
 * whoever holds it is doing the work.
 */
export async function withExclusiveFileLock<T>(
  filePath: string,
  work: () => Promise<T>,
  notRun: T,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.timeoutMs ?? 0;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {});
  if (!(await acquire(lockPath, timeoutMs, staleMs))) return notRun;

  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function lockAcrossProcesses<T>(
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
  let missingDirRetries = 0;
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

      // The lock directory was not there. That happens on the first write of a
      // session, and whenever something has just swept the cache directory.
      // Giving up here means running *unlocked*, which is the lost update this
      // module exists to prevent - so recreate the directory and try again
      // rather than treating a missing parent as unrecoverable.
      //
      // Bounded, and with the same backoff as any other retry. A first version
      // of this retried immediately and without a limit: when the directory
      // kept vanishing it spun ~30,000 times in two seconds, saturating a core
      // and starving the very writers it was waiting for. An unbounded retry
      // that does no waiting is a busy loop wearing a lock's clothing.
      if (code === 'ENOENT') {
        missingDirRetries += 1;
        if (missingDirRetries > MAX_MISSING_DIR_RETRIES || Date.now() >= deadline) return false;
        await mkdir(dirname(lockPath), { recursive: true }).catch(() => {});
        await delay(backoffMs(attempt));
        continue;
      }

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
