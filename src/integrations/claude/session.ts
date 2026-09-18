import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { readFileOrNull, writeFileAtomic } from '../../util/fs-atomic.js';
import { now, type Timestamp } from '../../util/time.js';
import { sanitizeIdForPath } from '../../core/paths.js';
import type { BrainPaths } from '../../core/paths.js';

/**
 * Per-session scratch state for the Claude Code integration.
 *
 * Machine-local and disposable: it lives under `cache/`, outside every profile
 * directory, so it is never synced and deleting it loses nothing but the
 * current session's running tally.
 *
 * Its job is to let a sequence of cheap hook invocations add up to one good
 * checkpoint at the end, instead of writing a file on every Stop.
 */
export const SessionRecordSchema = z.looseObject({
  session_id: z.string(),
  project_id: z.string().nullable().default(null),
  cwd: z.string(),
  started_at: z.string(),
  last_activity_at: z.string(),
  /** Stop events seen. A proxy for how much work happened. */
  turns: z.number().int().nonnegative().default(0),
  /** Git state when the session began, to diff against at the end. */
  start_branch: z.string().nullable().default(null),
  start_commit: z.string().nullable().default(null),
  start_changed_files: z.number().int().nonnegative().nullable().default(null),
  /** True once a checkpoint has been written for this session. */
  checkpointed: z.boolean().default(false),
  /**
   * Digest of the last compaction summary recorded for this session.
   *
   * Claude Code can deliver the same hook more than once. Two *different*
   * compactions in one session should each produce a checkpoint, so the guard
   * cannot simply be "already checkpointed" - it has to be the identity of the
   * compaction itself.
   */
  last_compact_digest: z.string().nullable().default(null),
  /** Set by PreCompact so PostCompact can attach its summary to real state. */
  pending_compact: z
    .looseObject({
      at: z.string(),
      branch: z.string().nullable().default(null),
      commit: z.string().nullable().default(null),
      changed_files: z.number().int().nonnegative().nullable().default(null),
    })
    .nullable()
    .default(null),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/** Stable digest of a compaction summary, used only for duplicate detection. */
export function compactDigest(summary: string): string {
  return createHash('sha256').update(summary).digest('hex').slice(0, 16);
}

export function sessionFilePath(paths: BrainPaths, sessionId: string): string {
  return join(paths.cacheDir, 'sessions', `${sanitizeIdForPath(sessionId)}.json`);
}

export async function readSessionRecord(
  paths: BrainPaths,
  sessionId: string,
): Promise<SessionRecord | null> {
  const raw = await readFileOrNull(sessionFilePath(paths, sessionId));
  if (raw === null) return null;
  try {
    const parsed = SessionRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // A truncated cache file is not worth reporting; it is rebuilt on the
    // next hook invocation.
    return null;
  }
}

export async function writeSessionRecord(
  paths: BrainPaths,
  record: SessionRecord,
): Promise<void> {
  await writeFileAtomic(
    sessionFilePath(paths, record.session_id),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * Read, change and write a session record while holding its lock.
 *
 * Several hook processes touch the same record concurrently - a trailing async
 * Stop overlapping a SessionEnd is entirely normal. Without serialisation each
 * reads the same starting value and the last writer wins, which loses turn
 * counts and, worse, can reset the flag that stops a session being
 * checkpointed twice.
 */
export async function updateSessionRecord(
  paths: BrainPaths,
  sessionId: string,
  cwd: string,
  change: (record: SessionRecord) => SessionRecord | Promise<SessionRecord>,
): Promise<SessionRecord> {
  const { withFileLock } = await import('../../util/file-lock.js');

  return withFileLock(sessionFilePath(paths, sessionId), async () => {
    const existing = (await readSessionRecord(paths, sessionId)) ?? newSessionRecord(sessionId, cwd);
    const updated = await change(existing);
    await writeSessionRecord(paths, updated);
    return updated;
  });
}

export function newSessionRecord(
  sessionId: string,
  cwd: string,
  fields: Partial<SessionRecord> = {},
): SessionRecord {
  const timestamp: Timestamp = now();
  return SessionRecordSchema.parse({
    session_id: sessionId,
    cwd,
    started_at: timestamp,
    last_activity_at: timestamp,
    ...fields,
  });
}

/**
 * Remove session files that are clearly finished.
 *
 * Claude Code does not guarantee a SessionEnd for every session - a crash or a
 * killed terminal leaves the file behind - so old records are swept rather
 * than relied on being deleted.
 */
export async function pruneSessionRecords(
  paths: BrainPaths,
  maxAgeHours = 72,
): Promise<number> {
  const { listFiles } = await import('../../storage/store.js');
  const { rm, stat } = await import('node:fs/promises');
  const dir = join(paths.cacheDir, 'sessions');
  const names = await listFiles(dir, '.json');
  const cutoff = Date.now() - maxAgeHours * 3_600_000;

  let removed = 0;
  await Promise.all(
    names.map(async (name) => {
      const file = join(dir, name);
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) {
          await rm(file, { force: true });
          removed++;
        }
      } catch {
        // Already gone, or unreadable. Either way there is nothing to do.
      }
    }),
  );
  return removed;
}
