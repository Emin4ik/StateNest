import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledPluginVersion,
  installedPluginVersion,
} from '../../src/integrations/claude/install.js';

/**
 * Knowing which plugin Claude Code is actually running.
 *
 * `claude plugin install` **copies** the plugin into
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Upgrading the npm
 * package therefore does not update it: Claude Code keeps running the copy it
 * took last time, and before this existed nothing said so.
 *
 * A stale copy is at least self-consistent - the hooks, the MCP server and the
 * skills that name its tools all live in that one directory and were copied
 * together - so an old install works, it is simply old. Which is exactly why it
 * needs detecting rather than surviving on the assumption that something would
 * visibly break.
 */
describe('installed plugin version', () => {
  let config: string;
  const original = process.env['CLAUDE_CONFIG_DIR'];

  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), 'sn-plugin-ver-'));
    process.env['CLAUDE_CONFIG_DIR'] = config;
    await mkdir(join(config, 'plugins'), { recursive: true });
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = original;
    await rm(config, { recursive: true, force: true });
  });

  const writeInstalled = (contents: unknown) =>
    writeFile(
      join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify(contents, null, 2),
    );

  it('reads the version out of the real Claude Code file shape', async () => {
    // Observed from a real installation at Claude Code 2.1.273.
    await writeInstalled({
      version: 2,
      plugins: {
        'frontend-design@claude-plugins-official': [
          { scope: 'user', installPath: '/somewhere', version: '1aa8f02ec832' },
        ],
        'statenest@statenest': [
          {
            scope: 'user',
            installPath: '/Users/x/.claude/plugins/cache/statenest/statenest/0.1.0',
            version: '0.1.0',
            installedAt: '2026-09-18T11:10:04.769Z',
          },
        ],
      },
    });

    expect(await installedPluginVersion()).toBe('0.1.0');
  });

  it('ignores the placeholder version an unversioned install records', async () => {
    // A directory marketplace with no version in its manifest records
    // "unknown". Treating that as a version would produce a permanent, useless
    // "you are out of date" warning.
    await writeInstalled({
      version: 2,
      plugins: {
        'statenest@statenest': [{ scope: 'user', version: 'unknown' }],
      },
    });

    expect(await installedPluginVersion()).toBeNull();
  });

  it('returns null rather than guessing when the file is absent or unreadable', async () => {
    expect(await installedPluginVersion()).toBeNull();

    await writeFile(join(config, 'plugins', 'installed_plugins.json'), '{ not json');
    expect(await installedPluginVersion()).toBeNull();

    // A shape Claude Code might move to one day. Unknown must mean unknown.
    await writeInstalled({ version: 3, entries: [] });
    expect(await installedPluginVersion()).toBeNull();
  });

  it('does not confuse another plugin whose name merely starts the same way', async () => {
    await writeInstalled({
      version: 2,
      plugins: {
        'statenest-extras@somewhere': [{ scope: 'user', version: '9.9.9' }],
      },
    });

    // Matching is on `statenest@`, not on a bare prefix.
    expect(await installedPluginVersion()).toBeNull();
  });

  it('reads the bundled version from the plugin manifest', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'sn-plugin-dir-'));
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'statenest', version: '0.2.0' }),
    );

    expect(await bundledPluginVersion(pluginDir)).toBe('0.2.0');
    expect(await bundledPluginVersion(null)).toBeNull();
    await rm(pluginDir, { recursive: true, force: true });
  });

  it('the shipped manifest and package.json agree', async () => {
    // The two versions are what the upgrade check compares. If they can drift,
    // the check either nags forever or never fires.
    // fileURLToPath, not URL.pathname: a repository path containing a space
    // comes back percent-encoded from the latter and then fails to open.
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };

    expect(await bundledPluginVersion(root)).toBe(pkg.version);
  });
});
