#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Decide whether the release workflow may publish this version.
 *
 * Three outcomes, and only three:
 *
 *   publish         the version is not on the registry — go ahead
 *   skip-bootstrap  this is the one version published by hand before trusted
 *                   publishing could be configured, and the published package
 *                   is provably ours — report it and finish green
 *   fail            anything else, including every ordinary duplicate
 *
 * The bootstrap case exists because npm will not let a trusted publisher be
 * configured for a package that does not exist yet, so the first version has to
 * be published by a human. Without this, tagging v0.1.0 afterwards would make
 * the first public release produce a deliberately failed workflow run — correct
 * behaviour, but a bad thing to launch with.
 *
 * It is deliberately narrow. It applies to exactly one version number, named
 * explicitly, and only when the published package's repository matches this
 * one. A duplicate of any other version still fails, and a duplicate of the
 * bootstrap version that belongs to somebody else still fails.
 *
 * Run by .github/workflows/release.yml. The flags exist so the tests can drive
 * every branch without touching the network.
 */

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const name = flag('name') ?? manifest.name;
const version = flag('version') ?? manifest.version;
const bootstrapVersion = flag('bootstrap') ?? process.env['BOOTSTRAP_VERSION'] ?? '';
const ourRepository = flag('repository') ?? manifest.repository?.url ?? '';

/**
 * Compare two git repository URLs for "same repository".
 *
 * `git+https://github.com/Owner/Repo.git` and `https://github.com/Owner/Repo`
 * are the same place. Case is folded because GitHub owners and repository names
 * are case-insensitive; a package belonging to someone else differs by far more
 * than capitalisation.
 */
function sameRepository(a, b) {
  const normalize = (url) =>
    String(url ?? '')
      .trim()
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  const left = normalize(a);
  return left !== '' && left === normalize(b);
}

/**
 * What the registry knows about this exact version.
 *
 * Returns null when the version is not published. Throws when the registry
 * could not be reached, because guessing in either direction is worse than
 * stopping: guessing "published" blocks a legitimate release, and guessing
 * "not published" walks into a duplicate.
 */
function lookupPublished() {
  const injected = flag('published');
  if (injected !== null) {
    return injected === 'none' ? null : normalizeEntry(JSON.parse(injected));
  }

  try {
    const stdout = execFileSync('npm', ['view', `${name}@${version}`, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const data = JSON.parse(stdout);
    return normalizeEntry(Array.isArray(data) ? data[data.length - 1] : data);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(output)) return null;
    throw new Error(`Could not ask the registry about ${name}@${version}:\n${output.trim()}`);
  }
}

/**
 * One shape, whichever source the data came from.
 *
 * `npm view --json` nests the repository as `{ repository: { url } }`, and the
 * first version of this script forgot to flatten it on the injected path - so
 * the tests compared an object against a string and the bootstrap branch could
 * never be reached. Normalising in one place is why that is now impossible.
 */
function normalizeEntry(entry) {
  const repository =
    typeof entry?.repository === 'string' ? entry.repository : (entry?.repository?.url ?? '');
  return { version: entry?.version ?? version, repository };
}

function decide(published) {
  if (published === null) {
    return { action: 'publish', message: `${name}@${version} is not on the registry yet.` };
  }

  if (version !== bootstrapVersion || bootstrapVersion === '') {
    return {
      action: 'fail',
      message:
        `${name}@${version} is already on the registry. A published version can never be ` +
        `replaced. Bump the version in package.json, commit, tag the new version and run ` +
        `again. Do not delete and republish.`,
    };
  }

  if (!sameRepository(ourRepository, published.repository)) {
    return {
      action: 'fail',
      message:
        `${name}@${version} is on the registry but its repository is ` +
        `${JSON.stringify(published.repository || '(none)')}, not ${JSON.stringify(ourRepository)}. ` +
        `Refusing to treat somebody else's package as our bootstrap release.`,
    };
  }

  return {
    action: 'skip-bootstrap',
    message: `Bootstrap release already exists on npm; publication step skipped.`,
  };
}

let decision;
try {
  decision = decide(lookupPublished());
} catch (error) {
  process.stdout.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (decision.action === 'fail') {
  process.stdout.write(`::error::${decision.message}\n`);
} else {
  process.stdout.write(`${decision.message}\n`);
}
process.stdout.write(`decision=${decision.action}\n`);

const output = process.env['GITHUB_OUTPUT'];
if (output) appendFileSync(output, `decision=${decision.action}\n`);

process.exit(decision.action === 'fail' ? 1 : 0);
