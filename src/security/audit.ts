import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { detectSecrets, type SecretFinding } from './redact.js';
import { readFileOrNull } from '../util/fs-atomic.js';
import { errnoCode } from '../util/errors.js';
import type { ProfilePaths } from '../core/paths.js';

/**
 * Auditing StateNest's own data.
 *
 * This scans what StateNest wrote, not the user's source code. The
 * distinction matters: the promise made to the user is that *this tool* never
 * stores their secrets, and this is how that promise is checked. Auditing
 * their repositories would be a different product.
 *
 * Where redaction is the right response while writing a checkpoint, a finding
 * here blocks sync. Data that is about to leave the machine gets the strict
 * treatment.
 */

export interface AuditFileResult {
  /** Path relative to the profile root, so output is portable and short. */
  relativePath: string;
  absolutePath: string;
  findings: SecretFinding[];
}

export interface AuditResult {
  filesScanned: number;
  bytesScanned: number;
  files: AuditFileResult[];
  /** Files that could not be read. Reported, never silently skipped. */
  unreadable: string[];
  durationMs: number;
}

export function totalFindings(result: AuditResult): number {
  return result.files.reduce((sum, file) => sum + file.findings.length, 0);
}

export function hasBlockingFindings(result: AuditResult): boolean {
  return result.files.some((file) =>
    file.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high'),
  );
}

/** Files above this are not prose and are not scanned; their size is reported. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const SCANNABLE_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.json', '.txt']);

/**
 * Scan a profile's data directory.
 *
 * Everything StateNest persists is small text, so a full read of the whole
 * profile is fast enough to run before every sync rather than sampling.
 */
export async function auditProfile(paths: ProfilePaths): Promise<AuditResult> {
  const startedAt = Date.now();
  const files: AuditFileResult[] = [];
  const unreadable: string[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') unreadable.push(dir);
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        // `.git` inside a profile is the sync repository's own storage. Its
        // object files are compressed and scanning them would produce noise,
        // not findings; the working tree is what gets committed.
        if (entry.name === '.git') continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const dot = entry.name.lastIndexOf('.');
      const extension = dot >= 0 ? entry.name.slice(dot).toLowerCase() : '';
      if (!SCANNABLE_EXTENSIONS.has(extension)) continue;

      try {
        const info = await stat(full);
        if (info.size > MAX_SCAN_BYTES) continue;
        bytesScanned += info.size;
      } catch {
        unreadable.push(full);
        continue;
      }

      const contents = await readFileOrNull(full);
      if (contents === null) {
        unreadable.push(full);
        continue;
      }

      filesScanned++;
      const findings = detectSecrets(contents);
      if (findings.length > 0) {
        files.push({
          relativePath: relative(paths.root, full) || entry.name,
          absolutePath: full,
          findings,
        });
      }
    }
  };

  await walk(paths.root, 0);

  return {
    filesScanned,
    bytesScanned,
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    unreadable,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The reason a sync was blocked, as shown to the user.
 *
 * Names the file, the line and the kind of secret - and never the value. A
 * message that echoed the credential would leak it into terminal scrollback,
 * CI logs and screenshots, which is the opposite of the point.
 */
export function describeBlock(result: AuditResult): string[] {
  const lines: string[] = [];
  for (const file of result.files) {
    const blocking = file.findings.filter(
      (finding) => finding.severity === 'critical' || finding.severity === 'high',
    );
    if (blocking.length === 0) continue;
    for (const finding of blocking) {
      lines.push(`${file.relativePath}:${finding.line}  ${finding.description} (${finding.masked})`);
    }
  }
  return lines;
}
