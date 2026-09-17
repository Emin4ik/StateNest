/**
 * Git remote URL normalization.
 *
 * This is the load-bearing function for cross-machine project identity. Two
 * machines that have never communicated must derive the same project id from
 * the same repository, no matter which URL form each of them cloned with:
 *
 *   git@github.com:Acme/Widget.git
 *   https://github.com/acme/widget
 *   ssh://git@github.com:2222/acme/widget.git
 *   https://x-access-token:ghp_SECRET@github.com/acme/widget.git
 *
 * ...all normalize to the identity `github.com/acme/widget`.
 *
 * Two deliberate decisions, both documented in docs/architecture/identity.md:
 *
 * 1. The port is dropped. A repository reachable over SSH on 22 and 2222 is
 *    one repository; the port is a transport detail, not identity.
 *
 * 2. The path is lowercased. Hosts differ on path case sensitivity, but the
 *    realistic failure modes are asymmetric: the same project appearing twice
 *    because two machines typed the URL with different capitalisation is
 *    common, whereas two genuinely distinct repositories on one host differing
 *    only by letter case is vanishingly rare.
 *
 * Credentials embedded in a remote URL are stripped and never returned. The
 * caller cannot accidentally persist a token, because it is not in the result.
 */

export type RemoteScheme = 'ssh' | 'https' | 'http' | 'git' | 'file' | 'local' | 'unknown';

export interface NormalizedRemote {
  /** Canonical identity, e.g. `github.com/acme/widget`. Lowercase. */
  identity: string;
  /** Lowercased host, without port. Empty for local paths. */
  host: string;
  /** Lowercased repository path, no leading slash and no `.git` suffix. */
  path: string;
  /** Repository path preserving original case, for display and web links. */
  displayPath: string;
  /** Owner / organisation / group path, or null when the host has no concept of one. */
  owner: string | null;
  /** Bare repository name, original case preserved. */
  name: string;
  scheme: RemoteScheme;
  /**
   * False for `file:` and plain filesystem remotes. Their path is meaningful
   * only on the machine that holds it, so it must never be used as an identity
   * shared through a synced data repository.
   */
  stableAcrossMachines: boolean;
  /** Browsable https URL when one can be built confidently, else null. */
  webUrl: string | null;
  /** The input with any embedded credentials removed. Safe to persist. */
  sanitized: string;
}

/** Hosts that publish the same repositories under more than one hostname. */
const HOST_ALIASES: Record<string, string> = {
  'www.github.com': 'github.com',
  'ssh.github.com': 'github.com',
  'www.gitlab.com': 'gitlab.com',
  'altssh.gitlab.com': 'gitlab.com',
  'www.bitbucket.org': 'bitbucket.org',
  'altssh.bitbucket.org': 'bitbucket.org',
  'ssh.dev.azure.com': 'dev.azure.com',
  'vs-ssh.visualstudio.com': 'dev.azure.com',
  'ssh.gitea.com': 'gitea.com',
  'git.sr.ht': 'sr.ht',
};

const WEB_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitea.com']);

export function normalizeRemoteUrl(input: string): NormalizedRemote | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '') return null;

  const parsed = parseRemote(raw);
  if (!parsed) return null;

  const { scheme, host: rawHost, path: rawPath, sanitized } = parsed;

  if (scheme === 'local' || scheme === 'file') {
    const cleanedPath = stripGitSuffix(rawPath.replace(/[/\\]+$/, ''));
    const name = cleanedPath.split(/[/\\]/).filter(Boolean).pop() ?? cleanedPath;
    return {
      // A filesystem remote is identity only within one machine. The `local:`
      // prefix keeps it from ever colliding with a real host path.
      identity: `local:${normalizeLocalPathForIdentity(cleanedPath)}`,
      host: '',
      path: cleanedPath,
      displayPath: cleanedPath,
      owner: null,
      name,
      scheme,
      stableAcrossMachines: false,
      webUrl: null,
      sanitized,
    };
  }

  const host = canonicalHost(rawHost);
  if (host === '') return null;

  const displayPath = canonicalPath(host, rawPath);
  if (displayPath === '') return null;

  const path = displayPath.toLowerCase();
  const segments = displayPath.split('/');
  const name = segments[segments.length - 1] ?? displayPath;
  const owner = segments.length > 1 ? segments.slice(0, -1).join('/') : null;

  return {
    identity: `${host}/${path}`,
    host,
    path,
    displayPath,
    owner,
    name,
    scheme,
    stableAcrossMachines: true,
    webUrl: buildWebUrl(host, displayPath),
    sanitized,
  };
}

/** Convenience: just the identity string, or null when the remote is unparseable. */
export function remoteIdentity(input: string): string | null {
  return normalizeRemoteUrl(input)?.identity ?? null;
}

/** True when both URLs point at the same repository. */
export function sameRepository(a: string, b: string): boolean {
  const left = remoteIdentity(a);
  const right = remoteIdentity(b);
  return left !== null && left === right;
}

interface ParsedRemote {
  scheme: RemoteScheme;
  host: string;
  path: string;
  sanitized: string;
}

function parseRemote(raw: string): ParsedRemote | null {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);

  if (schemeMatch) {
    const declared = (schemeMatch[1] ?? '').toLowerCase();
    // git remotes accept transport aliases such as `git+ssh://`.
    const scheme = normalizeScheme(declared);
    if (scheme === 'file') {
      const path = decodeURIComponentSafe(raw.slice(schemeMatch[0].length));
      // file://host/path is legal but the host is almost always empty or
      // "localhost"; either way only the path is meaningful.
      const withoutHost = path.replace(/^(?:localhost)?\//, '/');
      return { scheme: 'file', host: '', path: withoutHost, sanitized: `file://${withoutHost}` };
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const host = url.hostname;
    const path = decodeURIComponentSafe(url.pathname);
    // Rebuild without userinfo so an embedded token can never reach disk.
    const port = url.port ? `:${url.port}` : '';
    const sanitized = `${scheme}://${host}${port}${url.pathname}`;
    return { scheme, host, path, sanitized };
  }

  // scp-like syntax: [user@]host:path.
  //
  // Userinfo is resolved *before* the host/path colon, because a malformed but
  // plausible remote such as `git:hunter2@github.com:acme/widget.git` would
  // otherwise split at the password's colon and carry the secret into the
  // identity. Split at the last `@` that precedes the first path separator.
  const firstSeparator = raw.search(/[/\\]/);
  const authorityEnd = firstSeparator === -1 ? raw.length : firstSeparator;
  const atIndex = raw.lastIndexOf('@', authorityEnd);
  const user = atIndex > 0 ? raw.slice(0, atIndex) : '';
  const afterUser = atIndex > 0 ? raw.slice(atIndex + 1) : raw;

  const colonIndex = afterUser.indexOf(':');
  if (colonIndex > 0) {
    const host = afterUser.slice(0, colonIndex);
    // Git only recognises scp-like syntax when no slash precedes the colon,
    // which is also what keeps `C:\repos\widget` from becoming a host named "C".
    const hasSeparatorBeforeColon = /[/\\]/.test(host);
    const looksLikeDriveLetter = /^[a-z]$/i.test(host);
    if (!hasSeparatorBeforeColon && !looksLikeDriveLetter) {
      const path = afterUser.slice(colonIndex + 1);
      // The user survives into the sanitized form (`git@`) - it is not a
      // secret, and dropping it would produce a URL that no longer clones.
      const userPrefix = user === '' ? '' : `${stripPassword(user)}@`;
      return { scheme: 'ssh', host, path, sanitized: `${userPrefix}${host}:${path}` };
    }
  }

  // Anything left is a filesystem path: absolute, relative, or Windows drive.
  return { scheme: 'local', host: '', path: raw, sanitized: raw };
}

function normalizeScheme(declared: string): RemoteScheme {
  switch (declared) {
    case 'ssh':
    case 'git+ssh':
    case 'ssh+git':
      return 'ssh';
    case 'https':
    case 'git+https':
      return 'https';
    case 'http':
    case 'git+http':
      return 'http';
    case 'git':
      return 'git';
    case 'file':
      return 'file';
    default:
      return 'unknown';
  }
}

function canonicalHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return HOST_ALIASES[lower] ?? lower;
}

/**
 * Strip the leading slash, the `.git` suffix, and host-specific path noise.
 *
 * The provider-specific rules are deliberately few and explicit. Each one
 * exists because that host genuinely serves the same repository under two
 * different path shapes, which would otherwise split one project in two.
 */
function canonicalPath(host: string, rawPath: string): string {
  let path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '');
  path = path.replace(/\/{2,}/g, '/');
  path = stripGitSuffix(path);

  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    // SSH form is `v3/org/project/repo`; HTTPS form is `org/project/_git/repo`.
    path = path.replace(/^v3\//, '').replace(/\/_git\//, '/');
    // `_optimized` appears in some generated Azure clone URLs.
    path = path.replace(/\/_optimized\//, '/');
  }

  if (path.startsWith('scm/')) {
    // Bitbucket Server / Data Center serves HTTPS clones under /scm/.
    path = path.slice(4);
  }

  if (host === 'sr.ht' || host.endsWith('.sr.ht')) {
    // sourcehut owners are `~user`; the tilde is part of the name, not a home dir.
    path = path.replace(/^~+/, '~');
  }

  return path;
}

function stripGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path;
}

function stripPassword(user: string): string {
  const colon = user.indexOf(':');
  return colon >= 0 ? user.slice(0, colon) : user;
}

/**
 * Local paths vary by machine, but at least make the *same* path stable:
 * normalize separators and case-fold on platforms where the filesystem does.
 */
function normalizeLocalPathForIdentity(path: string): string {
  const unified = path.replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? unified.toLowerCase()
    : unified;
}

function buildWebUrl(host: string, displayPath: string): string | null {
  if (WEB_HOSTS.has(host)) return `https://${host}/${displayPath}`;
  if (host === 'dev.azure.com') {
    const [org, project, repo] = displayPath.split('/');
    if (org && project && repo) {
      return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
    }
    return null;
  }
  // Self-hosted GitLab/Gitea/Forgejo overwhelmingly follow the same layout, but
  // we cannot know that from the URL alone, so we do not guess.
  return null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
