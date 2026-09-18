#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A deterministic demo, for a terminal recording.
 *
 * Everything here is invented: the projects, the machines, the servers, the
 * checkpoints. It runs against a throwaway home in the system temp directory
 * and never reads the operator's real data, so a recording of it cannot leak a
 * private repository name, a real server address or a local path.
 *
 * Node rather than shell so it records identically on macOS, Linux and Windows.
 *
 *   npm run demo            play it
 *   npm run demo -- --fast  no typing pauses, for a quick check
 */

const FAST = process.argv.includes('--fast');
const PAUSE = FAST ? 0 : 1_200;

/** Fictional projects. Names chosen to be obviously invented. */
const PROJECTS = [
  {
    dir: 'harbourmaster',
    remote: 'git@github.com:northwind/harbourmaster.git',
    readme: '# harbourmaster\n\nSchedules berth allocation for a fictional port.\n',
    branch: 'main',
    checkpoint: {
      summary: 'Replaced the greedy berth allocator with a cost-based one.',
      next: ['re-run the winter schedule fixtures', 'measure allocation latency'],
      blocked: null,
    },
  },
  {
    dir: 'tideline',
    remote: 'git@github.com:northwind/tideline.git',
    readme: '# tideline\n\nTide prediction service for the harbour schedule.\n',
    branch: 'forecast-v2',
    checkpoint: {
      summary: 'Switched the forecast window from 24h to 72h.',
      next: ['backfill last season', 'decide on the cache eviction policy'],
      blocked: 'waiting on the upstream tide feed contract',
    },
  },
  {
    dir: 'dockhand',
    remote: 'git@github.com:northwind/dockhand.git',
    readme: '# dockhand\n\nSmall CLI that talks to harbourmaster.\n',
    branch: 'main',
    checkpoint: {
      summary: 'Added retry with backoff to the harbourmaster client.',
      next: ['document the retry behaviour'],
      blocked: null,
    },
  },
];

const scratch = await mkdtemp(join(tmpdir(), 'statenest-demo-'));
const home = join(scratch, 'home');
const code = join(scratch, 'code');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  STATENEST_HOME: join(home, '.statenest'),
  // A demo must never touch a real Claude Code configuration.
  CLAUDE_CONFIG_DIR: join(scratch, 'claude'),
  // Stable, colourful output regardless of how the recording is piped.
  FORCE_COLOR: '1',
  COLUMNS: '92',
};

const CLI = join(ROOT, 'dist', 'cli', 'bin.js');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function statenest(args, { cwd = code, show = true } = {}) {
  if (show) {
    process.stdout.write(`\n\u001b[38;5;250m$\u001b[0m \u001b[1mstatenest ${args.join(' ')}\u001b[0m\n`);
    await sleep(PAUSE / 3);
  }
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (show) {
    process.stdout.write(stdout);
    await sleep(PAUSE);
  }
  return stdout;
}

async function buildFixtures() {
  await mkdir(code, { recursive: true });
  for (const project of PROJECTS) {
    const path = join(code, project.dir);
    await mkdir(path, { recursive: true });
    const git = (args) => execFileAsync('git', args, { cwd: path, env });
    await git(['init', '--quiet', `--initial-branch=${project.branch}`]);
    await git(['remote', 'add', 'origin', project.remote]);
    await writeFile(join(path, 'README.md'), project.readme);
    await git(['add', '-A']);
    await git([
      '-c',
      'user.email=demo@example.invalid',
      '-c',
      'user.name=Demo',
      'commit',
      '-qm',
      'initial',
    ]);
  }
}

async function main() {
  process.stdout.write('\u001b[2J\u001b[H');

  await buildFixtures();
  // A fixed machine name, so a recording never shows the operator's own
  // hostname. `--no-claude` keeps the demo from touching any plugin config.
  await statenest(['init', '--yes', '--machine-name', 'workshop-laptop', '--no-claude'], {
    show: false,
  });
  await statenest(['scan', code], { show: false });

  for (const project of PROJECTS) {
    const path = join(code, project.dir);
    const args = ['checkpoint', '-m', project.checkpoint.summary];
    for (const next of project.checkpoint.next) args.push('--next', next);
    if (project.checkpoint.blocked) args.push('--blocked', project.checkpoint.blocked);
    await statenest(args, { cwd: path, show: false });
  }

  // A server and a deployment, so `where` has something to show.
  await statenest(
    ['remote', 'add', 'harbour-prod', '--host', 'harbour-prod.example.invalid', '--user', 'deploy'],
    { show: false },
  ).catch(() => {});
  await statenest(
    ['deploy', 'add', 'harbourmaster', '--remote', 'harbour-prod', '--path', '/srv/harbourmaster'],
    { show: false },
  ).catch(() => {});

  await statenest(['projects']);
  await statenest(['recent']);
  await statenest(['resume', 'tideline']);
  await statenest(['where', 'harbourmaster']);
  await statenest(['search', 'berth']);

  process.stdout.write('\n\u001b[38;5;250m# Everything above lived in a temp directory. Nothing was uploaded.\u001b[0m\n\n');
}

try {
  await main();
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
