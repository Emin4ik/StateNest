#!/usr/bin/env node
import { readStdin } from './protocol.js';
import { runHook } from './handlers.js';

/**
 * The Claude Code hook process entry point.
 *
 * Deliberately thin. All behaviour lives in handlers.ts so it can be exercised
 * directly by tests; this file exists only to turn a process invocation into a
 * function call and back.
 *
 * It always exits 0. StateNest failing must never look like Claude Code
 * failing, so even an unexpected crash here is swallowed - the handlers already
 * log what went wrong where `statenest doctor` can find it.
 */
async function main(): Promise<void> {
  const output = await runHook(process.argv[2] ?? '', await readStdin());
  if (output !== '') process.stdout.write(output);
  process.exit(0);
}

void main().catch(() => process.exit(0));
