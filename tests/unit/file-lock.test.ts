import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '../../src/util/file-lock.js';
import { makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * The lock has one job: no lost updates.
 *
 * It fails open by design — a hook that hangs waiting for a lock is worse than
 * a dropped counter — which makes every path that gives up early a potential
 * lost update. Two of them were real:
 *
 *   - `open(lock, 'wx')` returns ENOENT when the parent directory is missing,
 *     which happens on the first write of a session. That was treated as
 *     unrecoverable, so the very first concurrent writes ran unlocked.
 *   - Backoff used a fixed interval, so every waiter woke at the same moment
 *     and collided again; one could lose every race until the deadline.
 *
 * Both showed up as 9 of 10 concurrent increments landing, on a loaded CI
 * runner and never on an idle laptop.
 */
describe('withFileLock', () => {
  let dir: TempDir;

  beforeEach(async () => {
    dir = await makeTempDir('statenest-lock-');
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  /** Read-modify-write with a real gap between the read and the write. */
  async function increment(file: string) {
    return withFileLock(file, async () => {
      const current = JSON.parse(await readFile(file, 'utf8')) as { n: number };
      await new Promise((resolve) => setTimeout(resolve, 1));
      await writeFile(file, JSON.stringify({ n: current.n + 1 }));
    });
  }

  it('loses no updates among concurrent writers', async () => {
    const file = join(dir.path, 'counter.json');
    await writeFile(file, JSON.stringify({ n: 0 }));

    await Promise.all(Array.from({ length: 20 }, () => increment(file)));

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 20 });
  });

  it('loses no updates when the lock directory does not exist yet', async () => {
    // The exact shape of the bug: the first writes of a session happen before
    // anything has created the directory the lock file lives in.
    const nested = join(dir.path, 'cache', 'sessions');
    const file = join(nested, 'counter.json');
    await mkdir(nested, { recursive: true });
    await writeFile(file, JSON.stringify({ n: 0 }));
    await rm(join(dir.path, 'cache'), { recursive: true, force: true });
    await mkdir(nested, { recursive: true });
    await writeFile(file, JSON.stringify({ n: 0 }));

    await Promise.all(Array.from({ length: 10 }, () => increment(file)));

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 10 });
  });

  it('serialises callers in this process, without relying on the file lock', async () => {
    // The file lock guards against *other processes*. Inside one process it
    // degrades to a timeout and, because it fails open, to a lost update under
    // load — which is exactly what happened on a saturated CI runner. Callers
    // in this process are now queued, so their critical sections cannot
    // overlap at all.
    const file = join(dir.path, 'ordering.json');
    await writeFile(file, '{}');

    const events: string[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        withFileLock(file, async () => {
          events.push(`enter-${index}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`exit-${index}`);
        }),
      ),
    );

    // Every enter is immediately followed by its own exit: no interleaving.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]!.replace('enter-', '')).toBe(events[i + 1]!.replace('exit-', ''));
      expect(events[i]!.startsWith('enter-')).toBe(true);
      expect(events[i + 1]!.startsWith('exit-')).toBe(true);
    }
  });

  it('a failing caller does not break the queue behind it', async () => {
    const file = join(dir.path, 'queue.json');
    await writeFile(file, JSON.stringify({ n: 0 }));

    const results = await Promise.allSettled([
      withFileLock(file, async () => {
        throw new Error('first fails');
      }),
      increment(file),
      increment(file),
    ]);

    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('fulfilled');
    expect(results[2]!.status).toBe('fulfilled');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 2 });
  });

  it('returns the value the work produced', async () => {
    const file = join(dir.path, 'value.json');
    await writeFile(file, '{}');
    await expect(withFileLock(file, async () => 'result')).resolves.toBe('result');
  });

  it('releases the lock even when the work throws', async () => {
    const file = join(dir.path, 'throws.json');
    await writeFile(file, JSON.stringify({ n: 0 }));

    await expect(
      withFileLock(file, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    // A leaked lock would make the next caller wait out the whole timeout.
    const started = Date.now();
    await increment(file);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 1 });
  });
});
