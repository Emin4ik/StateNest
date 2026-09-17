#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Refuse to ship source files containing raw control bytes.
 *
 * A literal NUL or combining mark typed directly into a string or regex works
 * at runtime but makes git treat the file as binary - no diffs, no merges, no
 * review. It is also invisible in most editors, so it survives indefinitely.
 * Escape sequences are the only readable way to express these.
 *
 * Run by `npm run check:bytes`, and in CI.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-plugin', 'coverage']);
const CHECKED_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml)$/;

// Detecting control characters necessarily means matching them. The rule that
// forbids this exists to catch them appearing by accident, which is exactly
// what this file is for.
// eslint-disable-next-line no-control-regex
const C0_CONTROLS = new RegExp('[\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f]');
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]');
const BIDI_CONTROLS = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069]');

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (CHECKED_EXTENSIONS.test(entry.name)) found.push(path);
  }
  return found;
}

const problems = [];

for (const file of walk('.')) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  const issues = [];

  if (bytes.includes(0)) issues.push('NUL byte (git will treat this file as binary)');
  if (COMBINING_MARKS.test(text)) issues.push('literal combining mark - use an escape sequence');
  if (C0_CONTROLS.test(text)) issues.push('raw C0 control character');
  // Bidirectional overrides can make source read differently than it executes.
  if (BIDI_CONTROLS.test(text)) issues.push('bidirectional formatting character');

  if (issues.length > 0) problems.push({ file, issues });
}

if (problems.length === 0) {
  process.stdout.write('No raw control bytes in source files.\n');
  process.exit(0);
}

for (const { file, issues } of problems) {
  process.stderr.write(`${file}\n`);
  for (const issue of issues) process.stderr.write(`  ${issue}\n`);
}
process.stderr.write(`\n${problems.length} file(s) contain raw control bytes.\n`);
process.exit(1);
