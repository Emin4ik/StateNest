import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isSecretFilename } from './exclusions.js';
import { errnoCode } from '../util/errors.js';
import type { Project } from '../core/schema.js';

export type ProjectType = Project['type'];

export interface DetectedMetadata {
  type: ProjectType;
  /** One line describing the project, or null when nothing reliable was found. */
  description: string | null;
  /** Name declared by the project itself, which may differ from the directory. */
  declaredName: string | null;
  /** Which files the detection actually read, for `statenest privacy audit`. */
  readFiles: string[];
}

/**
 * The most a manifest file is allowed to be before it is ignored.
 *
 * Detection only needs a name and a one-line description. A multi-megabyte
 * `package.json` is a generated artifact, and reading it would be a waste at
 * best and a memory problem at worst.
 */
const MAX_MANIFEST_BYTES = 256 * 1024;

/** Manifests checked in order; the first match decides the project type. */
const MANIFESTS: ReadonlyArray<{
  file: string;
  type: ProjectType;
  extract: (contents: string) => { name: string | null; description: string | null };
}> = [
  { file: 'package.json', type: 'node', extract: extractFromPackageJson },
  { file: 'deno.json', type: 'node', extract: extractFromPackageJson },
  { file: 'pyproject.toml', type: 'python', extract: extractFromToml },
  { file: 'Cargo.toml', type: 'rust', extract: extractFromToml },
  { file: 'composer.json', type: 'php', extract: extractFromPackageJson },
  { file: 'go.mod', type: 'go', extract: extractFromGoMod },
  { file: 'setup.py', type: 'python', extract: () => ({ name: null, description: null }) },
  { file: 'requirements.txt', type: 'python', extract: () => ({ name: null, description: null }) },
  { file: 'Pipfile', type: 'python', extract: () => ({ name: null, description: null }) },
  { file: 'Gemfile', type: 'ruby', extract: () => ({ name: null, description: null }) },
  { file: 'pom.xml', type: 'java', extract: extractFromPomXml },
  { file: 'build.gradle', type: 'java', extract: () => ({ name: null, description: null }) },
  { file: 'build.gradle.kts', type: 'java', extract: () => ({ name: null, description: null }) },
  { file: 'Package.swift', type: 'swift', extract: () => ({ name: null, description: null }) },
  { file: 'CMakeLists.txt', type: 'cpp', extract: () => ({ name: null, description: null }) },
];

const README_NAMES = ['README.md', 'readme.md', 'README.markdown', 'Readme.md', 'README'];

/**
 * Work out what a project is, from files it already contains.
 *
 * Entirely deterministic and entirely local: no model is asked to describe a
 * project, and no source code is sent anywhere. A handful of well-known
 * manifest files and a README title answer the question well enough, and a
 * user who wants better can write one sentence themselves.
 */
export async function detectProjectMetadata(projectPath: string): Promise<DetectedMetadata> {
  const readFiles: string[] = [];
  let entries: string[];
  try {
    const dirents = await readdir(projectPath, { withFileTypes: true });
    entries = dirents.filter((entry) => entry.isFile() || entry.isDirectory()).map((e) => e.name);
  } catch {
    return { type: 'unknown', description: null, declaredName: null, readFiles };
  }

  const present = new Set(entries);
  let type: ProjectType = 'unknown';
  let declaredName: string | null = null;
  let description: string | null = null;

  for (const manifest of MANIFESTS) {
    if (!present.has(manifest.file)) continue;
    type = manifest.type;

    const contents = await readSmallFile(join(projectPath, manifest.file));
    if (contents !== null) {
      readFiles.push(manifest.file);
      const extracted = manifest.extract(contents);
      declaredName = extracted.name;
      description = extracted.description;
    }
    break;
  }

  if (type === 'unknown') {
    type = detectTypeFromLooseFiles(present, entries);
  }

  if (!description) {
    for (const readmeName of README_NAMES) {
      if (!present.has(readmeName)) continue;
      const contents = await readSmallFile(join(projectPath, readmeName));
      if (contents === null) continue;
      readFiles.push(readmeName);
      description = extractFromReadme(contents);
      break;
    }
  }

  return {
    type,
    description: normalizeDescription(description),
    declaredName: declaredName?.trim() || null,
    readFiles,
  };
}

/** A project name for display: what the manifest says, else the directory name. */
export function suggestProjectName(projectPath: string, declaredName: string | null): string {
  const fromManifest = declaredName?.trim();
  if (fromManifest) {
    // Strip an npm scope: `@acme/widget` reads better as `widget`.
    const unscoped = fromManifest.startsWith('@') ? fromManifest.split('/').pop()! : fromManifest;
    if (unscoped.trim() !== '') return unscoped.trim();
  }
  return basename(projectPath);
}

function detectTypeFromLooseFiles(present: Set<string>, entries: string[]): ProjectType {
  if (present.has('ProjectSettings') && present.has('Assets')) return 'unity';
  if (present.has('docker-compose.yml') || present.has('docker-compose.yaml')) return 'docker';
  if (present.has('Dockerfile')) return 'docker';
  if (entries.some((name) => name.endsWith('.tf'))) return 'terraform';
  if (entries.some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) return 'dotnet';
  if (entries.some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))) {
    return 'swift';
  }
  if (present.has('Makefile') || present.has('CMakeLists.txt')) return 'cpp';
  if (present.has('mkdocs.yml') || present.has('docusaurus.config.js')) return 'docs';
  return 'unknown';
}

/**
 * Read a file, refusing anything on the secret-filename deny list and anything
 * over the size cap. The deny check happens before the file is opened.
 */
async function readSmallFile(filePath: string): Promise<string | null> {
  if (isSecretFilename(basename(filePath))) return null;

  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    const buffer = Buffer.alloc(Math.min(info.size, MAX_MANIFEST_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8');
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') return null;
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function extractFromPackageJson(contents: string): { name: string | null; description: string | null } {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== 'object' || parsed === null) return { name: null, description: null };
    const record = parsed as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : null,
      description: typeof record.description === 'string' ? record.description : null,
    };
  } catch {
    return { name: null, description: null };
  }
}

/**
 * Pull `name` and `description` out of a TOML manifest without a TOML parser.
 *
 * Both pyproject.toml and Cargo.toml put these in a `[project]`/`[package]`
 * table near the top of the file. A real parser would be a dependency bought
 * for two string lookups.
 */
function extractFromToml(contents: string): { name: string | null; description: string | null } {
  // Capture from the table header up to the next table, or the end of the file.
  //
  // Two anchors matter here and both have bitten this function. `\Z` is a Perl
  // anchor, not a JavaScript one, and silently matched a literal "Z". And with
  // the `m` flag, `$` matches end-of-*line*, so a lazy quantifier stops after
  // the first line instead of running to the end of the table. Hence: no `m`
  // flag, and an explicit `(?:^|\n)` for the line start.
  const section = /(?:^|\n)\[(?:project|package|tool\.poetry)\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(
    contents,
  );
  const scope = section?.[1] ?? contents;
  return {
    name: matchTomlString(scope, 'name'),
    description: matchTomlString(scope, 'description'),
  };
}

function matchTomlString(scope: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, 'm').exec(
    scope,
  );
  const value = match?.[1] ?? match?.[2] ?? null;
  return value === null ? null : value.replace(/\\(.)/g, '$1');
}

function extractFromGoMod(contents: string): { name: string | null; description: string | null } {
  const match = /^module\s+(\S+)/m.exec(contents);
  const modulePath = match?.[1] ?? null;
  return {
    // `github.com/acme/widget` reads better as `widget`.
    name: modulePath ? (modulePath.split('/').pop() ?? modulePath) : null,
    description: null,
  };
}

function extractFromPomXml(contents: string): { name: string | null; description: string | null } {
  return {
    name: /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(contents)?.[1] ?? null,
    description: /<description>\s*([^<]+?)\s*<\/description>/.exec(contents)?.[1] ?? null,
  };
}

/**
 * The first real sentence of a README.
 *
 * Badge lines, HTML banners and the title itself are skipped, because "#
 * widget" tells the user nothing they did not already know from the directory
 * name.
 */
export function extractFromReadme(contents: string): string | null {
  const lines = contents.split('\n').slice(0, 60);
  const paragraph: string[] = [];
  let seenHeading = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (seenHeading && paragraph.length > 0) break;
      seenHeading = true;
      continue;
    }
    // Badges, raw HTML, comments, fences, tables, quotes: not a description.
    if (/^[[!<>|`-]/.test(line) || /^={3,}$/.test(line) || /^-{3,}$/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
    if (paragraph.join(' ').length > 240) break;
  }

  const text = paragraph.join(' ').trim();
  return text === '' ? null : text;
}

/** One line, no markdown noise, short enough for a table cell. */
export function normalizeDescription(value: string | null, maxLength = 200): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  if (cleaned === '') return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}
