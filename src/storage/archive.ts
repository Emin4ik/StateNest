import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, normalize } from 'node:path';
import { BrainError } from '../util/errors.js';

const execFileAsync = promisify(execFile);

/**
 * Archive safety.
 *
 * `pb import` extracts an archive the user may have been handed by someone
 * else. A tar entry whose path escapes the extraction directory - the classic
 * "Zip Slip" - would let that archive write anywhere the user can write.
 *
 * The tempting assumption is that tar refuses this. macOS's bsdtar does reject
 * `..` outright; GNU tar strips it with a warning; behaviour differs again
 * with `-P`, with symlink members, and between versions. Depending on an
 * external tool's default policy across three platforms is not a security
 * control.
 *
 * So every member is validated before anything is extracted, and the archive
 * is rejected as a whole if any member is unsafe. Rejecting is right here:
 * a Project Brain backup containing a path traversal is not a backup with one
 * bad file in it, it is not a Project Brain backup.
 */

export interface ArchiveMember {
  path: string;
  /** Present when tar reports the member as a link. */
  linkTarget: string | null;
}

export interface ArchiveInspection {
  members: ArchiveMember[];
  /** Reasons the archive is unsafe. Empty when it is safe to extract. */
  problems: string[];
}

/**
 * True when a tar member path would escape the directory it is extracted into.
 *
 * Checks the *normalized* path, so `a/../../b` is caught as well as `../b`,
 * and handles Windows separators and drive letters because an archive made on
 * one platform is routinely restored on another.
 */
export function isUnsafeMemberPath(memberPath: string): boolean {
  const raw = memberPath.trim();
  if (raw === '') return true;

  // Absolute in any platform's sense.
  if (isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(raw)) return true;
  // UNC.
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return true;

  const unified = raw.replace(/\\/g, '/');
  const normalized = normalize(unified).replace(/\\/g, '/');

  if (normalized === '..' || normalized.startsWith('../')) return true;
  if (normalized.split('/').includes('..')) return true;

  return false;
}

/** List an archive's members and report anything unsafe about them. */
export async function inspectArchive(archivePath: string): Promise<ArchiveInspection> {
  let listing: string;
  try {
    // `-tv` includes link targets, which a plain `-t` omits.
    const { stdout } = await execFileAsync('tar', ['-tvzf', archivePath], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    listing = stdout;
  } catch (error) {
    throw new BrainError('ARCHIVE_UNREADABLE', 'Could not read the archive.', {
      details: [firstLine((error as { stderr?: string }).stderr ?? String(error))],
      hints: ['Check that the file is a gzipped tar archive created by `pb export`.'],
    });
  }

  const members: ArchiveMember[] = [];
  const problems: string[] = [];

  for (const line of listing.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // `-tv` output ends with the path, optionally followed by ` -> target`.
    const parsed = parseVerboseLine(trimmed);
    if (!parsed) continue;
    members.push(parsed);

    if (isUnsafeMemberPath(parsed.path)) {
      problems.push(`"${parsed.path}" would be written outside the target directory`);
      continue;
    }

    if (parsed.linkTarget !== null) {
      // Project Brain never writes a symlink, so one here is either a mistake
      // or an attempt to redirect a later write out of the directory.
      problems.push(`"${parsed.path}" is a link, which a Project Brain archive never contains`);
    }
  }

  if (members.length === 0) {
    problems.push('the archive contains no files');
  }

  return { members, problems };
}

/**
 * Inspect, then extract into `destination`.
 *
 * Throws before extracting anything if the archive is unsafe.
 */
export async function extractArchiveSafely(
  archivePath: string,
  destination: string,
): Promise<ArchiveMember[]> {
  const inspection = await inspectArchive(archivePath);

  if (inspection.problems.length > 0) {
    throw new BrainError('UNSAFE_ARCHIVE', 'Refusing to extract this archive.', {
      details: inspection.problems.slice(0, 8),
      hints: [
        'A Project Brain backup contains only plain files under a single directory.',
        'If you created this archive yourself, re-create it with: pb export',
      ],
    });
  }

  try {
    await execFileAsync(
      'tar',
      // `-P` is deliberately NOT passed: absolute paths stay disabled in tar
      // as well, so this is belt and braces rather than a single check.
      ['-xzf', archivePath, '-C', destination],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new BrainError('ARCHIVE_EXTRACT_FAILED', 'Could not extract the archive.', {
      details: [firstLine((error as { stderr?: string }).stderr ?? String(error))],
    });
  }

  return inspection.members;
}

/**
 * Parse one line of `tar -tv` output into a member.
 *
 * Formats differ between bsdtar and GNU tar, but both end the line with the
 * path, and both render a link as `path -> target`. Anchoring on the last
 * whitespace-delimited group after the timestamp is more robust than trying to
 * match either tool's column layout.
 */
function parseVerboseLine(line: string): ArchiveMember | null {
  // Anything before the path is mode/owner/size/date; the path is what follows
  // the time field. Match a time (HH:MM or HH:MM:SS) or a year, then take the rest.
  const match = /(?:\d{1,2}:\d{2}(?::\d{2})?|\s\d{4})\s+(.+)$/.exec(line);
  const rest = match?.[1] ?? (line.includes(' ') ? null : line);
  if (!rest) return null;

  const arrow = rest.indexOf(' -> ');
  if (arrow >= 0) {
    return { path: rest.slice(0, arrow).trim(), linkTarget: rest.slice(arrow + 4).trim() };
  }
  return { path: rest.trim(), linkTarget: null };
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? text.trim()
  );
}
