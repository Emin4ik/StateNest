#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './program.js';
import { readPackageVersion } from '../core/workspace.js';
import { printError } from './output.js';

/**
 * `statenest` entry point.
 *
 * Kept deliberately thin: commander is configured in program.ts so it can be
 * exercised by tests without spawning a process.
 */
async function main(): Promise<void> {
  // dist/cli/bin.js -> package root is two levels up.
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const version = await readPackageVersion(join(packageRoot, 'package.json'));

  const exitCode = await run(process.argv, version);
  // Set rather than call process.exit(), so buffered stdout is flushed before
  // the process ends. A piped `statenest projects --json | jq` truncates otherwise.
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  printError(error);
  process.exitCode = 1;
});
