/**
 * All timestamps are stored as UTC ISO-8601 with second precision and a
 * trailing `Z`. Display formatting converts to the local zone at the edge.
 *
 * Second precision (rather than milliseconds) keeps YAML diffs readable and is
 * far more resolution than "when did I last touch this project" needs.
 */
export type Timestamp = string;

export function now(): Timestamp {
  return toTimestamp(new Date());
}

export function toTimestamp(date: Date): Timestamp {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function parseTimestamp(value: string): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days between two instants, floored. Negative if `then` is in the future. */
export function daysBetween(then: Date, reference: Date): number {
  return Math.floor((reference.getTime() - then.getTime()) / 86_400_000);
}

/**
 * Human-friendly relative time: "just now", "3d ago", "2mo ago".
 *
 * Deliberately coarse. Project Brain infers activity from several signals of
 * differing precision, so presenting "4 hours 12 minutes ago" would imply an
 * accuracy the underlying data does not have.
 */
export function relativeTime(
  value: string | Date | null | undefined,
  reference = new Date(),
): string {
  if (value == null) return 'never';
  const date = typeof value === 'string' ? parseTimestamp(value) : value;
  if (!date) return 'unknown';

  const seconds = Math.round((reference.getTime() - date.getTime()) / 1000);
  // Clock skew between machines sharing a synced data repo is normal, so a
  // slightly-future timestamp is not an error worth surfacing.
  if (seconds < 90) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  const days = calendarDaysBetween(date, reference);
  if (days === 0) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(days / 365)}y ago`;
}

/** Bucket label used by `pb recent`, grouped the way a person thinks about a week. */
export function activityBucket(
  value: string | Date | null | undefined,
  reference = new Date(),
): string {
  if (value == null) return 'NEVER';
  const date = typeof value === 'string' ? parseTimestamp(value) : value;
  if (!date) return 'UNKNOWN';

  const days = calendarDaysBetween(date, reference);
  if (days <= 0) return 'TODAY';
  if (days === 1) return 'YESTERDAY';
  if (days <= 7) return `${days} DAYS AGO`;
  if (days <= 30) {
    const weeks = Math.floor(days / 7);
    return weeks <= 1 ? 'LAST WEEK' : `${weeks} WEEKS AGO`;
  }
  if (days <= 365) {
    const months = Math.floor(days / 30);
    return months <= 1 ? 'LAST MONTH' : `${months} MONTHS AGO`;
  }
  return 'OVER A YEAR AGO';
}

/** Difference in *local calendar days*, so 23:59 to 00:01 counts as yesterday. */
export function calendarDaysBetween(then: Date, reference: Date): number {
  const a = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const b = Date.UTC(reference.getFullYear(), reference.getMonth(), reference.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** UTC path segments used to shard checkpoints on disk: ["2026", "09", "17"]. */
export function datePathSegments(timestamp: Timestamp): [string, string, string] {
  const date = parseTimestamp(timestamp);
  if (!date) throw new RangeError(`Invalid timestamp: ${timestamp}`);
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ];
}

/** `HHMMSS` in UTC - the filename prefix that makes checkpoints sort chronologically. */
export function timeFilePrefix(timestamp: Timestamp): string {
  const date = parseTimestamp(timestamp);
  if (!date) throw new RangeError(`Invalid timestamp: ${timestamp}`);
  return (
    String(date.getUTCHours()).padStart(2, '0') +
    String(date.getUTCMinutes()).padStart(2, '0') +
    String(date.getUTCSeconds()).padStart(2, '0')
  );
}

/** Local-timezone display, e.g. "2026-09-17 21:54". */
export function formatLocal(value: string | Date | null | undefined): string {
  if (value == null) return '-';
  const date = typeof value === 'string' ? parseTimestamp(value) : value;
  if (!date) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
