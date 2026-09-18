import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspace } from '../../src/core/workspace.js';
import { LEGACY_HOME_DIR_NAME, legacyHomeDir } from '../../src/core/paths.js';
import { isBrainError } from '../../src/util/errors.js';
import { makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Data written before the project had a name.
 *
 * StateNest was built as "Project Brain" and never published under that name,
 * so no user has data in `~/.project-brain`. The author does. A rename that
 * silently behaves as though months of checkpoints never existed is not
 * acceptable from a tool whose entire promise is remembering things.
 *
 * The chosen behaviour is detection only: say it is there, say it has not been
 * touched, say the one command that moves it. No automatic migration, because
 * that would mean carrying a second directory layout forever to serve a name
 * nobody else ever used.
 */
describe('data from the previous name', () => {
  let home: TempDir;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await makeTempDir('statenest-legacy-');
    env = { ...process.env, HOME: home.path, USERPROFILE: home.path };
    delete env['STATENEST_HOME'];
  });

  afterEach(async () => {
    await home.cleanup();
  });

  async function writeLegacyHome() {
    const legacy = join(home.path, LEGACY_HOME_DIR_NAME);
    await mkdir(join(legacy, 'profiles', 'personal'), { recursive: true });
    await writeFile(join(legacy, 'config.yaml'), 'schema_version: 1\n');
    return legacy;
  }

  it('points at the old directory instead of pretending it is not there', async () => {
    await writeLegacyHome();

    const error = await Workspace.open({ env }).catch((caught: unknown) => caught);
    expect(isBrainError(error)).toBe(true);
    if (!isBrainError(error)) return;

    expect(error.code).toBe('NOT_INITIALIZED');
    expect(error.details.join('\n')).toContain('previous name');
    // The fix has to be the command that actually moves it.
    expect(error.hints.some((hint) => hint.startsWith('mv '))).toBe(true);
  });

  it('never reads or moves it', async () => {
    const legacy = await writeLegacyHome();
    await Workspace.open({ env }).catch(() => undefined);

    // Still exactly where it was, untouched.
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(join(legacy, 'config.yaml'), 'utf8')).resolves.toBe('schema_version: 1\n');
  });

  it('says nothing about it when there is nothing there', async () => {
    const error = await Workspace.open({ env }).catch((caught: unknown) => caught);
    expect(isBrainError(error)).toBe(true);
    if (!isBrainError(error)) return;

    expect(error.details.join('\n')).not.toContain('previous name');
    expect(error.hints).toContain('statenest init');
  });

  it('resolves the legacy path from the given environment, not the real home', () => {
    expect(legacyHomeDir(env)).toBe(join(home.path, LEGACY_HOME_DIR_NAME));
    expect(legacyHomeDir(env)).not.toContain(process.env['HOME'] ?? '/nonexistent-real-home');
  });
});
