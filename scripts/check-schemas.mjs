#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fail if the committed JSON Schemas no longer match the code.
 *
 * The schemas are generated from the same zod definitions the code validates
 * against, which is what stops them drifting — but only if someone regenerates
 * them. Committed-and-stale is worse than absent: a user points their editor at
 * a schema that describes a field the program no longer writes.
 *
 * Regenerates into a temp directory and compares, so it never touches the
 * committed files and does not depend on a clean git tree.
 *
 * Run with `npm run check:schemas`.
 */

const scratch = mkdtempSync(join(tmpdir(), 'pb-schema-check-'));

try {
  execFileSync('node', [join(ROOT, 'scripts/generate-schemas.mjs'), '--out', scratch], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (error) {
  process.stderr.write(
    'Could not generate schemas. Run `npm run build` first.\n' +
      `${error instanceof Error ? error.message : String(error)}\n`,
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const committedDir = join(ROOT, 'schemas');
const read = (dir, file) => {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
};

const expected = readdirSync(scratch).sort();
const actual = readdirSync(committedDir).sort();

const problems = [];

for (const file of expected) {
  if (!actual.includes(file)) {
    problems.push(`${file} is generated but not committed`);
    continue;
  }
  if (read(scratch, file) !== read(committedDir, file)) {
    problems.push(`${file} is out of date`);
  }
}
for (const file of actual) {
  if (!expected.includes(file)) problems.push(`${file} is committed but no longer generated`);
}

rmSync(scratch, { recursive: true, force: true });

if (problems.length > 0) {
  process.stderr.write('\nGenerated schemas are out of date:\n\n');
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write('\nRegenerate them with: npm run build && npm run schemas\n\n');
  process.exit(1);
}

process.stdout.write(`Generated schemas match the code (${expected.length} files).\n`);
