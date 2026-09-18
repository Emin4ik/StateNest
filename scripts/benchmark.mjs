#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Performance at realistic scale.
 *
 * The number that matters most is SessionStart: it delays the model's first
 * response one-for-one in every Claude Code session, so a regression there is
 * felt constantly. Everything else is user-initiated and has a far larger
 * budget.
 *
 * Deliberately NOT wired into CI as a hard gate. Timings on shared runners are
 * noisy enough that a threshold tight enough to catch a real regression would
 * also fail at random, and a flaky gate gets disabled. This runs on demand,
 * prints a table, and flags anything past a generous ceiling.
 *
 * Run with `npm run bench`.
 */

const SCALES = [10, 50, 100, 500];

// Generous ceilings: a real regression is an order of magnitude, not 20%.
const CEILINGS = {
  sessionStart: 400,
  scan: 5_000,
  projects: 1_500,
  recent: 2_000,
  search: 2_000,
  resume: 1_500,
};

const { Workspace } = await import(`${ROOT}/dist/core/workspace.js`);
const { Registry } = await import(`${ROOT}/dist/core/registry.js`);
const { createCheckpoint } = await import(`${ROOT}/dist/checkpoints/create.js`);
const { scanForProjects } = await import(`${ROOT}/dist/discovery/scanner.js`);

async function fakeRepo(path, remote, branch = 'main') {
  await mkdir(join(path, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    join(path, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n`,
  );
  await writeFile(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  await writeFile(join(path, '.git', 'refs', 'heads', branch), `${'a'.repeat(40)}\n`);
  await writeFile(join(path, 'README.md'), `# ${remote}\n\nA generated fixture project.\n`);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1],
  };
}

async function measure(fn, runs = 7) {
  await fn(); // warm
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return stats(samples);
}

/** The real hook, as a real process - the only honest way to measure it. */
function measureSessionStart(home, cwd, runs = 15) {
  const payload = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: 'bench',
    cwd,
    source: 'startup',
  });

  const once = () =>
    new Promise((resolveRun) => {
      const started = process.hrtime.bigint();
      const child = spawn('node', [join(ROOT, 'dist-plugin', 'hook.js'), 'session-start'], {
        env: { ...process.env, PROJECT_BRAIN_HOME: home },
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('close', () =>
        resolveRun({ ms: Number(process.hrtime.bigint() - started) / 1e6, bytes: out.length }),
      );
      child.stdin.end(payload);
    });

  return (async () => {
    await once();
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < runs; i++) {
      const result = await once();
      samples.push(result.ms);
      bytes = result.bytes;
    }
    return { ...stats(samples), bytes };
  })();
}

const rows = [];
const warnings = [];

process.stdout.write('\nProject Brain benchmarks\n');

for (const scale of SCALES) {
  const workspaceDir = await mkdtemp(join(tmpdir(), `pb-bench-${scale}-`));
  const home = join(workspaceDir, 'home');
  const code = join(workspaceDir, 'code');

  try {
    await mkdir(code, { recursive: true });
    for (let i = 0; i < scale; i++) {
      await fakeRepo(join(code, `project-${i}`), `git@github.com:acme/project-${i}.git`);
    }

    const workspace = await Workspace.initialize({ home });
    const registry = new Registry(workspace.store);

    const scanTiming = await measure(() => scanForProjects([code]), 3);

    for (const candidate of (await scanForProjects([code])).candidates) {
      await registry.register(candidate.path, { machineId: workspace.machineId });
    }

    // Checkpoint history: heavier on the first few projects, as in real use.
    const projects = await registry.all();
    const checkpointsPerProject = 20;
    for (const project of projects.slice(0, Math.min(10, projects.length))) {
      for (let i = 0; i < checkpointsPerProject; i++) {
        await createCheckpoint(
          workspace.store,
          project,
          {
            summary: `Checkpoint ${i}: reworked the preprocessing pass and retuned thresholds.`,
            completed: ['adaptive letterboxing', 'threshold 0.25 to 0.4', 'regression fixtures'],
            next: ['re-benchmark the iOS build'],
            blockers: ['the CI runner has no GPU'],
          },
          {
            machineId: workspace.machineId,
            source: 'cli',
            timestamp: `2026-0${(i % 9) + 1}-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
          },
        );
      }
    }

    const { buildRecent, buildResumeBrief } = await import(`${ROOT}/dist/core/context.js`);
    const { search } = await import(`${ROOT}/dist/search/search.js`);

    const listTiming = await measure(async () => new Registry(workspace.store).all());
    const recentTiming = await measure(async () =>
      buildRecent(workspace.store, await new Registry(workspace.store).all(), { limit: 15 }),
    );
    const searchTiming = await measure(async () =>
      search(workspace.store, await new Registry(workspace.store).all(), 'letterboxing'),
    );
    const resumeTiming = await measure(async () =>
      buildResumeBrief(workspace.store, projects[0], {
        machineId: workspace.machineId,
        checkpointLimit: 5,
      }),
    );

    const hook = await measureSessionStart(home, join(code, 'project-0'));

    rows.push({
      scale,
      checkpoints: Math.min(10, projects.length) * checkpointsPerProject,
      scan: scanTiming.p50,
      projects: listTiming.p50,
      recent: recentTiming.p50,
      search: searchTiming.p50,
      resume: resumeTiming.p50,
      sessionStart: hook.p50,
      sessionStartP90: hook.p90,
      briefBytes: hook.bytes,
    });

    for (const [key, ceiling] of Object.entries(CEILINGS)) {
      const value = key === 'sessionStart' ? hook.p50 : rows[rows.length - 1][key];
      if (value > ceiling) {
        warnings.push(`${key} at ${scale} projects: ${value.toFixed(0)}ms exceeds ${ceiling}ms`);
      }
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

const header = [
  'projects',
  'checkpoints',
  'scan',
  'pb projects',
  'pb recent',
  'pb search',
  'resume',
  'SessionStart p50',
  'p90',
  'brief',
];
const widths = [8, 11, 8, 11, 9, 9, 8, 16, 6, 7];

process.stdout.write('\n  ' + header.map((h, i) => h.padEnd(widths[i])).join('') + '\n');
for (const row of rows) {
  const cells = [
    String(row.scale),
    String(row.checkpoints),
    `${row.scan.toFixed(0)}ms`,
    `${row.projects.toFixed(0)}ms`,
    `${row.recent.toFixed(0)}ms`,
    `${row.search.toFixed(0)}ms`,
    `${row.resume.toFixed(0)}ms`,
    `${row.sessionStart.toFixed(0)}ms`,
    `${row.sessionStartP90.toFixed(0)}ms`,
    `${row.briefBytes}B`,
  ];
  process.stdout.write('  ' + cells.map((c, i) => c.padEnd(widths[i])).join('') + '\n');
}

process.stdout.write(
  '\n  SessionStart is measured as a real process, so it includes Node startup\n' +
    '  (about 40ms on this machine). It is the only timing a user feels on every\n' +
    '  single session.\n',
);

if (warnings.length > 0) {
  process.stdout.write('\n  Over the expected ceiling:\n');
  for (const warning of warnings) process.stdout.write(`    ${warning}\n`);
  process.stdout.write('\n');
  process.exit(1);
}

process.stdout.write('\n  All measurements within expected ceilings.\n\n');
