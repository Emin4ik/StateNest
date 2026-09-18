#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Propagate `src/core/metadata.ts` into every file that repeats it.
 *
 * Choosing a repository owner should be a one-line edit followed by one
 * command, not a hunt through eight files - the hunt is how a stale example URL
 * survives into a published package.
 *
 * Run with `npm run metadata:sync`, then `npm run check:metadata` to verify.
 */

const metadata = readFileSync(join(ROOT, 'src/core/metadata.ts'), 'utf8');
const value = (name) => {
  const match = new RegExp(`export const ${name} = '([^']*)'`).exec(metadata);
  if (!match) throw new Error(`src/core/metadata.ts is missing ${name}`);
  return match[1];
};

const PACKAGE_NAME = value('PACKAGE_NAME');
const CLI = value('CLI_COMMAND');
const OWNER = value('REPOSITORY_OWNER');
const REPO = value('REPOSITORY_NAME');
const LICENSE = value('LICENSE');
const REPOSITORY_URL = `https://github.com/${OWNER}/${REPO}`;

const changed = [];

function rewriteJson(path, mutate) {
  const file = join(ROOT, path);
  const before = readFileSync(file, 'utf8');
  const parsed = JSON.parse(before);
  mutate(parsed);
  const after = `${JSON.stringify(parsed, null, 2)}\n`;
  if (after !== before) {
    writeFileSync(file, after);
    changed.push(path);
  }
}

function rewriteText(path, replacements) {
  const file = join(ROOT, path);
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const before = contents;
  for (const [pattern, replacement] of replacements) {
    contents = contents.replace(pattern, replacement);
  }
  if (contents !== before) {
    writeFileSync(file, contents);
    changed.push(path);
  }
}

// --- package.json -----------------------------------------------------------
rewriteJson('package.json', (pkg) => {
  pkg.name = PACKAGE_NAME;
  pkg.license = LICENSE;
  pkg.repository = { type: 'git', url: `git+${REPOSITORY_URL}.git` };
  pkg.homepage = `${REPOSITORY_URL}#readme`;
  pkg.bugs = { url: `${REPOSITORY_URL}/issues` };

  // The CLI command must exist in bin, pointing at the same entry as before.
  const entry = Object.values(pkg.bin ?? {})[0] ?? 'dist/cli/bin.js';
  pkg.bin = { [CLI]: entry, [PACKAGE_NAME]: entry };
});

// --- plugin manifests -------------------------------------------------------
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

rewriteJson('.claude-plugin/plugin.json', (plugin) => {
  plugin.name = PACKAGE_NAME;
  plugin.version = version;
  plugin.homepage = REPOSITORY_URL;
  plugin.repository = REPOSITORY_URL;
  plugin.license = LICENSE;
});

rewriteJson('.claude-plugin/marketplace.json', (marketplace) => {
  marketplace.name = PACKAGE_NAME;
  marketplace.owner = { ...marketplace.owner, url: REPOSITORY_URL };
  for (const entry of marketplace.plugins ?? []) {
    entry.name = PACKAGE_NAME;
    if (entry.source?.source === 'npm') entry.source.package = PACKAGE_NAME;
  }
});

// --- prose and code ---------------------------------------------------------

/**
 * Repository names this project has previously answered to.
 *
 * A rename only propagates if the script can recognise what it is replacing.
 * The first rename left `OWNER-NOT-CHOSEN/REPO-NOT-CHOSEN` sitting in
 * CONTRIBUTING.md and SECURITY.md, because the pattern only knew the name
 * before it. Add to this list rather than editing files by hand.
 */
const FORMER_REPO_NAMES = ['project-brain', 'REPO-NOT-CHOSEN'];
const FORMER_OWNERS = ['OWNER-NOT-CHOSEN'];

// Match only a whole repository segment, so a URL like
// `.../project-brain-data.git` (a user's own sync repo, used as an example)
// is left alone.
const STALE_URLS = [
  new RegExp(`https://github\\.com/[\\w.-]+/(?:${FORMER_REPO_NAMES.join('|')})(?![\\w-])`, 'g'),
  new RegExp(`https://github\\.com/(?:${FORMER_OWNERS.join('|')})/[\\w.-]+`, 'g'),
];

const PROSE_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'src/cli/output.ts',
];

for (const file of PROSE_FILES) {
  rewriteText(file, [
    ...STALE_URLS.map((pattern) => [pattern, REPOSITORY_URL]),
    [/https:\/\/project-brain\.dev\/schemas/g, `${REPOSITORY_URL}/blob/main/schemas`],
    // `claude plugin install <plugin>@<marketplace>` is prose, not a URL, so
    // nothing else here would catch it going stale.
    [/claude plugin install \S+@\S+/g, `claude plugin install ${PACKAGE_NAME}@${PACKAGE_NAME}`],
  ]);
}

process.stdout.write(
  changed.length > 0
    ? `Updated:\n${changed.map((file) => `  ${file}`).join('\n')}\n\n` +
        'Regenerate the schemas so their $id values match: npm run build && npm run schemas\n'
    : 'Everything already matches src/core/metadata.ts\n',
);
