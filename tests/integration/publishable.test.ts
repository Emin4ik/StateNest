import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-publishable.mjs');

const OUR_REPO = 'git+https://github.com/Emin4ik/StateNest.git';

/**
 * The gate that decides whether the release workflow may publish.
 *
 * Exercised as a subprocess, because that is exactly how
 * .github/workflows/release.yml runs it — the exit code is the contract, and a
 * unit test of an extracted function would not prove the script exits the way
 * the workflow depends on.
 *
 * The bootstrap exception exists because npm refuses to configure a trusted
 * publisher for a package that does not exist, so the first version has to be
 * published by hand. Without the exception, tagging v0.1.0 afterwards would
 * make the first public release produce a deliberately failed workflow run.
 * With it, the danger is the opposite one: an exception that quietly swallows
 * real duplicates. These tests exist to pin the line between the two.
 */
async function run(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const published = (repository: string, version = '0.1.0') =>
  JSON.stringify({ version, repository: { url: repository } });

describe('the release publish gate', () => {
  describe('an unpublished version', () => {
    it('is publishable', async () => {
      const { code, out } = await run([
        '--version', '0.1.0', '--bootstrap', '0.1.0', '--published', 'none',
      ]);
      expect(code).toBe(0);
      expect(out).toContain('decision=publish');
    });

    it('is publishable even when no bootstrap version is configured', async () => {
      const { code, out } = await run([
        '--version', '0.2.0', '--bootstrap', '', '--published', 'none',
      ]);
      expect(code).toBe(0);
      expect(out).toContain('decision=publish');
    });
  });

  describe('the bootstrap version, already published by hand', () => {
    it('is skipped rather than failed, so the first release is green', async () => {
      const { code, out } = await run([
        '--version', '0.1.0', '--bootstrap', '0.1.0', '--published', published(OUR_REPO),
      ]);
      expect(code).toBe(0);
      expect(out).toContain('Bootstrap release already exists on npm; publication step skipped.');
      expect(out).toContain('decision=skip-bootstrap');
    });

    it('matches the repository regardless of git+ prefix, .git suffix or case', async () => {
      const { code, out } = await run([
        '--version', '0.1.0', '--bootstrap', '0.1.0',
        '--published', published('https://github.com/emin4ik/statenest'),
      ]);
      expect(code).toBe(0);
      expect(out).toContain('decision=skip-bootstrap');
    });

    it('still fails when the published package belongs to somebody else', async () => {
      // The whole point of the identity check: a name we do not own could
      // already be taken, and skipping then would report success while the
      // registry serves a stranger's code.
      const { code, out } = await run([
        '--version', '0.1.0', '--bootstrap', '0.1.0',
        '--published', published('git+https://github.com/someone-else/statenest.git'),
      ]);
      expect(code).toBe(1);
      expect(out).toContain('::error::');
      expect(out).toContain("somebody else's package");
      expect(out).toContain('decision=fail');
    });

    it('still fails when the published package declares no repository at all', async () => {
      const { code, out } = await run([
        '--version', '0.1.0', '--bootstrap', '0.1.0',
        '--published', JSON.stringify({ version: '0.1.0' }),
      ]);
      expect(code).toBe(1);
      expect(out).toContain('decision=fail');
    });
  });

  describe('ordinary duplicate publication', () => {
    it('fails for any version that is not the bootstrap version', async () => {
      const { code, out } = await run([
        '--version', '0.1.1', '--bootstrap', '0.1.0',
        '--published', published(OUR_REPO, '0.1.1'),
      ]);
      expect(code).toBe(1);
      expect(out).toContain('already on the registry');
      expect(out).toContain('decision=fail');
    });

    it('fails even when the repository matches — being ours is not a licence to republish', async () => {
      const { code, out } = await run([
        '--version', '2.0.0', '--bootstrap', '0.1.0',
        '--published', published(OUR_REPO, '2.0.0'),
      ]);
      expect(code).toBe(1);
      expect(out).toContain('decision=fail');
    });

    it('fails for the bootstrap version once the exception is retired', async () => {
      // After 0.1.0 ships, BOOTSTRAP_VERSION is cleared. From then on even
      // 0.1.0 is an ordinary duplicate.
      const { code, out } = await run([
        '--version', '0.1.0', '--bootstrap', '', '--published', published(OUR_REPO),
      ]);
      expect(code).toBe(1);
      expect(out).toContain('already on the registry');
      expect(out).toContain('decision=fail');
    });

    it('never suggests deleting and republishing', async () => {
      const { out } = await run([
        '--version', '0.1.1', '--bootstrap', '0.1.0',
        '--published', published(OUR_REPO, '0.1.1'),
      ]);
      expect(out).toContain('Do not delete and republish');
      expect(out).toContain('Bump the version');
    });
  });

  it('reads the real package.json when nothing is overridden', async () => {
    const { code, out } = await run(['--published', 'none']);
    expect(code).toBe(0);
    expect(out).toContain('statenest@0.1.0');
  });
});
