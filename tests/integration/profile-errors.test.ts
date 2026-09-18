import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { isBrainError } from '../../src/util/errors.js';
import { makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Telling a missing profile apart from an unreadable one.
 *
 * Several machines sharing one profile all write `last_sync_at` into
 * profile.yaml, which makes it the record most likely to collide during sync.
 * While that rebase is unresolved the file holds conflict markers, and every
 * command used to answer `No profile named "personal". Available profiles:
 * personal` — two contradictory lines that send the user looking for data they
 * still have, and say nothing about the conflict that is actually the problem.
 */
describe('a profile that exists but cannot be read', () => {
  let home: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('sn-profile-err-');
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it('says the profile is unreadable, not missing', async () => {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await writeFile(workspace.profilePaths.profileFile, 'name: personal\n  bad: [indent\n');

    const error = await Workspace.open({ home: home.path, profile: 'personal' }).catch(
      (caught: unknown) => caught,
    );
    expect(isBrainError(error)).toBe(true);
    if (!isBrainError(error)) return;

    expect(error.code).toBe('UNREADABLE_PROFILE');
    expect(error.message).toContain('could not be read');
    expect(error.message).not.toContain('No profile named');
    expect(error.details.join('\n')).toContain('profile.yaml');
  });

  it('names the sync conflict when the file holds merge markers', async () => {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    await writeFile(
      workspace.profilePaths.profileFile,
      [
        'schema_version: 1',
        'name: personal',
        'sync:',
        '<<<<<<< HEAD',
        '  last_sync_at: 2026-09-18T10:00:00Z',
        '=======',
        '  last_sync_at: 2026-09-18T11:00:00Z',
        '>>>>>>> 1234567 (Update 1 record)',
        '',
      ].join('\n'),
    );

    const error = await Workspace.open({ home: home.path, profile: 'personal' }).catch(
      (caught: unknown) => caught,
    );
    expect(isBrainError(error)).toBe(true);
    if (!isBrainError(error)) return;

    expect(error.details.join('\n')).toContain('unresolved merge conflict markers');
    // The advice has to be something the user can run.
    const hints = error.hints.join('\n');
    expect(hints).toContain('rebase --continue');
    expect(hints).toContain('rebase --abort');
    expect(hints).toContain('profile.yaml');
  });

  it('still reports a genuinely missing profile as missing', async () => {
    await Workspace.initialize({ home: home.path, profileName: 'personal' });

    const error = await Workspace.open({ home: home.path, profile: 'nonexistent' }).catch(
      (caught: unknown) => caught,
    );
    expect(isBrainError(error)).toBe(true);
    if (!isBrainError(error)) return;

    expect(error.code).toBe('UNKNOWN_PROFILE');
    expect(error.message).toContain('No profile named "nonexistent"');
    expect(error.details.join('\n')).toContain('Available profiles: personal');
  });

  it('opens normally when the profile is fine', async () => {
    await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const opened = await Workspace.open({ home: home.path, profile: 'personal' });
    expect(opened.profile.name).toBe('personal');
  });
});
