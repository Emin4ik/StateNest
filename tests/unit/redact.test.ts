import { describe, expect, it } from 'vitest';
import {
  REDACTION_PLACEHOLDER,
  detectSecrets,
  hasSecretsAtLeast,
  redactSecrets,
} from '../../src/security/redact.js';
import { shannonEntropy } from '../../src/security/patterns.js';

/**
 * Test values are syntactically valid instances of each format, but are not
 * real credentials.
 *
 * Two constraints shaped them. Each embeds the marker `n0treal` so a grep for
 * it finds only this file and no real secret could be mistaken for a fixture.
 * And the marker never appears at the *start* of the captured value, because
 * the detector deliberately rejects values beginning with placeholder words
 * like "fake" or "example" - a fixture that tripped that check would be
 * testing the placeholder filter rather than the format rule.
 *
 * `padTo` keeps each value at exactly the length its format requires, so the
 * length boundaries stay honest rather than being silently satisfied.
 */
function padTo(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

const FAKE = {
  githubToken: `ghp_${padTo('Kq7n0trealZx92Mw4', 36)}`,
  githubPat: `github_pat_${padTo('Kq7n0trealZx92Mw4', 22)}_${padTo('Jd8n0trealPv51Rt6', 30)}`,
  anthropic: `sk-ant-api03-${padTo('Kq7n0trealZx92Mw4', 40)}`,
  openai: `sk-proj-${padTo('Jd8n0trealPv51Rt6', 32)}`,
  aws: 'AKIAIOSFODNN7EXAMPLE',
  google: `AIza${padTo('Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye', 35)}`,
  slack: `xoxb-1234567890-${padTo('Kq7n0trealZx92Mw4', 24)}`,
  npm: `npm_${padTo('Kq7n0trealZx92Mw4', 36)}`,
  stripe: `sk_live_${padTo('Kq7n0trealZx92Mw4', 24)}`,
  gitlab: `glpat-${padTo('Kq7n0trealZx92Mw4', 24)}`,
  bearer: padTo('Kq7n0trealZx92Mw4Jd8Pv51', 32),
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJuMHRyZWFsIiwibmFtZSI6Ik4wdHJlYWwifQ.Kq7n0trealZx92Mw4Jd8Pv51Rt6',
};

describe('detectSecrets', () => {
  describe('credential formats', () => {
    it.each([
      ['GitHub token', FAKE.githubToken, 'github-token'],
      ['GitHub fine-grained PAT', FAKE.githubPat, 'github-fine-grained-token'],
      ['Anthropic key', FAKE.anthropic, 'anthropic-api-key'],
      ['OpenAI key', FAKE.openai, 'openai-api-key'],
      ['AWS access key id', FAKE.aws, 'aws-access-key-id'],
      ['Google API key', FAKE.google, 'google-api-key'],
      ['Slack token', FAKE.slack, 'slack-token'],
      ['npm token', FAKE.npm, 'npm-token'],
      ['Stripe live key', FAKE.stripe, 'stripe-key'],
      ['GitLab token', FAKE.gitlab, 'gitlab-token'],
      ['JWT', FAKE.jwt, 'jwt'],
    ])('detects %s', (_label, value, ruleId) => {
      const findings = detectSecrets(`the key is ${value} ok`);
      expect(findings.map((finding) => finding.ruleId)).toContain(ruleId);
    });

    it('detects a private key block', () => {
      const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
      expect(detectSecrets(text).map((f) => f.ruleId)).toContain('private-key');
    });

    it('detects a password inside a database URL', () => {
      const findings = detectSecrets('postgres://admin:s3cretPassw0rd@db.internal:5432/app');
      expect(findings.map((f) => f.ruleId)).toContain('connection-string-password');
    });

    it('detects a bearer token', () => {
      const findings = detectSecrets(`Authorization: Bearer ${FAKE.bearer}`);
      expect(findings.map((f) => f.ruleId)).toContain('bearer-token');
    });
  });

  describe('format boundaries are enforced, not approximated', () => {
    it('ignores a GitHub token that is too short to be real', () => {
      expect(detectSecrets(`ghp_${padTo('Kq7n0trealZx9', 20)}`)).toEqual([]);
    });

    it('ignores an npm token that is not exactly 36 characters', () => {
      expect(detectSecrets(`npm_${padTo('Kq7n0trealZx9', 20)}`)).toEqual([]);
    });

    it('ignores a Google key that is not exactly 35 characters', () => {
      expect(detectSecrets(`AIza${padTo('Kq7n0trealZx9', 20)}`)).toEqual([]);
    });

    it('ignores a bearer value too short to be a credential', () => {
      expect(detectSecrets('Bearer abc123')).toEqual([]);
    });
  });

  describe('a finding never carries the secret', () => {
    it('masks the value', () => {
      const findings = detectSecrets(`token=${FAKE.githubToken}`);
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.masked).not.toBe(FAKE.githubToken);
        expect(finding.masked).toContain('*');
      }
    });

    it('cannot be reassembled from the serialized finding', () => {
      const findings = detectSecrets(`key: ${FAKE.anthropic}`);
      expect(JSON.stringify(findings)).not.toContain(FAKE.anthropic);
    });
  });

  it('reports the line number', () => {
    const findings = detectSecrets(`line one\nline two\ntoken ${FAKE.githubToken}\nline four`);
    expect(findings[0]?.line).toBe(3);
  });

  it('finds every occurrence, not just the first', () => {
    const text = `a ${FAKE.githubToken} b ${FAKE.githubToken.replace('ghp_F', 'ghp_G')} c`;
    expect(detectSecrets(text).filter((f) => f.ruleId === 'github-token')).toHaveLength(2);
  });

  it('is not affected by a previous scan (regex lastIndex is reset)', () => {
    const text = `token ${FAKE.githubToken}`;
    const first = detectSecrets(text);
    const second = detectSecrets(text);
    expect(second).toEqual(first);
    expect(second.length).toBeGreaterThan(0);
  });

  describe('does not cry wolf', () => {
    it.each([
      'This project uses an API key from the dashboard.',
      'PASSWORD=required',
      'api_key: <your-api-key>',
      'secret_key = "changeme"',
      'token: ${GITHUB_TOKEN}',
      'export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY',
      'The commit 72ba934a8f1c2d3e4f5061728394a5b6c7d8e9f0 fixed it.',
      'Fixed the refinery rebuild logic in ai/economy.ts',
      'See https://github.com/acme/widget/pull/42',
      'npm install @modelcontextprotocol/sdk@1.30.0',
    ])('leaves %j alone', (text) => {
      expect(detectSecrets(text)).toEqual([]);
    });

    it('ignores a documentation placeholder token', () => {
      expect(detectSecrets('Authorization: Bearer <your-token-here>')).toEqual([]);
    });

    it('does not flag a plain https URL', () => {
      expect(detectSecrets('https://api.example.com/v1/widgets?limit=100')).toEqual([]);
    });
  });
});

describe('redactSecrets', () => {
  it('removes the secret from the text', () => {
    const { text, findings } = redactSecrets(`Use token ${FAKE.githubToken} to authenticate.`);
    expect(text).not.toContain(FAKE.githubToken);
    expect(text).toContain(REDACTION_PLACEHOLDER);
    expect(findings).toHaveLength(1);
  });

  it('keeps the surrounding prose intact', () => {
    const { text } = redactSecrets(`Use token ${FAKE.githubToken} to authenticate.`);
    expect(text).toBe(`Use token ${REDACTION_PLACEHOLDER} to authenticate.`);
  });

  it('redacts only the password inside a connection string', () => {
    const { text } = redactSecrets('DATABASE_URL=postgres://admin:s3cretPassw0rd@db.internal:5432/app');
    expect(text).not.toContain('s3cretPassw0rd');
    expect(text).toContain('postgres://admin:');
    expect(text).toContain('@db.internal:5432/app');
  });

  it('handles several different secrets in one document', () => {
    const input = [
      '# Session notes',
      `Deployed with ${FAKE.aws}`,
      `and pushed using ${FAKE.githubToken}`,
      'Everything else is fine.',
    ].join('\n');

    const { text, findings } = redactSecrets(input);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain(FAKE.aws);
    expect(text).not.toContain(FAKE.githubToken);
    expect(text).toContain('Everything else is fine.');
  });

  it('is a no-op for clean text', () => {
    const clean = 'Fixed the AI refinery rebuild behaviour and added SAM sites.';
    expect(redactSecrets(clean)).toEqual({ text: clean, findings: [] });
  });

  it('handles empty and non-string input without throwing', () => {
    expect(redactSecrets('')).toEqual({ text: '', findings: [] });
    expect(redactSecrets(undefined as unknown as string).findings).toEqual([]);
  });

  it('produces output that is itself clean', () => {
    const { text } = redactSecrets(`token=${FAKE.githubToken} key=${FAKE.anthropic}`);
    expect(detectSecrets(text)).toEqual([]);
  });
});

describe('hasSecretsAtLeast', () => {
  it('reports critical findings', () => {
    expect(hasSecretsAtLeast(`k=${FAKE.aws}`, 'critical')).toBe(true);
  });

  it('ignores medium findings when asked for critical only', () => {
    expect(hasSecretsAtLeast('Fixed the login page.', 'critical')).toBe(false);
  });
});

describe('shannonEntropy', () => {
  it('scores random-looking strings high', () => {
    expect(shannonEntropy('aB3xK9mQ2pL7zR4v')).toBeGreaterThan(3.5);
  });

  it('scores repetitive strings low', () => {
    expect(shannonEntropy('aaaaaaaaaaaaaaaa')).toBeLessThan(1);
  });

  it('returns zero for an empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });
});
