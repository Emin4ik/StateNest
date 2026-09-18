#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = platform() === 'win32';

/**
 * Install the real tarball and drive the CLI, on whatever OS this is.
 *
 * `verify-package.mjs` does the deep inspection but assumes a POSIX shell.
 * This is the part that has to run on Windows too, so it is Node rather than
 * bash: path separators, the global bin layout and executable extensions all
 * differ, and encoding those differences in YAML is how a workflow ends up
 * passing on one runner and lying on another.
 *
 * Run with `npm run smoke:install`.
 */

let failures = 0;
const pass = (what, detail = '') => process.stdout.write(`  PASS  ${what}${detail ? ` — ${detail}` : ''}\n`);
const fail = (what, detail) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${what}\n        ${detail}\n`);
};

function check(what, condition, detail) {
  if (condition) pass(what, typeof detail === 'string' ? detail : '');
  else fail(what, detail ?? 'condition was false');
}

/**
 * Where `npm install -g --prefix P` actually puts the executable.
 *
 * POSIX puts it in `P/bin`; Windows puts the shim directly in `P`. Getting
 * this wrong is a "works on my machine" bug that only the other OS can find.
 */
function binaryPath(prefix, name) {
  const candidates = WINDOWS
    ? [join(prefix, `${name}.cmd`), join(prefix, `${name}.ps1`), join(prefix, name)]
    : [join(prefix, 'bin', name)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function main() {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'package.json'), 'utf8'));
  const name = Object.keys(pkg.bin)[0];

  process.stdout.write(`\nPackaged install smoke test — ${platform()} / node ${process.version}\n\n`);

  // --- pack --------------------------------------------------------------
  const { stdout: packOut } = await execFileAsync(
    'npm',
    ['pack', '--json', '--ignore-scripts'],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, shell: WINDOWS },
  );
  const tarball = join(ROOT, JSON.parse(packOut)[0].filename);
  check('tarball produced', existsSync(tarball), JSON.parse(packOut)[0].filename);

  const scratch = await mkdtemp(join(tmpdir(), 'statenest-smoke-'));
  const prefix = join(scratch, 'prefix');
  const home = join(scratch, 'home');
  const code = join(scratch, 'code');
  await mkdir(prefix, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(code, { recursive: true });

  try {
    // --- install ---------------------------------------------------------
    await execFileAsync(
      'npm',
      ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', tarball],
      { cwd: scratch, maxBuffer: 64 * 1024 * 1024, shell: WINDOWS },
    );

    const cli = binaryPath(prefix, name);
    check(`the ${name} binary was installed`, cli !== null, cli ?? `not found under ${prefix}`);
    if (!cli) return;

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      STATENEST_HOME: join(home, '.statenest'),
      // Never let a smoke test reach the real Claude Code configuration.
      CLAUDE_CONFIG_DIR: join(scratch, 'claude'),
    };

    /**
     * The installed package's own entry point.
     *
     * Windows global installs live in `<prefix>/node_modules`; POSIX puts them
     * in `<prefix>/lib/node_modules`.
     */
    const installedEntry = [
      join(prefix, 'lib', 'node_modules', name, 'dist', 'cli', 'bin.js'),
      join(prefix, 'node_modules', name, 'dist', 'cli', 'bin.js'),
    ].find((candidate) => existsSync(candidate));
    check('the installed package contains the CLI entry point', Boolean(installedEntry));
    if (!installedEntry) return;

    /**
     * Run the shim the user actually types.
     *
     * Only for arguments that contain no spaces: on Windows the shim is a
     * `.cmd`, which `execFile` can only reach through a shell, and `shell:
     * true` joins argv into one string *without quoting*. That is a real trap
     * and it cost a CI run — `-m "Adjusted the widget tolerances."` arrived as
     * four separate arguments.
     */
    const runShim = (args, options = {}) =>
      execFileAsync(cli, args, { cwd: code, env, shell: WINDOWS, maxBuffer: 32 * 1024 * 1024, ...options });

    /** Run the installed entry directly, so arguments survive verbatim. */
    const run = (args, options = {}) =>
      execFileAsync(process.execPath, [installedEntry, ...args], {
        cwd: code,
        env,
        maxBuffer: 32 * 1024 * 1024,
        ...options,
      });

    // --- the four required commands --------------------------------------
    const { stdout: version } = await runShim(['--version']);
    check('--version prints the package version (through the shim)', version.trim() === pkg.version, version.trim());

    const { stdout: help } = await runShim(['--help']);
    check('--help lists commands (through the shim)', help.includes('init') && help.includes('doctor'));

    await run(['init', '--yes']);
    check('init created the data directory', existsSync(join(home, '.statenest', 'config.yaml')));

    const { stdout: doctorOut } = await runShim(['doctor']).catch((error) => ({
      stdout: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }));
    check('doctor runs and reports checks', /Node\.js/.test(doctorOut) && /Data directory/.test(doctorOut));

    // --- a real project, end to end --------------------------------------
    const project = join(code, 'widget');
    await mkdir(project, { recursive: true });
    // No shell: git is a real executable on every platform, and a shell would
    // re-introduce the quoting problem above.
    const git = (args) => execFileAsync('git', args, { cwd: project, env });
    await git(['init', '--quiet', '--initial-branch=main']);
    await git(['remote', 'add', 'origin', 'git@github.com:acme/widget.git']);
    await writeFile(join(project, 'README.md'), '# widget\n');
    await git(['add', '-A']);
    await git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'initial']);

    await run(['scan', code]);
    const { stdout: projects } = await run(['projects']);
    check('scan registered the project and projects lists it', projects.includes('widget'));

    await run(['checkpoint', '-m', 'Adjusted the widget tolerances.', '--next', 'measure again'], {
      cwd: project,
    });
    const { stdout: resumeOut } = await run(['resume', 'widget'], { cwd: project });
    check('resume shows the checkpoint summary', resumeOut.includes('Adjusted the widget tolerances'));
    check('resume shows the next action', resumeOut.includes('measure again'));
    // Multi-word arguments must survive as single arguments, not be split on
    // spaces — the failure mode this script hit on Windows.
    check(
      'multi-word arguments arrive intact',
      resumeOut.includes('Adjusted the widget tolerances.') && !/\bthe\b.*\bwidget\b.*\btolerances\b/.test(
        resumeOut.replace('Adjusted the widget tolerances.', ''),
      ),
    );

    const { stdout: json } = await run(['projects', '--json']);
    check('--json emits parseable JSON', (() => {
      try {
        return Array.isArray(JSON.parse(json)) || typeof JSON.parse(json) === 'object';
      } catch {
        return false;
      }
    })());
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    await rm(tarball, { force: true }).catch(() => {});
  }

  process.stdout.write(
    failures === 0
      ? '\nPACKAGED INSTALL SMOKE TEST PASSED\n\n'
      : `\n${failures} check(s) FAILED\n\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
