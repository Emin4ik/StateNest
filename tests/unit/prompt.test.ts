import { describe, expect, it } from 'vitest';
import { confirm } from '../../src/cli/prompt.js';

/**
 * `--yes` has to mean yes.
 *
 * It used to mean "assume the default". Every prompt guarding something
 * destructive or outbound sensibly defaults to no, so `statenest import --yes`,
 * `statenest export --yes`, `statenest add --yes` and `statenest sync init --yes` all printed
 * "Cancelled. Nothing was changed." and exited 0 — the flag did the opposite of
 * what it said, silently, and succeeded while doing it.
 *
 * These run under vitest, where stdin is not a TTY, so they also pin the
 * non-interactive behaviour: without explicit authorisation, take the cautious
 * default rather than guessing.
 */
describe('confirm', () => {
  it('returns true for --yes even when the default is no', async () => {
    await expect(confirm('destroy everything?', { defaultValue: false, assumeYes: true })).resolves.toBe(
      true,
    );
  });

  it('returns true for --yes when the default is yes', async () => {
    await expect(confirm('proceed?', { defaultValue: true, assumeYes: true })).resolves.toBe(true);
  });

  it('takes the cautious default when non-interactive and not authorised', async () => {
    await expect(confirm('destroy everything?', { defaultValue: false })).resolves.toBe(false);
  });

  it('takes a permissive default when non-interactive and not authorised', async () => {
    await expect(confirm('proceed?', { defaultValue: true })).resolves.toBe(true);
  });

  it('defaults to yes when no default is given', async () => {
    await expect(confirm('proceed?')).resolves.toBe(true);
  });
});
