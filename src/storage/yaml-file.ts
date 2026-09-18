import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { z } from 'zod';
import { BrainError } from '../util/errors.js';
import { migrateRecord, type RecordKind } from '../core/migrations.js';
import { readFileOrNull, writeFileAtomic } from '../util/fs-atomic.js';
import { contractHome } from '../util/paths.js';

/**
 * Reading a record that could not be parsed.
 *
 * A malformed file is reported, never deleted and never silently skipped in a
 * way that makes data look absent. `statenest doctor` collects these; the rest of the
 * tool keeps working around them.
 */
export interface LoadIssue {
  filePath: string;
  reason: string;
}

export interface LoadResult<T> {
  value: T | null;
  issue: LoadIssue | null;
}

const YAML_WRITE_OPTIONS = {
  // Keep long prose on one line: wrapped YAML scalars produce noisy diffs when
  // a single word changes, which matters when this is synced through git.
  lineWidth: 0,
  // Quote strings only when required, so hand-editing stays comfortable.
  defaultStringType: 'PLAIN',
  defaultKeyType: 'PLAIN',
} as const;

export function serializeYaml(value: unknown): string {
  return stringifyYaml(value, YAML_WRITE_OPTIONS);
}

/**
 * Read and validate a YAML record.
 *
 * Returns an issue rather than throwing so that one corrupt project file
 * cannot make `statenest projects` fail for the other forty-nine.
 */
export async function readYamlFile<S extends z.ZodType>(
  filePath: string,
  schema: S,
  /**
   * When given, a record written by an older StateNest is migrated forward
   * in memory before validation. Nothing is written back here - `statenest migrate`
   * does that, after taking a backup.
   */
  kind?: RecordKind,
): Promise<LoadResult<z.infer<S>>> {
  const raw = await readFileOrNull(filePath);
  if (raw === null) return { value: null, issue: null };

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    return {
      value: null,
      issue: { filePath, reason: `invalid YAML: ${describeError(error)}` },
    };
  }

  if (parsed === null || parsed === undefined) {
    return { value: null, issue: { filePath, reason: 'file is empty' } };
  }

  // Migrate before validating: a pre-release record is not invalid, it is old,
  // and rejecting it would make the user's own data unreadable to them.
  const candidate = kind ? migrateRecord(kind, parsed).value : parsed;

  const result = schema.safeParse(candidate);
  if (!result.success) {
    return {
      value: null,
      issue: { filePath, reason: `does not match the expected schema: ${describeZod(result.error)}` },
    };
  }

  return { value: result.data, issue: null };
}

/** Read a YAML record, throwing a user-facing error if it cannot be loaded. */
export async function readYamlFileOrThrow<S extends z.ZodType>(
  filePath: string,
  schema: S,
): Promise<z.infer<S>> {
  const { value, issue } = await readYamlFile(filePath, schema);
  if (issue) {
    throw new BrainError('CORRUPT_FILE', `Could not read ${contractHome(filePath)}`, {
      details: [issue.reason],
      hints: ['statenest doctor --repair', `Inspect the file directly: ${contractHome(filePath)}`],
    });
  }
  if (value === null) {
    throw new BrainError('FILE_NOT_FOUND', `${contractHome(filePath)} does not exist`);
  }
  return value;
}

/**
 * Validate before writing, so a bug in StateNest cannot persist a record
 * that StateNest will later refuse to read.
 */
export async function writeYamlFile<S extends z.ZodType>(
  filePath: string,
  schema: S,
  value: unknown,
): Promise<z.infer<S>> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BrainError(
      'INVALID_RECORD',
      `Refusing to write an invalid record to ${contractHome(filePath)}`,
      {
        details: [describeZod(result.error)],
        hints: ['This is a bug in StateNest - please report it with this message.'],
      },
    );
  }
  await writeFileAtomic(filePath, serializeYaml(result.data));
  return result.data;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}

function describeZod(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
