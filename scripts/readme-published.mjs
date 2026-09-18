#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Switch the README from "build from a clone" to "npm install -g".
 *
 * The README must not claim npm installation works before the package exists,
 * and must not keep telling people to build from source after it does. That is
 * a two-line edit nobody would get wrong on a good day — and release day is not
 * a good day, which is exactly when a stale "not on npm yet" banner survives
 * for a month.
 *
 * Run it immediately after a successful first publish:
 *
 *   npm run readme:published            check what it would change
 *   npm run readme:published -- --write apply it
 *
 * It refuses to run until the package is actually on the registry, unless you
 * pass --force.
 */

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

const PACKAGE_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;

const REPLACEMENTS = [
  {
    what: 'the pre-release banner',
    from: `> **v0.1.0 release candidate.** The package is not on npm yet, so install it
> from a clone — see [Install](#install). Everything else works today.

`,
    to: '',
  },
  {
    what: 'the install instructions',
    from: `\`\`\`bash
git clone https://github.com/Emin4ik/StateNest.git
cd StateNest
npm ci && npm run build && npm link
statenest init
\`\`\`

Requires Node.js 22.12 or newer. Once published this becomes a single
\`npm install -g statenest\`.`,
    to: `\`\`\`bash
npm install -g ${PACKAGE_NAME}
statenest init
\`\`\`

Requires Node.js 22.12 or newer. To work on StateNest itself instead, see
[CONTRIBUTING.md](CONTRIBUTING.md).`,
  },
];

async function isPublished() {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`, { method: 'HEAD' });
  return response.ok;
}

const readmePath = join(ROOT, 'README.md');
let readme = readFileSync(readmePath, 'utf8');

const missing = REPLACEMENTS.filter((r) => !readme.includes(r.from));
if (missing.length === REPLACEMENTS.length) {
  process.stdout.write('README already switched to the published install instructions.\n');
  process.exit(0);
}
if (missing.length > 0) {
  process.stderr.write(
    `README does not contain ${missing.map((r) => r.what).join(' or ')} in the expected form.\n` +
      'It has been edited since this script was written. Make the change by hand:\n' +
      `  replace the clone-and-build block with: npm install -g ${PACKAGE_NAME}\n`,
  );
  process.exit(1);
}

if (!FORCE) {
  const published = await isPublished().catch(() => false);
  if (!published) {
    process.stderr.write(
      `${PACKAGE_NAME} is not on the npm registry yet.\n` +
        'The README must not claim an install path that does not work.\n' +
        'Publish first, then run this again (or pass --force if you know better).\n',
    );
    process.exit(1);
  }
}

for (const { from, to } of REPLACEMENTS) readme = readme.replace(from, to);

if (!WRITE) {
  process.stdout.write(
    'Would make 2 changes to README.md:\n' +
      '  - remove the pre-release banner\n' +
      `  - replace clone-and-build with \`npm install -g ${PACKAGE_NAME}\`\n\n` +
      'Re-run with --write to apply.\n',
  );
  process.exit(0);
}

writeFileSync(readmePath, readme);
process.stdout.write('README.md updated for the published package.\n');
