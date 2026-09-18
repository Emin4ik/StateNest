import { SECRET_RULES, maskSecret, type Severity } from './patterns.js';

export interface SecretFinding {
  ruleId: string;
  /** Human description of the kind of secret. Never contains the value. */
  description: string;
  severity: Severity;
  /** 1-based line number within the scanned text. */
  line: number;
  /**
   * A masked fragment, safe to print.
   *
   * The brief is explicit: tell the user which file triggered a block without
   * echoing the secret. Everything user-facing goes through this.
   */
  masked: string;
}

export interface RedactionResult {
  text: string;
  findings: SecretFinding[];
}

export const REDACTION_PLACEHOLDER = '[redacted by StateNest]';

/**
 * Find secrets in text without modifying it.
 *
 * Findings carry a masked fragment only. The full value never leaves this
 * module, which is what makes it safe to log a finding, print it, or return it
 * over MCP.
 */
export function detectSecrets(text: string): SecretFinding[] {
  if (typeof text !== 'string' || text === '') return [];

  const findings: SecretFinding[] = [];
  const lineOffsets = buildLineOffsets(text);

  for (const rule of SECRET_RULES) {
    // Rules are module-level and carry /g, so lastIndex must be reset or a
    // previous scan's position silently skips matches in this one.
    rule.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      // A zero-length match would loop forever.
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
        continue;
      }

      const secret = rule.secretGroup !== undefined ? match[rule.secretGroup] : match[0];
      if (secret === undefined || secret === '') continue;
      if (rule.validate && !rule.validate(secret)) continue;

      findings.push({
        ruleId: rule.id,
        description: rule.description,
        severity: rule.severity,
        line: lineNumberAt(lineOffsets, match.index),
        masked: maskSecret(secret),
      });
    }
    rule.pattern.lastIndex = 0;
  }

  return findings.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
}

/**
 * Replace anything that looks like a secret with a placeholder.
 *
 * Used on every piece of text StateNest is about to persist. Redaction is
 * preferred to rejection here: a checkpoint whose summary mentions a token is
 * still a useful checkpoint once the token is gone, and refusing to save it
 * would cost the user their session notes over one bad substring.
 *
 * Sync is the opposite case and *blocks* instead - see security/audit.ts.
 */
export function redactSecrets(text: string): RedactionResult {
  if (typeof text !== 'string' || text === '') return { text, findings: [] };

  const findings = detectSecrets(text);
  if (findings.length === 0) return { text, findings };

  let redacted = text;
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    redacted = redacted.replace(rule.pattern, (...args: unknown[]) => {
      const groups = args.slice(0, -2) as string[];
      const whole = groups[0] ?? '';
      const secret = rule.secretGroup !== undefined ? groups[rule.secretGroup] : whole;

      if (secret === undefined || secret === '') return whole;
      if (rule.validate && !rule.validate(secret)) return whole;

      // Rules that capture surrounding context rebuild it, so a redacted
      // connection string still reads as a connection string.
      if (rule.secretGroup !== undefined) {
        return whole.replace(secret, REDACTION_PLACEHOLDER);
      }
      return REDACTION_PLACEHOLDER;
    });
    rule.pattern.lastIndex = 0;
  }

  return { text: redacted, findings };
}

/** True when the text contains anything at or above the given severity. */
export function hasSecretsAtLeast(text: string, minimum: Severity = 'high'): boolean {
  const order: Record<Severity, number> = { medium: 0, high: 1, critical: 2 };
  return detectSecrets(text).some((finding) => order[finding.severity] >= order[minimum]);
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function lineNumberAt(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid]! <= position) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
