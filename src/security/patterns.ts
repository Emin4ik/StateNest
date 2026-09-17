/**
 * Secret detection rules.
 *
 * Deliberately a small, explicit, high-precision set rather than an attempt to
 * reimplement gitleaks. Project Brain scans its own output - checkpoints,
 * project notes, state files - not arbitrary source trees, so the input is
 * mostly prose written about a coding session. In that context a rule that
 * fires on a real token is worth far more than broad coverage that cries wolf
 * on every base64 string and trains the user to ignore it.
 *
 * The limits of this approach are documented for the user in
 * docs/security-model.md. Filename filtering (see discovery/exclusions.ts) is
 * the first line of defence; this is the second.
 */

export type Severity = 'critical' | 'high' | 'medium';

export interface SecretRule {
  id: string;
  /** Shown to the user. Must describe the *kind* of secret, never its value. */
  description: string;
  severity: Severity;
  pattern: RegExp;
  /** Group number holding the secret itself, when the match includes context. */
  secretGroup?: number;
  /** Reject a match that is obviously a placeholder rather than a real value. */
  validate?: (value: string) => boolean;
}

/** Placeholders that appear constantly in documentation and examples. */
const PLACEHOLDER = /^(x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|(your|my|the|some|a)[-_]?|example|placeholder|redacted|dummy|sample|test|fake|changeme|todo|insert|replace)/i;

function looksReal(value: string): boolean {
  if (PLACEHOLDER.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  // A value that is entirely one repeated short sequence is a filler string.
  return !/^(abc|123|000|aaa|xxx)+$/i.test(value);
}

/**
 * Shannon entropy in bits per character.
 *
 * Used only as a secondary gate on rules that would otherwise be too broad,
 * such as "a variable named SECRET is assigned something". Real credentials
 * are near-random; `SECRET_NAME=production` is not.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    description: 'a private key block',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'aws-access-key-id',
    description: 'an AWS access key id',
    severity: 'critical',
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
    secretGroup: 1,
  },
  {
    id: 'aws-secret-access-key',
    description: 'an AWS secret access key',
    severity: 'critical',
    pattern:
      /\baws_?secret_?access_?key\b\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    secretGroup: 1,
  },
  {
    id: 'github-token',
    description: 'a GitHub token',
    severity: 'critical',
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255})\b/g,
    secretGroup: 1,
  },
  {
    id: 'github-fine-grained-token',
    description: 'a GitHub fine-grained personal access token',
    severity: 'critical',
    pattern: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g,
    secretGroup: 1,
  },
  {
    id: 'anthropic-api-key',
    description: 'an Anthropic API key',
    severity: 'critical',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{16,})\b/g,
    secretGroup: 1,
  },
  {
    id: 'openai-api-key',
    description: 'an OpenAI API key',
    severity: 'critical',
    pattern: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})\b/g,
    secretGroup: 1,
    // `sk-ant-` keys are matched by their own, more specific rule.
    validate: (value) => looksReal(value) && !value.startsWith('sk-ant-'),
  },
  {
    id: 'slack-token',
    description: 'a Slack token',
    severity: 'critical',
    pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    secretGroup: 1,
  },
  {
    id: 'slack-webhook',
    description: 'a Slack incoming webhook URL',
    severity: 'high',
    pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{20,})/g,
    secretGroup: 1,
  },
  {
    id: 'google-api-key',
    description: 'a Google API key',
    severity: 'critical',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    secretGroup: 1,
  },
  {
    id: 'stripe-key',
    description: 'a Stripe secret key',
    severity: 'critical',
    pattern: /\b((?:sk|rk)_live_[0-9A-Za-z]{16,})\b/g,
    secretGroup: 1,
  },
  {
    id: 'npm-token',
    description: 'an npm access token',
    severity: 'critical',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
    secretGroup: 1,
  },
  {
    id: 'gitlab-token',
    description: 'a GitLab token',
    severity: 'critical',
    pattern: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
    secretGroup: 1,
  },
  {
    id: 'hugging-face-token',
    description: 'a Hugging Face token',
    severity: 'high',
    pattern: /\b(hf_[A-Za-z0-9]{34,})\b/g,
    secretGroup: 1,
  },
  {
    id: 'jwt',
    description: 'a JSON Web Token',
    severity: 'high',
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    secretGroup: 1,
  },
  {
    id: 'connection-string-password',
    description: 'a database connection string containing a password',
    severity: 'critical',
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|clickhouse):\/\/[^\s:/@]+:)([^\s@'"]+)(@)/gi,
    secretGroup: 2,
    validate: looksReal,
  },
  {
    id: 'url-basic-auth',
    description: 'a URL containing credentials',
    severity: 'high',
    pattern: /\b(https?:\/\/[^\s:/@]+:)([^\s@'"]{4,})(@[^\s'"]+)/gi,
    secretGroup: 2,
    validate: looksReal,
  },
  {
    id: 'bearer-token',
    description: 'a bearer token',
    severity: 'high',
    pattern: /\b[Bb]earer\s+([A-Za-z0-9_\-.=+/]{20,})\b/g,
    secretGroup: 1,
    validate: looksReal,
  },
  {
    id: 'authorization-header',
    description: 'an Authorization header value',
    severity: 'high',
    pattern: /\bAuthorization\s*[:=]\s*["']?(?:Basic|Token)\s+([A-Za-z0-9_\-.=+/]{16,})/gi,
    secretGroup: 1,
    validate: looksReal,
  },
  {
    id: 'ssh-private-key-body',
    description: 'the body of an OpenSSH private key',
    severity: 'critical',
    pattern: /\b(b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]{20,})/g,
    secretGroup: 1,
  },
  {
    id: 'generic-assigned-secret',
    description: 'a value assigned to a secret-looking name',
    severity: 'medium',
    pattern:
      /\b((?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?token|password|passwd|db[_-]?pass|encryption[_-]?key)\w*)\s*[=:]\s*["']([^"'\s]{12,})["']/gi,
    secretGroup: 2,
    // Entropy is what separates a real credential from `PASSWORD="required"`.
    validate: (value) => looksReal(value) && shannonEntropy(value) >= 3.2,
  },
];

/** A stable, non-reversible label for a finding: never the secret itself. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.min(12, value.length - 6))}${value.slice(-3)}`;
}
