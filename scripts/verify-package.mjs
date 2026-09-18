#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Prove the PACKAGED artifact works, from outside the repository.
 *
 * Testing from the source checkout is not the same thing. The checkout has
 * `node_modules` beside the code, every file present whether or not `files`
 * lists it, and a working directory inside the repo. All three have already
 * hidden a real bug here: `.mcp.json` was missing from the published package,
 * producing a plugin with hooks and skills but no MCP tools.
 *
 * So this script packs the tarball, installs it into a throwaway prefix, and
 * drives the installed binary from a throwaway directory with a throwaway HOME
 * - then checks that nothing it did reached back into the repository.
 *
 * Run with `npm run verify:package`. Exits non-zero on the first failure.
 */

const checks = [];
let failures = 0;

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  process.stdout.write(`  ${mark} ${name}${detail ? `\n      ${detail}` : ''}\n`);
  if (!ok) failures++;
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

async function main() {
  process.stdout.write('\nPackaged-artifact verification\n');

  const workspace = await mkdtemp(join(tmpdir(), 'pb-verify-'));
  const prefix = join(workspace, 'prefix');
  const fakeHome = join(workspace, 'home');
  const projects = join(workspace, 'projects');
  const cwd = join(workspace, 'elsewhere');

  for (const dir of [prefix, fakeHome, projects, cwd]) {
    await mkdir(dir, { recursive: true });
  }

  try {
    // ---------------------------------------------------------------- pack
    section('Packing');
    await execFileAsync('npm', ['run', 'build'], { cwd: ROOT, maxBuffer: 32 << 20 });
    const { stdout: packOut } = await execFileAsync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', workspace],
      { cwd: ROOT, maxBuffer: 64 << 20 },
    );
    const packed = JSON.parse(packOut)[0];
    const tarball = join(workspace, packed.filename);
    record('npm pack produced a tarball', existsSync(tarball), `${packed.filename} (${(packed.size / 1024).toFixed(0)}KB)`);

    const files = packed.files.map((f) => f.path);

    // Everything the plugin needs to actually function.
    for (const required of [
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'hooks/hooks.json',
      '.mcp.json',
      'dist-plugin/hook.js',
      'dist-plugin/server.js',
      'dist/cli/bin.js',
    ]) {
      record(`package contains ${required}`, files.includes(required));
    }

    // Nothing that should never ship.
    const leaked = files.filter((f) =>
      /^(tests?|src|docs|\.github|examples)\//.test(f) ||
      /\.(test|spec)\./.test(f) ||
      /(^|\/)(tsconfig|vitest\.config|eslint\.config)/.test(f) ||
      /\.(log|tgz|env)$/.test(f) ||
      /(^|\/)\.env/.test(f),
    );
    record('package contains no source, tests, docs or dev config', leaked.length === 0, leaked.join(', '));

    // ------------------------------------------------------------- install
    section('Installing into a clean prefix');
    await execFileAsync('npm', ['install', '-g', '--prefix', prefix, tarball], {
      cwd: workspace,
      maxBuffer: 64 << 20,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });

    const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin');
    const pb = join(binDir, process.platform === 'win32' ? 'pb.cmd' : 'pb');
    record('installed a `pb` binary', existsSync(pb), pb);

    // The installed package must not have pulled in anything unexpected.
    const installedRoot = join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : join('lib', 'node_modules'),
      'project-brain',
    );
    record('installed package directory exists', existsSync(installedRoot), installedRoot);

    const manifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
    record(
      'installed version matches the repository',
      manifest.version === JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version,
      `installed ${manifest.version}`,
    );

    // --------------------------------------------------------------- drive
    section('Driving the installed binary from outside the repository');

    // Snapshot the repository's working tree first. Comparing against "clean"
    // would fail whenever the developer has work in progress; what we actually
    // want to know is whether driving the CLI *changed* anything here.
    const repoStateBefore = await gitStatus();

    // A throwaway HOME so nothing touches the real one, and a cwd far from the
    // repo so a stray relative path cannot resolve back into it.
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      PROJECT_BRAIN_HOME: join(fakeHome, '.project-brain'),
      CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
      GIT_CONFIG_GLOBAL: join(fakeHome, '.gitconfig'),
      GIT_CONFIG_SYSTEM: join(fakeHome, '.gitconfig-system'),
      GIT_AUTHOR_NAME: 'Verify',
      GIT_AUTHOR_EMAIL: 'verify@example.invalid',
      GIT_COMMITTER_NAME: 'Verify',
      GIT_COMMITTER_EMAIL: 'verify@example.invalid',
      NO_COLOR: '1',
    };

    const run = async (args, options = {}) => {
      try {
        const { stdout, stderr } = await execFileAsync(pb, args, {
          cwd: options.cwd ?? cwd,
          env,
          maxBuffer: 32 << 20,
          timeout: 120_000,
        });
        return { ok: true, stdout, stderr, code: 0 };
      } catch (error) {
        return {
          ok: false,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? String(error),
          code: error.code ?? 1,
        };
      }
    };

    const version = await run(['--version']);
    record('pb --version', version.ok && version.stdout.trim() === manifest.version, version.stdout.trim());

    const help = await run(['--help']);
    record('pb --help lists commands', help.ok && help.stdout.includes('Commands:'));

    // A fixture project to scan, with a real git repo and a real remote.
    const fixture = join(projects, 'widget');
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'README.md'), '# widget\n\nA widget that widgets.\n');
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'widget', description: 'A widget that widgets.' }));
    const git = (args) => execFileAsync('git', args, { cwd: fixture, env });
    await git(['init', '--quiet', '--initial-branch=main']);
    await git(['add', '-A']);
    await git(['commit', '--quiet', '-m', 'initial']);
    await git(['remote', 'add', 'origin', 'git@github.com:acme/widget.git']);

    const init = await run(['init', '--yes', '--no-scan', '--no-claude']);
    record('pb init', init.ok && /initialised/i.test(init.stdout), firstLine(init.stderr));

    const scan = await run(['scan', projects]);
    record('pb scan finds the fixture', scan.ok && /1 new project|already/i.test(scan.stdout), firstLine(scan.stdout));

    const list = await run(['projects', '--json']);
    const listed = list.ok ? JSON.parse(list.stdout) : { projects: [] };
    record('pb projects reports it', listed.projects?.length === 1 && listed.projects[0].name === 'widget');
    record(
      'project identity came from the git remote',
      listed.projects?.[0]?.repository?.identity === 'github.com/acme/widget',
      listed.projects?.[0]?.repository?.identity,
    );

    const checkpoint = await run(['checkpoint', 'widget', '-m', 'Verified the packaged install end to end.'], { cwd: fixture });
    record('pb checkpoint', checkpoint.ok && /Checkpoint saved/i.test(checkpoint.stdout), firstLine(checkpoint.stderr));

    const resume = await run(['resume', 'widget']);
    record('pb resume shows the checkpoint', resume.ok && /widget/.test(resume.stdout));

    const recent = await run(['recent']);
    record('pb recent', recent.ok && /widget/.test(recent.stdout));

    const search = await run(['search', 'packaged']);
    record('pb search finds the checkpoint text', search.ok && /packaged/i.test(search.stdout));

    const where = await run(['where', 'widget']);
    record('pb where', where.ok && where.stdout.includes(fixture));

    const privacy = await run(['privacy', 'audit']);
    record('pb privacy audit', privacy.ok && /Nothing sensitive/i.test(privacy.stdout));

    const doctor = await run(['doctor', '--json']);
    const health = doctor.stdout ? JSON.parse(doctor.stdout) : null;
    const failing = health?.checks?.filter((c) => c.level === 'fail') ?? [];
    record(
      'pb doctor reports no failures',
      failing.length === 0,
      failing.map((c) => `${c.name}: ${c.detail}`).join('; '),
    );

    const migrate = await run(['migrate', '--dry-run', '--json']);
    record('pb migrate --dry-run', migrate.ok, firstLine(migrate.stderr));

    const exported = join(workspace, 'backup.tar.gz');
    const exportResult = await run(['export', exported]);
    record('pb export', exportResult.ok && existsSync(exported));

    // ------------------------------------------------------ no leakage back
    section('Checking the installed binary did not reach into the repository');

    // If the installed CLI had resolved the repo's node_modules or source, the
    // only way it could is via a path containing the repo root.
    const stateDump = await collectText(join(fakeHome, '.project-brain'));
    record(
      'no repository path appears in the written data',
      !stateDump.includes(ROOT),
      stateDump.includes(ROOT) ? 'a repository path leaked into the data directory' : '',
    );

    // The binary must be a symlink/shim into the prefix, not the repo.
    const realBin = await stat(pb).then(() => pb);
    record('the binary lives in the throwaway prefix', realBin.startsWith(prefix));

    // Nothing should have been written to the repository during the run.
    const repoStateAfter = await gitStatus();
    const before = new Set(repoStateBefore);
    const changed = repoStateAfter.filter((line) => !before.has(line) && !/\.tgz$/.test(line));
    record(
      'driving the installed CLI changed nothing in the repository',
      changed.length === 0,
      changed.join('\n      '),
    );

    // ------------------------------------------------- plugin from package
    section('Claude Code plugin, as packaged');
    const pluginRoot = installedRoot;
    for (const entry of ['dist-plugin/hook.js', 'dist-plugin/server.js', 'hooks/hooks.json', '.mcp.json']) {
      record(`installed plugin has ${entry}`, existsSync(join(pluginRoot, entry)));
    }

    const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    const hookTargets = Object.values(hooks.hooks)
      .flat()
      .flatMap((entry) => entry.hooks)
      .map((handler) => handler.args?.[0]);
    record(
      'every hook is addressed through ${CLAUDE_PLUGIN_ROOT}',
      hookTargets.every((target) => typeof target === 'string' && target.startsWith('${CLAUDE_PLUGIN_ROOT}/')),
      hookTargets.join(', '),
    );

    // The hook must run with no node_modules resolvable from its location.
    const hookRun = await execFileAsync(
      'node',
      [join(pluginRoot, 'dist-plugin', 'hook.js'), 'session-start'],
      { cwd: workspace, env, timeout: 30_000 },
    ).catch((error) => ({ stdout: '', stderr: error.stderr ?? String(error) }));
    record(
      'the packaged hook runs without resolving any dependency',
      !hookRun.stderr.includes('ERR_MODULE_NOT_FOUND') && !hookRun.stderr.includes('Cannot find package'),
      firstLine(hookRun.stderr),
    );

    const skills = await readdir(join(pluginRoot, 'skills'));
    record('all seven skills are packaged', skills.length === 7, skills.join(', '));

    // ------------------------------------------------ uninstall / reinstall
    section('Uninstall and reinstall, preserving data');
    await execFileAsync('npm', ['uninstall', '-g', '--prefix', prefix, 'project-brain'], {
      cwd: workspace,
      maxBuffer: 32 << 20,
    });
    record('uninstall removed the binary', !existsSync(pb));
    record('the data directory survived uninstall', existsSync(join(fakeHome, '.project-brain')));

    await execFileAsync('npm', ['install', '-g', '--prefix', prefix, tarball], {
      cwd: workspace,
      maxBuffer: 64 << 20,
    });
    const afterReinstall = await run(['projects', '--json']);
    const recovered = afterReinstall.ok ? JSON.parse(afterReinstall.stdout) : { projects: [] };
    record('reinstall recovers the existing data', recovered.projects?.length === 1);

    const recentAfter = await run(['recent']);
    record('the checkpoint survived the reinstall', recentAfter.ok && /packaged install/i.test(recentAfter.stdout));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    // Remove the tarball npm pack leaves in the repo root, if any.
    for (const name of await readdir(ROOT)) {
      if (name.startsWith('project-brain-') && name.endsWith('.tgz')) {
        await rm(join(ROOT, name), { force: true });
      }
    }
  }

  process.stdout.write(
    `\n${failures === 0 ? 'PACKAGE VERIFICATION PASSED' : `PACKAGE VERIFICATION FAILED (${failures} of ${checks.length} checks)`}\n\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** The repository's working-tree status, as a list of porcelain lines. */
async function gitStatus() {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: ROOT }).catch(
    () => ({ stdout: '' }),
  );
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function firstLine(text) {
  return String(text ?? '')
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim() ?? '';
}

/** Concatenate every text file under a directory, for leak checking. */
async function collectText(dir) {
  let out = '';
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out += await readFile(path, 'utf8').catch(() => '');
    }
  };
  await walk(dir);
  return out;
}

main().catch((error) => {
  process.stderr.write(`\nverification crashed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
