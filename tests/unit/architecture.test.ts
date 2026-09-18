import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The dependency direction, enforced rather than merely documented.
 *
 * "Claude Code is the first adapter, not the architecture" is a claim the
 * README, the architecture docs and llms.txt all make in public. Until now
 * nothing checked it, so it could have quietly stopped being true — and the
 * way it would stop being true is the ordinary one: somebody needs a value
 * that happens to live in the adapter, imports it, and everything still works.
 *
 * Deliberately a regex over the source rather than a dependency-analysis
 * framework. The rule is coarse ("these directories must not name that one"),
 * the source is small, and a test that needs a build step to run is a test that
 * gets skipped.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Layers that must stay unaware of any particular agent. */
const CORE_LAYERS = ['core', 'storage', 'sync', 'checkpoints', 'git', 'discovery', 'security'];

/** What they must not reach into. */
const FORBIDDEN = /(?:from|import)\s*\(?\s*['"][^'"]*integrations\//;

async function typescriptFilesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // A layer that does not exist cannot violate anything.
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

describe('architecture', () => {
  it('core layers do not import any agent integration', async () => {
    const violations: string[] = [];

    for (const layer of CORE_LAYERS) {
      for (const file of await typescriptFilesIn(join(SRC, layer))) {
        const source = await readFile(file, 'utf8');
        for (const [index, line] of source.split('\n').entries()) {
          // Both static imports and the lazy `await import()` form.
          if (FORBIDDEN.test(line)) {
            violations.push(`${relative(SRC, file)}:${index + 1}  ${line.trim()}`);
          }
        }
      }
    }

    expect(
      violations,
      `These files import an agent integration from a layer that must not know one exists.\n` +
        `Move the shared code into core, or invert the call so the adapter depends on core.\n\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('actually inspects the source it claims to', async () => {
    // A guard that silently matched nothing would pass forever. Prove the
    // walker finds files and the pattern can fire.
    const coreFiles = await typescriptFilesIn(join(SRC, 'core'));
    expect(coreFiles.length).toBeGreaterThan(3);

    expect(FORBIDDEN.test("import { runHook } from '../../integrations/claude/handlers.js';")).toBe(
      true,
    );
    expect(FORBIDDEN.test("const m = await import('../integrations/claude/install.js');")).toBe(
      true,
    );
    expect(FORBIDDEN.test("import { Registry } from '../core/registry.js';")).toBe(false);
  });

  it('the adapter does depend on core, which is the direction that is allowed', async () => {
    const adapter = await readFile(join(SRC, 'integrations', 'claude', 'handlers.ts'), 'utf8');
    expect(adapter).toMatch(/from '\.\.\/\.\.\/core\//);
  });
});
