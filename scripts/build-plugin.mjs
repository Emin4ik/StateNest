#!/usr/bin/env node
import { build } from 'esbuild';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundle the two entry points Claude Code executes.
 *
 * Claude Code runs a plugin's hook and MCP commands directly from
 * `${CLAUDE_PLUGIN_ROOT}`, and there is no guarantee that a `node_modules`
 * exists there: a plugin installed in place from a local-directory marketplace
 * gets no dependency install at all, and the hook then dies with
 * ERR_MODULE_NOT_FOUND before it can do anything useful. This was observed,
 * not theorised - see docs/adr/0006.
 *
 * Bundling removes the entire failure mode: these two files resolve nothing at
 * runtime. It also cuts session-start latency, because Node walks one module
 * instead of a dependency graph.
 *
 * The CLI is deliberately NOT bundled. It is installed through npm, where
 * dependencies are guaranteed, and keeping it unbundled means stack traces
 * point at real source files.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-plugin');

const ENTRY_POINTS = [
  { in: join(root, 'src/integrations/claude/hook.ts'), out: 'hook' },
  { in: join(root, 'src/mcp/server.ts'), out: 'server' },
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: ENTRY_POINTS,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Matches the engines floor in package.json.
  target: 'node22.12',
  // Code splitting keeps the lazy `import()` calls in the hook genuinely lazy.
  // Inlining them into one file would parse and evaluate zod and yaml on every
  // session start, for handlers that do not run.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  banner: {
    // Bundled dependencies still reach for CommonJS globals in places.
    js: [
      "import { createRequire as __pbCreateRequire } from 'node:module';",
      'const require = __pbCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

await chmod(join(outDir, 'hook.js'), 0o755).catch(() => {});
await chmod(join(outDir, 'server.js'), 0o755).catch(() => {});

const sizes = Object.entries(result.metafile.outputs)
  .map(([file, meta]) => `${file.replace(`${root}/`, '')}  ${(meta.bytes / 1024).toFixed(0)}KB`)
  .sort();

process.stdout.write(`Bundled plugin entry points:\n  ${sizes.join('\n  ')}\n`);
