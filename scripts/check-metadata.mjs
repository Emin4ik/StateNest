#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Keep project identity consistent, and refuse to release with placeholders.
 *
 * The repository URL, package name and owner appear in package.json, two plugin
 * manifests, the README, SECURITY.md, generated schemas and a CLI error
 * message. Left to drift, one of them ends up pointing somewhere that does not
 * exist - and nobody notices until a user follows the link.
 *
 * `src/core/metadata.ts` is the single source. This script checks everything
 * against it, and fails while `METADATA_IS_PLACEHOLDER` is still true, so a
 * release cannot happen before an owner is chosen.
 *
 * Run with `npm run check:metadata`.
 */

const problems = [];
const notes = [];

function read(path) {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return null;
  }
}

// --- parse the source of truth ---------------------------------------------
const metadataSource = read('src/core/metadata.ts');
if (!metadataSource) {
  process.stderr.write('src/core/metadata.ts is missing\n');
  process.exit(1);
}

const value = (name) => {
  const match = new RegExp(`export const ${name} = '([^']*)'`).exec(metadataSource);
  return match?.[1] ?? null;
};

const META = {
  packageName: value('PACKAGE_NAME'),
  cli: value('CLI_COMMAND'),
  owner: value('REPOSITORY_OWNER'),
  repo: value('REPOSITORY_NAME'),
  license: value('LICENSE'),
};
META.repositoryUrl = `https://github.com/${META.owner}/${META.repo}`;

const isPlaceholder = /METADATA_IS_PLACEHOLDER = true/.test(metadataSource);
const nameIsTaken = /NAME_IS_KNOWN_TAKEN = true/.test(metadataSource);

// --- package.json -----------------------------------------------------------
const pkg = JSON.parse(read('package.json'));

const expectPkg = (field, expected, actual) => {
  if (actual !== expected) {
    problems.push(`package.json ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

expectPkg('name', META.packageName, pkg.name);
expectPkg('license', META.license, pkg.license);

for (const [field, expected] of [
  ['repository.url', `git+${META.repositoryUrl}.git`],
  ['homepage', `${META.repositoryUrl}#readme`],
  ['bugs.url', `${META.repositoryUrl}/issues`],
]) {
  const actual = field.split('.').reduce((node, key) => node?.[key], pkg);
  if (!actual) problems.push(`package.json is missing ${field}`);
  else if (actual !== expected) {
    problems.push(`package.json ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

if (!Object.keys(pkg.bin ?? {}).includes(META.cli)) {
  problems.push(`package.json bin does not provide the "${META.cli}" command`);
}

if (!pkg.description || pkg.description.length < 20) {
  problems.push('package.json description is missing or too short to be useful on npm');
}
if (!Array.isArray(pkg.keywords) || pkg.keywords.length < 3) {
  problems.push('package.json needs at least a few keywords to be findable on npm');
}
if (!pkg.engines?.node) problems.push('package.json is missing an engines.node range');

// --- LICENSE ---------------------------------------------------------------
const license = read('LICENSE');
if (!license) problems.push('LICENSE file is missing');
else if (META.license === 'MIT' && !/MIT License/i.test(license)) {
  problems.push(`LICENSE does not look like ${META.license}, which package.json declares`);
}

// --- plugin manifests -------------------------------------------------------
const plugin = JSON.parse(read('.claude-plugin/plugin.json') ?? '{}');
if (plugin.repository !== META.repositoryUrl) {
  problems.push(`.claude-plugin/plugin.json repository is ${JSON.stringify(plugin.repository)}`);
}
if (plugin.license !== META.license) {
  problems.push(`.claude-plugin/plugin.json license is ${JSON.stringify(plugin.license)}`);
}
if (plugin.version !== pkg.version) {
  problems.push(
    `.claude-plugin/plugin.json version ${plugin.version} does not match package.json ${pkg.version}`,
  );
}

const marketplace = JSON.parse(read('.claude-plugin/marketplace.json') ?? '{}');
const entry = marketplace.plugins?.[0];
if (entry?.source?.package && entry.source.package !== META.packageName) {
  problems.push(`marketplace source package is ${JSON.stringify(entry.source.package)}`);
}
if (marketplace.owner?.url && marketplace.owner.url !== META.repositoryUrl) {
  problems.push(`marketplace owner.url is ${JSON.stringify(marketplace.owner.url)}`);
}

// --- generated schemas ------------------------------------------------------
try {
  for (const file of readdirSync(join(ROOT, 'schemas'))) {
    if (!file.endsWith('.schema.json')) continue;
    const schema = JSON.parse(read(join('schemas', file)));
    if (!schema.$id?.startsWith(META.repositoryUrl)) {
      problems.push(`schemas/${file} $id does not use the repository URL: ${schema.$id}`);
    }
  }
} catch {
  notes.push('schemas/ not generated yet - run `npm run schemas`');
}

// --- stale URLs anywhere in shipped text ------------------------------------
const TEXT_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'src/cli/output.ts',
];
for (const file of TEXT_FILES) {
  const contents = read(file);
  if (!contents) continue;
  for (const match of contents.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
    const [url, owner, repo] = match;
    // Links to other people's repositories are fine; links that claim to be
    // ours must actually be ours.
    if (repo.replace(/\.git$/, '') !== META.repo) continue;
    if (owner !== META.owner) {
      problems.push(`${file} points at ${url}, which is not ${META.repositoryUrl}`);
    }
  }
  if (/project-brain\.dev/.test(contents)) {
    problems.push(`${file} references the placeholder domain project-brain.dev`);
  }
  // `claude plugin install <plugin>@<marketplace>` is written out in prose and
  // is not a URL, so nothing else here would notice it going stale on a rename.
  for (const match of contents.matchAll(/claude plugin install (\S+)@(\S+)/g)) {
    const [line, plugin, marketplace] = match;
    if (plugin !== META.packageName || marketplace !== META.packageName) {
      problems.push(`${file} says \`${line}\`, but the plugin is "${META.packageName}"`);
    }
  }
}

// --- report -----------------------------------------------------------------
process.stdout.write('\nProject metadata\n\n');
process.stdout.write(`  package       ${META.packageName}@${pkg.version}\n`);
process.stdout.write(`  command       ${META.cli}\n`);
process.stdout.write(`  repository    ${META.repositoryUrl}\n`);
process.stdout.write(`  license       ${META.license}\n\n`);

for (const note of notes) process.stdout.write(`  note: ${note}\n`);

if (problems.length > 0) {
  process.stdout.write('  Inconsistencies:\n');
  for (const problem of problems) process.stdout.write(`    - ${problem}\n`);
  process.stdout.write('\n');
}

if (nameIsTaken) {
  process.stdout.write(
    `  RELEASE BLOCKER: the name "${META.packageName}" is not available.\n\n` +
      '    It is an actively maintained npm package in this same category, a\n' +
      '    paid commercial product, and the generic term competitors use for\n' +
      '    the category. It cannot be disputed or out-ranked.\n\n' +
      '    Evidence and ranked alternatives: docs/research/project-name.md\n\n',
  );
}

if (isPlaceholder) {
  process.stdout.write(
    '  RELEASE BLOCKER: project identity is still a placeholder.\n\n' +
      '    Nothing can be published until a real GitHub owner and package name\n' +
      '    are chosen. To resolve:\n\n' +
      '      1. Decide the owner, repository name and npm package name.\n' +
      '      2. Update src/core/metadata.ts, including setting\n' +
      '         METADATA_IS_PLACEHOLDER to false.\n' +
      '      3. Run: npm run metadata:sync\n' +
      '      4. Re-run this check.\n\n',
  );
  process.exit(1);
}

if (problems.length > 0) {
  process.stdout.write(`  ${problems.length} inconsistency(ies) must be fixed.\n\n`);
  process.exit(1);
}

process.stdout.write('  Metadata is consistent.\n\n');
