import { beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { removeTree } from '../helpers/fixtures.js';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_COMMAND, PACKAGE_NAME } from '../../src/core/metadata.js';

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');

/**
 * On Windows the npm CLI is `npm.cmd`.
 *
 * `execFile` resolves an exact filename and does not try PATHEXT, so plain
 * `npm` fails with ENOENT there. Naming the file beats passing `shell: true`,
 * which would join argv into one string without quoting.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Every test here spawns a process — `npm pack`, or node running a bundle.
 * Process startup is not bounded by vitest's 30s default on a busy machine, and
 * a timeout here reads as a packaging defect when it is really just load. The
 * assertions are unchanged; only the patience is.
 */
const PROCESS_TIMEOUT = 120_000;

interface Manifest {
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
) as Manifest;

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
    NPM,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  ).then(({ stdout }) => {
    const report = JSON.parse(stdout) as { files: { path: string }[] }[];
    return report[0]!.files.map((file) => file.path);
  });
  return packedFilesPromise;
}

/**
 * Make sure there is a build to inspect.
 *
 * These tests verify build output, and nothing guaranteed it existed. The
 * suite passed for months on machines that happened to have a stale `dist/`
 * lying around, and failed on every platform the first time it ran in CI - on
 * a fresh clone, `npm test` ran before `npm run build`. Ordering between npm
 * scripts is exactly the kind of dependency that breaks again silently, so the
 * tests now build if they must rather than assume.
 */
beforeAll(async () => {
  const built = ['dist/cli/bin.js', 'dist-plugin/hook.js', 'dist-plugin/server.js'];
  if (built.every((file) => existsSync(join(ROOT, file)))) return;

  process.stdout.write('  (no build found — running `npm run build` first)\n');
  await execFileAsync(NPM, ['run', 'build'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });

  for (const file of built) {
    if (!existsSync(join(ROOT, file))) throw new Error(`build did not produce ${file}`);
  }
}, 300_000);

describe('the published package', () => {

  it('includes every file the Claude Code plugin needs to function', async () => {
    const files = await packedFiles();

    const required = [
      // Without the manifest there is no plugin at all.
      '.claude-plugin/plugin.json',
      // Without the marketplace, `statenest integrate claude` cannot register it.
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
    // Derived, not hardcoded: renaming the package must not silently leave a
    // stale command name behind in the manifest. Compared as a set, because the
    // command and the package name are allowed to be the same string - and once
    // they were, this assertion expected the key twice.
    expect(new Set(Object.keys(manifest.bin))).toEqual(new Set([CLI_COMMAND, PACKAGE_NAME]));

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
    const dir = await mkdtemp(join(tmpdir(), 'statenest-isolated-plugin-'));
    await cp(join(ROOT, 'dist-plugin'), join(dir, 'dist-plugin'), { recursive: true });
    // removeTree retries EBUSY: Windows will not unlink a file a just-killed
    // child process still has open, and reported it as a packaging failure.
    return { dir, cleanup: () => removeTree(dir) };
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
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn('node', [join(dir, 'dist-plugin', 'server.js')], {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      let exited: number | null = null;
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
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
      // Let the child die before deleting the files it has mapped, or Windows
      // refuses the unlink outright.
      if (child && child.exitCode === null) {
        await new Promise((resolve) => {
          child!.once('exit', resolve);
          setTimeout(resolve, 5_000);
        });
      }
      await cleanup();
    }
  }, PROCESS_TIMEOUT);
});

/**
 * What the published CLI is allowed to require at runtime.
 *
 * `@modelcontextprotocol/sdk` was a runtime dependency, and it alone pulled in
 * 90 transitive packages — an HTTP server stack, a JSON-schema validator, a
 * CORS implementation — for a tool that only ever speaks stdio. Nothing
 * reachable from the CLI imported it: the MCP server that actually ships is
 * `dist-plugin/server.js`, an esbuild bundle with no external imports at all.
 * Moving it to devDependencies took a real install from 94 packages to 4.
 *
 * That is only safe while it stays true. These tests fail the moment published
 * code starts importing something the package does not declare.
 */
describe('the published CLI declares everything it needs', () => {
  const DECLARED = new Set(Object.keys(manifest.dependencies ?? {}));

  /**
   * Bare specifiers in `tsc` output, which has no bundling to confuse us.
   *
   * Every pattern is anchored to a single line. A first attempt allowed the
   * match to span newlines and promptly "found" a dependency called
   * `.command(` inside a chained call expression — a scanner that reads string
   * literals as imports fails in whichever direction is least useful.
   */
  function bareImports(source: string): string[] {
    const found = new Set<string>();
    const patterns = [
      // import x from 'pkg';  /  export { y } from 'pkg';
      /^\s*(?:import|export)\b[^\n;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm,
      // import 'pkg';  (side-effect only)
      /^\s*import\s*['"]([^'"\n]+)['"]/gm,
      // the closing line of a multi-line named import
      /^\s*\}\s*from\s*['"]([^'"\n]+)['"]/gm,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1]!;
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        // Reduce `zod/v4` and `@scope/pkg/sub` to the package name.
        const parts = spec.split('/');
        found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
      }
    }
    return [...found];
  }

  it('imports nothing it has not declared as a runtime dependency', async () => {
    const files = (await packedFiles()).filter(
      (file) => file.startsWith('dist/') && file.endsWith('.js'),
    );
    expect(files.length, 'expected compiled output in the package').toBeGreaterThan(20);

    const undeclared = new Map<string, string>();
    for (const file of files) {
      for (const spec of bareImports(await readFile(join(ROOT, file), 'utf8'))) {
        if (!DECLARED.has(spec)) undeclared.set(spec, file);
      }
    }

    expect(
      [...undeclared].map(([spec, file]) => `${spec} (imported by ${file})`),
      'published code may only import declared runtime dependencies',
    ).toEqual([]);
  }, PROCESS_TIMEOUT);

  it('does not publish the unbundled MCP server', async () => {
    // It is the only thing that imported the SDK. If it comes back, so does the
    // 90-package dependency tree, and the `files` negation has stopped working.
    const files = await packedFiles();
    expect(files.filter((file) => file.startsWith('dist/mcp/'))).toEqual([]);
    // What replaces it must still be there.
    expect(files).toContain('dist-plugin/server.js');
  }, PROCESS_TIMEOUT);

  it('points only at files that exist', async () => {
    const files = new Set(await packedFiles());
    for (const target of Object.values(manifest.bin)) {
      expect(files, `bin target ${target} must be published`).toContain(target);
    }
    // `main`/`types` are deliberately absent: there is no library entry point,
    // and declaring one that was never built is how the old package advertised
    // an import that failed with ERR_MODULE_NOT_FOUND.
    const pkg = manifest as unknown as Record<string, unknown>;
    for (const field of ['main', 'types']) {
      if (pkg[field] !== undefined) {
        expect(files, `${field} points at ${String(pkg[field])}`).toContain(
          String(pkg[field]).replace(/^\.\//, ''),
        );
      }
    }
  }, PROCESS_TIMEOUT);
});
