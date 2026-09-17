import { describe, expect, it } from 'vitest';
import {
  normalizeRemoteUrl,
  remoteIdentity,
  sameRepository,
} from '../../src/git/remote-url.js';

describe('normalizeRemoteUrl', () => {
  describe('the core promise: one repository, one identity', () => {
    const githubForms = [
      'git@github.com:acme/widget.git',
      'git@github.com:acme/widget',
      'https://github.com/acme/widget.git',
      'https://github.com/acme/widget',
      'https://github.com/acme/widget/',
      'https://www.github.com/acme/widget.git',
      'ssh://git@github.com/acme/widget.git',
      'ssh://git@github.com:22/acme/widget.git',
      'ssh://git@github.com:2222/acme/widget.git',
      'git://github.com/acme/widget.git',
      'git+ssh://git@github.com/acme/widget.git',
      'GIT@GitHub.com:Acme/Widget.git',
      'https://github.com/Acme/Widget',
      '  https://github.com/acme/widget.git  ',
      'https://github.com//acme//widget.git',
    ];

    it.each(githubForms)('normalizes %s to github.com/acme/widget', (url) => {
      expect(remoteIdentity(url)).toBe('github.com/acme/widget');
    });

    it('treats every form as the same repository', () => {
      for (const form of githubForms) {
        expect(sameRepository(form, 'git@github.com:acme/widget.git')).toBe(true);
      }
    });
  });

  it('keeps genuinely different repositories apart', () => {
    expect(sameRepository('git@github.com:acme/widget', 'git@github.com:acme/gadget')).toBe(false);
    expect(sameRepository('git@github.com:acme/widget', 'git@gitlab.com:acme/widget')).toBe(false);
    expect(sameRepository('git@github.com:acme/widget', 'git@github.com:other/widget')).toBe(false);
  });

  it('parses ownership and naming', () => {
    const result = normalizeRemoteUrl('git@github.com:acme/widget.git');
    expect(result).toMatchObject({
      identity: 'github.com/acme/widget',
      host: 'github.com',
      path: 'acme/widget',
      displayPath: 'acme/widget',
      owner: 'acme',
      name: 'widget',
      scheme: 'ssh',
      stableAcrossMachines: true,
      webUrl: 'https://github.com/acme/widget',
    });
  });

  it('preserves original case for display while lowercasing identity', () => {
    const result = normalizeRemoteUrl('https://github.com/Acme/WidgetPro.git');
    expect(result?.identity).toBe('github.com/acme/widgetpro');
    expect(result?.displayPath).toBe('Acme/WidgetPro');
    expect(result?.name).toBe('WidgetPro');
    expect(result?.webUrl).toBe('https://github.com/Acme/WidgetPro');
  });

  describe('nested groups', () => {
    it('keeps GitLab subgroups in the identity', () => {
      const result = normalizeRemoteUrl('https://gitlab.com/group/subgroup/project.git');
      expect(result?.identity).toBe('gitlab.com/group/subgroup/project');
      expect(result?.owner).toBe('group/subgroup');
      expect(result?.name).toBe('project');
    });

    it('matches the ssh form of a subgroup path', () => {
      expect(
        sameRepository(
          'git@gitlab.com:group/subgroup/project.git',
          'https://gitlab.com/group/subgroup/project',
        ),
      ).toBe(true);
    });
  });

  describe('self-hosted forges', () => {
    it('handles a self-hosted GitLab over a custom ssh port', () => {
      expect(remoteIdentity('ssh://git@git.internal.example.com:2222/team/service.git')).toBe(
        'git.internal.example.com/team/service',
      );
    });

    it('unifies ssh and https on the same self-hosted host', () => {
      expect(
        sameRepository(
          'git@git.internal.example.com:team/service.git',
          'https://git.internal.example.com/team/service.git',
        ),
      ).toBe(true);
    });

    it('does not invent a web URL for an unknown host', () => {
      expect(normalizeRemoteUrl('git@git.internal.example.com:team/service.git')?.webUrl).toBeNull();
    });

    it('strips the Bitbucket Server /scm/ prefix', () => {
      expect(
        sameRepository(
          'https://bitbucket.internal.example.com/scm/proj/repo.git',
          'ssh://git@bitbucket.internal.example.com:7999/proj/repo.git',
        ),
      ).toBe(true);
    });
  });

  describe('Azure DevOps', () => {
    it('unifies the ssh v3 form with the https _git form', () => {
      expect(
        sameRepository(
          'git@ssh.dev.azure.com:v3/contoso/BuildSystem/widget',
          'https://dev.azure.com/contoso/BuildSystem/_git/widget',
        ),
      ).toBe(true);
    });

    it('builds a browsable URL', () => {
      const result = normalizeRemoteUrl('https://dev.azure.com/contoso/BuildSystem/_git/widget');
      expect(result?.webUrl).toBe('https://dev.azure.com/contoso/BuildSystem/_git/widget');
    });
  });

  describe('credentials are never returned', () => {
    const secret = 'ghp_EXAMPLEtokenEXAMPLEtokenEXAMPLEtoken';

    it('strips a token from an https remote', () => {
      const result = normalizeRemoteUrl(`https://x-access-token:${secret}@github.com/acme/widget.git`);
      expect(result?.identity).toBe('github.com/acme/widget');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('x-access-token');
    });

    it('strips basic-auth credentials', () => {
      const result = normalizeRemoteUrl('https://alice:hunter2@gitlab.com/acme/widget.git');
      expect(JSON.stringify(result)).not.toContain('hunter2');
      expect(result?.sanitized).toBe('https://gitlab.com/acme/widget.git');
    });

    it('strips a password from an scp-like remote but keeps the user', () => {
      const result = normalizeRemoteUrl('git:hunter2@github.com:acme/widget.git');
      expect(JSON.stringify(result)).not.toContain('hunter2');
      expect(result?.sanitized).toBe('git@github.com:acme/widget.git');
    });

    it('produces a sanitized remote that still identifies the repo', () => {
      const result = normalizeRemoteUrl(`https://oauth2:${secret}@gitlab.com/acme/widget.git`);
      expect(remoteIdentity(result!.sanitized)).toBe('gitlab.com/acme/widget');
    });
  });

  describe('local and file remotes', () => {
    it('marks a filesystem remote as not stable across machines', () => {
      const result = normalizeRemoteUrl('/srv/git/widget.git');
      expect(result?.scheme).toBe('local');
      expect(result?.stableAcrossMachines).toBe(false);
      expect(result?.name).toBe('widget');
    });

    it('namespaces local identities so they cannot collide with a host path', () => {
      expect(normalizeRemoteUrl('/srv/git/widget.git')?.identity).toBe('local:/srv/git/widget');
    });

    it('handles file:// URLs', () => {
      const result = normalizeRemoteUrl('file:///srv/git/widget.git');
      expect(result?.scheme).toBe('file');
      expect(result?.stableAcrossMachines).toBe(false);
    });

    it('does not mistake a Windows drive letter for a host', () => {
      const result = normalizeRemoteUrl('C:\\repos\\widget');
      expect(result?.scheme).toBe('local');
      expect(result?.host).toBe('');
      expect(result?.name).toBe('widget');
    });

    it('handles a relative path remote', () => {
      const result = normalizeRemoteUrl('../sibling-repo');
      expect(result?.scheme).toBe('local');
      expect(result?.stableAcrossMachines).toBe(false);
    });
  });

  describe('rejects input that is not a remote', () => {
    it.each(['', '   ', '\n'])('returns null for empty input %j', (value) => {
      expect(normalizeRemoteUrl(value)).toBeNull();
    });

    it('returns null for a host with no path', () => {
      expect(normalizeRemoteUrl('https://github.com')).toBeNull();
      expect(normalizeRemoteUrl('https://github.com/')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(normalizeRemoteUrl(undefined as unknown as string)).toBeNull();
      expect(normalizeRemoteUrl(null as unknown as string)).toBeNull();
      expect(normalizeRemoteUrl(42 as unknown as string)).toBeNull();
    });
  });

  describe('regression guards', () => {
    it('only strips one trailing .git', () => {
      expect(remoteIdentity('git@github.com:acme/widget.git.git')).toBe('github.com/acme/widget.git');
    });

    it('does not strip .git from the middle of a name', () => {
      expect(remoteIdentity('git@github.com:acme/widget.github.io.git')).toBe(
        'github.com/acme/widget.github.io',
      );
    });

    it('handles a trailing dot on the hostname', () => {
      expect(remoteIdentity('https://github.com./acme/widget.git')).toBe('github.com/acme/widget');
    });

    it('handles percent-encoded path segments', () => {
      expect(remoteIdentity('https://gitlab.com/group/sub%20group/project.git')).toBe(
        'gitlab.com/group/sub group/project',
      );
    });

    it('is stable under repeated normalization', () => {
      const first = normalizeRemoteUrl('https://x:tok@github.com/Acme/Widget.git');
      const second = normalizeRemoteUrl(first!.sanitized);
      expect(second?.identity).toBe(first?.identity);
    });
  });
});
