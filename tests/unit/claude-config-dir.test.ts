import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir } from '../../src/integrations/claude/install.js';

/**
 * `CLAUDE_CONFIG_DIR` has to be honoured.
 *
 * It was not: `claudeHomeExists()` and `isPluginEnabled()` read
 * `~/.claude` unconditionally. Two consequences, the second worse than the
 * first. A user who relocates Claude Code's config — a setting Claude Code
 * itself supports — got `statenest doctor` reporting on a directory Claude Code does
 * not read. And CONTRIBUTING.md tells contributors to export this variable at a
 * scratch directory before testing an integration, "never your real ~/.claude";
 * that instruction was false, which is the most dangerous kind of documentation
 * because the person following it believes they are protected.
 */
describe('claudeConfigDir', () => {
  const original = process.env['CLAUDE_CONFIG_DIR'];

  beforeEach(() => {
    delete process.env['CLAUDE_CONFIG_DIR'];
  });

  afterEach(() => {
    if (original === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = original;
  });

  it('defaults to ~/.claude', () => {
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
  });

  it('uses CLAUDE_CONFIG_DIR when set', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/scratch-claude';
    expect(claudeConfigDir()).toBe('/tmp/scratch-claude');
  });

  it('ignores an empty or whitespace-only value', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '   ';
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
  });

  it('never returns the real home when redirected', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/scratch-claude';
    expect(claudeConfigDir()).not.toBe(join(homedir(), '.claude'));
  });
});
