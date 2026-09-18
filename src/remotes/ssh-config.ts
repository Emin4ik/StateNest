import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readFileOrNull } from '../util/fs-atomic.js';

/**
 * Reading `~/.ssh/config` for candidate servers.
 *
 * Two hard rules, both non-negotiable:
 *
 * 1. Only *addressing* is extracted - alias, hostname, user, port. Fields that
 *    point at credentials (`IdentityFile`, `CertificateFile`, `ProxyCommand`,
 *    `PKCS11Provider`) are recognised so they can be deliberately ignored, and
 *    the files they name are never opened.
 *
 * 2. Nothing found here is registered automatically. The parser returns
 *    candidates; the user picks. A developer's ssh config commonly holds
 *    employer infrastructure, and hoovering it into a personal, possibly
 *    synced, data repository would be exactly the wrong default.
 */

export interface SshHostCandidate {
  /** The `Host` alias, as ssh understands it. */
  alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  /** Config file this came from, for the user to verify. */
  sourceFile: string;
  /** True when the alias contains a wildcard and is a pattern, not a host. */
  isPattern: boolean;
  /** Set when the entry names credential files, which were NOT read. */
  usesIdentityFile: boolean;
}

/** Keys we deliberately never read the value of. */
const CREDENTIAL_KEYS = new Set([
  'identityfile',
  'certificatefile',
  'pkcs11provider',
  'securitykeyprovider',
  'identityagent',
  'proxycommand',
  'localcommand',
  'remotecommand',
  'knownhostscommand',
]);

export interface ParseOptions {
  /** Follow `Include` directives. Bounded to avoid a cycle hanging a scan. */
  followIncludes?: boolean;
  maxIncludeDepth?: number;
}

export async function readSshConfig(
  configPath = join(homedir(), '.ssh', 'config'),
  options: ParseOptions = {},
): Promise<SshHostCandidate[]> {
  const seen = new Set<string>();
  return readConfigFile(configPath, options, seen, 0);
}

async function readConfigFile(
  configPath: string,
  options: ParseOptions,
  seen: Set<string>,
  depth: number,
): Promise<SshHostCandidate[]> {
  if (seen.has(configPath)) return [];
  seen.add(configPath);

  const raw = await readFileOrNull(configPath);
  if (raw === null) return [];

  const candidates = parseSshConfig(raw, configPath);

  if (options.followIncludes && depth < (options.maxIncludeDepth ?? 3)) {
    for (const includePath of extractIncludes(raw, configPath)) {
      candidates.push(...(await readConfigFile(includePath, options, seen, depth + 1)));
    }
  }

  return candidates;
}

/**
 * Parse ssh_config text.
 *
 * ssh's own grammar is `Keyword Argument(s)`, separated by whitespace or a
 * single `=`, case-insensitive on the keyword. A `Host` line can name several
 * patterns at once, each of which becomes its own candidate.
 */
export function parseSshConfig(raw: string, sourceFile = '<memory>'): SshHostCandidate[] {
  const candidates: SshHostCandidate[] = [];
  let current: SshHostCandidate[] = [];

  const flush = (): void => {
    for (const candidate of current) candidates.push(candidate);
    current = [];
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = /^(\S+)\s*(?:=|\s)\s*(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1]!.toLowerCase();
    const value = stripComment(match[2]!.trim());

    if (keyword === 'host') {
      flush();
      for (const alias of value.split(/\s+/).filter(Boolean)) {
        const unquoted = unquote(alias);
        current.push({
          alias: unquoted,
          hostname: null,
          user: null,
          port: null,
          sourceFile,
          isPattern: /[*?!]/.test(unquoted),
          usesIdentityFile: false,
        });
      }
      continue;
    }

    // `Match` blocks are conditional and cannot be resolved statically, so the
    // entries under one are not attributed to the preceding Host.
    if (keyword === 'match') {
      flush();
      continue;
    }

    if (current.length === 0) continue;

    if (CREDENTIAL_KEYS.has(keyword)) {
      // Noted, never read. The user is told the entry uses a key file so they
      // understand why StateNest stores no authentication detail.
      for (const candidate of current) candidate.usesIdentityFile = true;
      continue;
    }

    switch (keyword) {
      case 'hostname':
        for (const candidate of current) candidate.hostname = unquote(value);
        break;
      case 'user':
        for (const candidate of current) candidate.user = unquote(value);
        break;
      case 'port': {
        const port = Number.parseInt(value, 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
          for (const candidate of current) candidate.port = port;
        }
        break;
      }
      default:
        break;
    }
  }

  flush();
  return candidates;
}

/** Hosts worth offering: real aliases, not wildcard patterns. */
export function usableHosts(candidates: readonly SshHostCandidate[]): SshHostCandidate[] {
  const byAlias = new Map<string, SshHostCandidate>();
  for (const candidate of candidates) {
    if (candidate.isPattern) continue;
    if (candidate.alias === '') continue;
    // First definition wins, which is also how ssh resolves options.
    if (!byAlias.has(candidate.alias)) byAlias.set(candidate.alias, candidate);
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

function extractIncludes(raw: string, sourceFile: string): string[] {
  const includes: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const match = /^\s*include\s+(.+)$/i.exec(rawLine);
    if (!match) continue;
    for (const token of stripComment(match[1]!).split(/\s+/).filter(Boolean)) {
      const unquoted = unquote(token);
      // Globs are not expanded: doing so would mean walking directories the
      // user did not ask us to look at.
      if (/[*?[\]]/.test(unquoted)) continue;
      const expanded = unquoted.startsWith('~')
        ? join(homedir(), unquoted.slice(1))
        : isAbsolute(unquoted)
          ? unquoted
          : resolve(dirname(sourceFile), unquoted);
      includes.push(expanded);
    }
  }
  return includes;
}

function stripComment(value: string): string {
  const index = value.indexOf('#');
  return index === -1 ? value : value.slice(0, index).trim();
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * A guess at what kind of environment an alias describes.
 *
 * Only ever a pre-selected default in the import checklist. Getting it wrong
 * costs the user one keystroke; getting it silently wrong and never asking
 * would cost them a mislabelled production server.
 */
export function guessEnvironment(alias: string): 'production' | 'staging' | 'development' | 'other' {
  const name = alias.toLowerCase();
  if (/\b(prod|production|live|www)\b|-prod|prod-/.test(name)) return 'production';
  if (/\b(stage|staging|uat|preprod|pre-prod)\b/.test(name)) return 'staging';
  if (/\b(dev|development|test|sandbox|local|lab)\b/.test(name)) return 'development';
  return 'other';
}
