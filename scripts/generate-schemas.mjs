#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CheckpointMetaSchema,
  ConfigSchema,
  DecisionSchema,
  MachineSchema,
  ProfileSchema,
  ProjectSchema,
  RemoteSchema,
  SCHEMA_VERSION,
  TaskFileSchema,
} from '../dist/core/schema.js';
import { SCHEMA_ID_BASE } from '../dist/core/metadata.js';

/**
 * Publish JSON Schemas for everything Project Brain writes to disk.
 *
 * The point is that a user's data directory is inspectable and editable
 * without Project Brain. These let an editor validate a hand-edited
 * `project.yaml`, and give a contributor a precise reference without reading
 * the zod definitions.
 *
 * Generated from the same schemas the code validates against, so they cannot
 * drift.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `--out <dir>` lets the drift check regenerate somewhere disposable and
// compare, instead of writing over the committed files and asking git.
const outFlag = process.argv.indexOf('--out');
const outDir = outFlag === -1 ? join(root, 'schemas') : resolve(process.argv[outFlag + 1]);

const SCHEMAS = [
  ['project', ProjectSchema, 'A project: what it is, where it lives, where it deploys.'],
  ['checkpoint', CheckpointMetaSchema, 'The YAML frontmatter of a checkpoint file.'],
  ['machine', MachineSchema, 'A computer this profile has been used from.'],
  ['remote', RemoteSchema, 'A server a project deploys to. Addresses only, never credentials.'],
  ['decision', DecisionSchema, 'A decision and the reasoning behind it.'],
  ['tasks', TaskFileSchema, "A project's next actions."],
  ['profile', ProfileSchema, 'Settings for one profile.'],
  ['config', ConfigSchema, 'Global configuration.'],
];

await mkdir(outDir, { recursive: true });

const written = [];
for (const [name, schema, description] of SCHEMAS) {
  const jsonSchema = z.toJSONSchema(schema, { io: 'output' });
  const document = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_ID_BASE}/v${SCHEMA_VERSION}/${name}.json`,
    title: `Project Brain ${name}`,
    description,
    ...jsonSchema,
  };

  const file = join(outDir, `${name}.schema.json`);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  written.push(`${name}.schema.json`);
}

await writeFile(
  join(outDir, 'README.md'),
  [
    '# Data schemas',
    '',
    `JSON Schema for every record Project Brain writes, generated from the same`,
    'definitions the code validates against — so they cannot drift.',
    '',
    `Schema version: **${SCHEMA_VERSION}**`,
    '',
    'Point your editor at these to get completion and validation when hand-editing',
    'files under `~/.project-brain`. Every record type is a *loose* object: fields',
    'written by a newer version of Project Brain are preserved rather than stripped,',
    'so an older machine syncing the same data cannot silently drop them.',
    '',
    ...written.map((file) => `- \`${file}\``),
    '',
    'Regenerate with `npm run schemas` (requires `npm run build` first).',
    '',
  ].join('\n'),
);

process.stderr.write(`Wrote ${written.length} schemas to ${outDir}\n`);
