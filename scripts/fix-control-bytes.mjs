#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * One-off repair: rewrite literal control characters as escape sequences.
 *
 * Kept in the repository because the mistake is easy to repeat — a literal NUL
 * or ESC typed into a string looks identical to the escaped form in most
 * editors, and only `check-source-bytes.mjs` notices.
 *
 * Code points are built with String.fromCharCode so that this file itself
 * contains no control characters.
 */

const CODE_POINTS = [0x0000, 0x001b, 0x001f, 0x0300, 0x036f];

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: fix-control-bytes.mjs <file...>\n');
  process.exit(1);
}

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  let updated = original;

  for (const code of CODE_POINTS) {
    const literal = String.fromCharCode(code);
    const escaped = `\\u${code.toString(16).padStart(4, '0')}`;
    updated = updated.split(literal).join(escaped);
  }

  if (updated === original) {
    process.stdout.write(`unchanged  ${file}\n`);
    continue;
  }

  writeFileSync(file, updated, 'utf8');
  process.stdout.write(`fixed      ${file}\n`);
}
