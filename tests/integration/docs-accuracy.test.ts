import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'dist', 'cli', 'bin.js');

/**
 * The user documentation must not describe commands that do not exist.
 *
 * A reference is only worth having if it is true, and a command reference is
 * exactly the kind of document that rots quietly: a renamed subcommand leaves
 * the prose looking perfectly reasonable. This reads the commands back out of
 * the documentation and asks the CLI whether each one is real.
 */
const DOCS = ['docs/command-reference.md', 'docs/user-guide.md', 'README.md'];

/** Commands that take a subcommand, so `statenest task add` is one command. */
const PARENTS = new Set([
  'task',
  'decision',
  'machine',
  'remote',
  'deploy',
  'profile',
  'integrate',
  'privacy',
  'sync',
]);

function documentedCommands(): string[] {
  const found = new Set<string>();
  for (const doc of DOCS) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const match of text.matchAll(/statenest\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
      const [, command, sub] = match;
      if (command === undefined) continue;
      found.add(PARENTS.has(command) && sub ? `${command} ${sub}` : command);
    }
  }
  return [...found].sort();
}

describe('the documentation describes the CLI that exists', () => {
  it('finds a meaningful number of commands to check', () => {
    // Guards against the extraction silently matching nothing and the suite
    // then proving that zero commands are all valid.
    expect(documentedCommands().length).toBeGreaterThan(30);
  });

  it('never names a command the CLI does not have', async () => {
    const invented: string[] = [];

    for (const command of documentedCommands()) {
      const args = command.split(' ');
      try {
        await execFileAsync(process.execPath, [CLI, ...args, '--help'], {
          env: { ...process.env, STATENEST_HOME: join(ROOT, 'no-such-home') },
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
        if (/unknown command|error: unknown/i.test(output)) invented.push(command);
      }
    }

    expect(invented, 'documented commands that do not exist').toEqual([]);
  }, 300_000);

  it('documents every global option the program declares', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--help'], {
      env: { ...process.env, STATENEST_HOME: join(ROOT, 'no-such-home') },
    });
    const reference = readFileSync(join(ROOT, 'docs/command-reference.md'), 'utf8');

    const declared = [...stdout.matchAll(/^\s{2}(--[a-z-]+)/gm)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(3);

    const missing = declared.filter((option) => !reference.includes(option));
    expect(missing, 'global options absent from the command reference').toEqual([]);
  });
});
