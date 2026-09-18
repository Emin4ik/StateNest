import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_COMMAND, PACKAGE_NAME } from '../../src/core/metadata.js';

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Every test here spawns a process — `npm pack`, or node running a bundle.
 * Process startup is not bounded by vitest's 30s default on a busy machine, and
 * a timeout here reads as a packaging defect when it is really just load. The
 * assertions are unchanged; only the patience is.
 */
const PROCESS_TIMEOUT = 120_000;

/**
 * What actually ships.
 *
 * These exist because of a real bug: `.mcp.json` was missing from the
 * package's `files` list, so installing from npm produced a plugin with
 * working hooks and skills but **no MCP tools** — half-functional, with
 * nothing to indicate why. Nothing else in the suite could have caught it,
 * because everything else runs from the source tree where the file is present.
 *
 * `npm pack --dry-run --json` reports exactly the file list that would be
 * published, without publishing anything.
 */
/**
 * The published file list, computed once.
 *
 * Every assertion below asks the same question of the same artifact, so this
 * shells out to npm exactly once per run. It used to run per test: five `npm`
 * process starts competing with the rest of the suite, which pushed individual
 * tests past the 30s timeout on a loaded machine.
 */
let packedFilesPromise: Promise<string[]> | null = null;

function packedFiles(): Promise<string[]> {
  // `--ignore-scripts` skips prepack: the suite already built, and running a
  // full rebuild inside every assertion is slow and makes the listing depend
  // on build output reaching stdout.
  packedFilesPromise ??= execFileAsync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  ).then(({ stdout }) => {
    const report = JSON.parse(stdout) as { files: { path: string }[] }[];
    return report[0]!.files.map((file) => file.path);
  });
  return packedFilesPromise;
}

describe('the published package', () => {

  it('includes every file the Claude Code plugin needs to function', async () => {
    const files = await packedFiles();

    const required = [
      // Without the manifest there is no plugin at all.
      '.claude-plugin/plugin.json',
      // Without the marketplace, `pb integrate claude` cannot register it.
      '.claude-plugin/marketplace.json',
      // Without this, no hooks fire and no session context is injected.
      'hooks/hooks.json',
      // Without this, the MCP tools do not exist. This is the one that was missed.
      '.mcp.json',
      // The entry points the hooks and MCP server actually execute.
      'dist-plugin/hook.js',
      'dist-plugin/server.js',
      // The CLI.
      'dist/cli/bin.js',
    ];

    for (const file of required) {
      expect(files, `${file} must be published`).toContain(file);
    }
  }, PROCESS_TIMEOUT);

  it('includes every skill', async () => {
    const files = await packedFiles();
    for (const skill of [
      'resume',
      'checkpoint',
      'where',
      'recent',
      'projects',
      'status',
      'doctor',
    ]) {
      expect(files).toContain(`skills/${skill}/SKILL.md`);
    }
  }, PROCESS_TIMEOUT);

  it('publishes the data schemas', async () => {
    const files = await packedFiles();
    expect(files).toContain('schemas/project.schema.json');
    expect(files).toContain('schemas/checkpoint.schema.json');
  }, PROCESS_TIMEOUT);

  it('does not publish tests, source or development config', async () => {
    const files = await packedFiles();
    for (const unwanted of [
      'tests/',
      'src/',
      'docs/',
      '.github/',
      'tsconfig.json',
      'eslint.config.js',
      'vitest.config.ts',
    ]) {
      const leaked = files.filter((file) => file.startsWith(unwanted));
      expect(leaked, `${unwanted} should not be published`).toEqual([]);
    }
  }, PROCESS_TIMEOUT);

  it('declares the binaries it promises', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
    };
    // Derived, not hardcoded: renaming the package must not silently leave a
    // stale command name behind in the manifest.
    expect(Object.keys(manifest.bin).sort()).toEqual([CLI_COMMAND, PACKAGE_NAME].sort());

    const files = await packedFiles();
    for (const target of Object.values(manifest.bin)) {
      expect(files).toContain(target);
    }
  }, PROCESS_TIMEOUT);
});

/**
 * The hook and MCP server are executed by Claude Code from a plugin root that
 * has no `node_modules`. If either resolves a bare import at runtime, the
 * plugin dies before it does anything.
 */
describe('the plugin entry points are self-contained', () => {
  /**
   * Copy the bundles somewhere with no `node_modules` anywhere above them and
   * run them there.
   *
   * Scanning the bundle text for bare imports was tried first and was wrong:
   * it matched `import { Ajv } from 'ajv'` inside a bundled library's JSDoc
   * comment, while the real dependency was correctly inlined. Running the
   * thing is the only check that cannot be fooled by its own source.
   */
  async function isolatedPluginDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'pb-isolated-plugin-'));
    await cp(join(ROOT, 'dist-plugin'), join(dir, 'dist-plugin'), { recursive: true });
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it('the hook runs with no dependencies resolvable', async () => {
    const { dir, cleanup } = await isolatedPluginDir();
    try {
      const result = await execFileAsync(
        'node',
        [join(dir, 'dist-plugin', 'hook.js'), 'session-start'],
        { cwd: dir, timeout: 20_000 },
      );
      // Silence is correct outside a registered project; a module resolution
      // failure would have produced a non-zero exit and an ERR_MODULE_NOT_FOUND.
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    } finally {
      await cleanup();
    }
  }, PROCESS_TIMEOUT);

  it('the MCP server starts with no dependencies resolvable', async () => {
    const { dir, cleanup } = await isolatedPluginDir();
    try {
      const child = spawn('node', [join(dir, 'dist-plugin', 'server.js')], {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      let exited: number | null = null;
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('exit', (code) => (exited = code));

      // A stdio MCP server stays alive waiting on stdin. A bundling failure
      // exits immediately, before this window elapses.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const stillRunning = exited === null;
      child.kill();

      expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(stderr).not.toContain('Cannot find package');
      expect(stillRunning, `server exited with ${exited}: ${stderr}`).toBe(true);
    } finally {
      await cleanup();
    }
  }, PROCESS_TIMEOUT);
});
