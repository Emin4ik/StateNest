#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The zero-touch demo: context following a developer between two machines.
 *
 * This drives the **real** Claude Code hook entry points as real processes, and
 * the real background sync, against two throwaway homes and a local bare
 * repository. Nothing is simulated and no output is written by this script -
 * every block it prints came out of StateNest.
 *
 * That is the whole point. `npm run demo` shows the CLI, which is the part of
 * StateNest you do not normally need; this shows the part you do.
 *
 * Nothing touches the operator's real `~/.statenest`: both machines get their
 * own `STATENEST_HOME` under the system temp directory, and the projects,
 * machines and remote are invented.
 *
 *   npm run demo:zero-touch
 *   npm run demo:zero-touch -- --fast    no pauses, for a quick check
 */

const FAST = process.argv.includes('--fast');
const PAUSE = FAST ? 0 : 1_400;

const scratch = await mkdtemp(join(tmpdir(), 'statenest-demo-'));
const CLI = join(ROOT, 'dist', 'cli', 'bin.js');
const HOOK = join(ROOT, 'dist-plugin', 'hook.js');

const MACHINES = {
  a: { home: join(scratch, 'mac'), name: 'mac-mini', code: join(scratch, 'mac-code') },
  b: { home: join(scratch, 'linux'), name: 'linux-box', code: join(scratch, 'linux-code') },
};
const BARE = join(scratch, 'statenest-data.git');

/** The compaction summary Claude Code would have generated. Invented, obviously. */
const COMPACT_SUMMARY = [
  'Replaced the greedy berth allocator with cost-based allocation.',
  '',
  '- Implemented cost-based allocation',
  '- Added regression fixtures for tidal windows',
  '- Fixed the refinery income calculation',
].join('\n');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const dim = (text) => `\u001b[2m${text}\u001b[0m`;
const bold = (text) => `\u001b[1m${text}\u001b[0m`;
const cyan = (text) => `\u001b[36m${text}\u001b[0m`;

function banner(text) {
  console.log(`\n${bold(`── ${text} ${'─'.repeat(Math.max(0, 58 - text.length))}`)}\n`);
}

function note(text) {
  console.log(dim(`   ${text}`));
}

/** Show a command, run it, print exactly what it printed. */
async function show(machine, args) {
  console.log(`${cyan(`$ statenest ${args.join(' ')}`)}`);
  await sleep(PAUSE / 3);
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    env: { ...process.env, STATENEST_HOME: machine.home },
    cwd: machine.code,
    timeout: 60_000,
  }).catch((error) => ({ stdout: error.stdout ?? String(error) }));
  console.log(stdout.replace(/\n+$/, ''));
  await sleep(PAUSE);
}

/** Run a real Claude Code hook, exactly as Claude Code runs it. */
function hook(machine, handler, payload) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK, handler], {
      env: { ...process.env, STATENEST_HOME: machine.home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', () => done(out));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Print the context a hook injected into the session, as the model receives it. */
function showInjected(raw) {
  let context = null;
  try {
    context = JSON.parse(raw)?.hookSpecificOutput?.additionalContext ?? null;
  } catch {
    context = null;
  }
  if (!context) {
    console.log(dim('   (nothing injected)'));
    return;
  }
  for (const line of context.split('\n')) console.log(`   ${line}`);
}

/** Wait for the background sync a hook started on its own. */
async function settle(machine) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const state = JSON.parse(
        await readFile(join(machine.home, 'local', 'personal.json'), 'utf8'),
      );
      if (state.last_sync_at && !state.sync_requested_at) return true;
    } catch {
      // Not written yet.
    }
    await sleep(250);
  }
  return false;
}

const git = (cwd, args) =>
  execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

async function makeRepo(path) {
  await mkdir(path, { recursive: true });
  await git(path, ['init', '--quiet', '--initial-branch=main']);
  await git(path, ['config', 'user.email', 'dev@example.com']);
  await git(path, ['config', 'user.name', 'Developer']);
  await git(path, ['remote', 'add', 'origin', 'git@github.com:acme/harbour.git']);
  await writeFile(join(path, 'README.md'), '# harbour\n\nBerth allocation service.\n');
  await writeFile(
    join(path, 'package.json'),
    `${JSON.stringify({ name: 'harbour', description: 'Berth allocation service' }, null, 2)}\n`,
  );
  await git(path, ['add', '-A']);
  await git(path, ['commit', '--quiet', '-m', 'initial commit']);
}

/**
 * Connect a machine to the shared repository, which is what `statenest setup`
 * does when you give it one. Done directly here only because `setup` is
 * interactive and a demo cannot answer its questions.
 */
async function connectSync(machine) {
  const profile = join(machine.home, 'profiles', 'personal');
  await git(profile, ['init', '--quiet', '--initial-branch=main']).catch(() => {});
  await git(profile, ['remote', 'add', 'origin', BARE]).catch(() => {});
  await git(profile, ['config', 'user.email', 'statenest@localhost']);
  await git(profile, ['config', 'user.name', 'StateNest']);

  const file = join(profile, 'profile.yaml');
  let yaml = await readFile(file, 'utf8');
  yaml = yaml.replace('enabled: false', 'enabled: true');
  if (!yaml.includes('remote:')) {
    yaml = yaml.replace('  branch: main', `  remote: ${BARE}\n  branch: main`);
  }
  await writeFile(file, yaml);
}

async function setUp(machine) {
  await execFileAsync(
    process.execPath,
    [CLI, '--home', machine.home, 'init', '-y', '--machine-name', machine.name,
     '--no-scan', '--no-claude', '--no-sync'],
    { timeout: 120_000 },
  );
  await connectSync(machine);
  await makeRepo(machine.code);
}

async function main() {
  await git(scratch, ['init', '--bare', '--quiet', '--initial-branch=main', BARE]);
  await setUp(MACHINES.a);
  await setUp(MACHINES.b);

  banner('Machine A  ·  mac-mini');
  note('StateNest is installed and connected to a private repository. Nothing else.');
  await sleep(PAUSE);
  await show(MACHINES.a, ['projects']);

  note('Now open Claude Code in a repository StateNest has never seen.');
  note('No `statenest add`. No `statenest scan`.');
  console.log(`\n${cyan('$ cd ~/code/harbour && claude')}\n`);
  await sleep(PAUSE);

  showInjected(
    await hook(MACHINES.a, 'session-start', {
      hook_event_name: 'SessionStart',
      cwd: MACHINES.a.code,
      session_id: 'demo-a-1',
      source: 'startup',
    }),
  );
  await sleep(PAUSE);

  note('It registered itself, and injected what it knows. Which is not much yet.');
  await show(MACHINES.a, ['projects']);

  note('Work happens. Claude Code compacts, and hands StateNest the summary');
  note('it had already written - no second model is ever run.');
  await sleep(PAUSE);
  await hook(MACHINES.a, 'post-compact', {
    hook_event_name: 'PostCompact',
    cwd: MACHINES.a.code,
    session_id: 'demo-a-1',
    trigger: 'auto',
    compact_summary: COMPACT_SUMMARY,
  });
  await settle(MACHINES.a);

  await show(MACHINES.a, ['recent']);
  note('And it has already synced. No `statenest sync` was run.');
  await show(MACHINES.a, ['sync', 'status']);

  banner('Machine B  ·  linux-box');
  note('A different computer. The same repository, cloned to a different path.');
  await sleep(PAUSE);

  // First session pulls; the brief it builds is from before that pull landed.
  await hook(MACHINES.b, 'session-start', {
    hook_event_name: 'SessionStart',
    cwd: MACHINES.b.code,
    session_id: 'demo-b-0',
    source: 'startup',
  });
  await settle(MACHINES.b);

  console.log(`\n${cyan('$ cd ~/work/harbour && claude')}\n`);
  await sleep(PAUSE);
  showInjected(
    await hook(MACHINES.b, 'session-start', {
      hook_event_name: 'SessionStart',
      cwd: MACHINES.b.code,
      session_id: 'demo-b-1',
      source: 'startup',
    }),
  );
  await sleep(PAUSE);

  note("Claude on machine B opened already knowing what happened on machine A.");
  note('Nothing was typed on either machine to make that happen.');
  await sleep(PAUSE);

  await show(MACHINES.b, ['where', 'harbour']);
  note('Two machines, two paths, one project - identity is the git remote.');
  console.log('');
}

try {
  await main();
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
