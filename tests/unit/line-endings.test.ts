import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProjectMetadata, extractFromReadme } from '../../src/discovery/detect.js';
import { parseFrontmatter } from '../../src/storage/frontmatter.js';
import { makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * CRLF must be invisible to every parser.
 *
 * On Windows this is not an edge case: git's `core.autocrlf` rewrites checked
 * out files by default, Notepad writes CRLF, and a developer's own repositories
 * are full of it. A parser that splits on `\n` and forgets the stray `\r`
 * produces a project description ending in an invisible character, or fails to
 * find a manifest field at all — and it does so only on the one platform the
 * author is least likely to be running.
 *
 * Every assertion compares CRLF input against the LF result, so the test says
 * "identical", not "some specific string".
 */
const crlf = (text: string) => text.replace(/\n/g, '\r\n');

describe('parsers ignore line-ending style', () => {
  let dir: TempDir;

  beforeEach(async () => {
    dir = await makeTempDir('statenest-crlf-');
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  async function detectWith(files: Record<string, string>, transform: (s: string) => string) {
    const target = await makeTempDir('statenest-crlf-project-');
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(target.path, name), transform(contents));
    }
    const result = await detectProjectMetadata(target.path);
    await target.cleanup();
    return result;
  }

  it('reads a package.json the same either way', async () => {
    const files = {
      'package.json': '{\n  "name": "widget",\n  "description": "A small widget."\n}\n',
    };
    expect(await detectWith(files, crlf)).toEqual(await detectWith(files, (s) => s));
  });

  it('reads a pyproject.toml the same either way', async () => {
    const files = {
      'pyproject.toml':
        '[build-system]\nrequires = ["setuptools"]\n\n[project]\nname = "widget"\ndescription = "A small widget."\n',
    };
    const withCrlf = await detectWith(files, crlf);
    expect(withCrlf).toEqual(await detectWith(files, (s) => s));
    expect(withCrlf.description).toBe('A small widget.');
  });

  it('reads a go.mod the same either way', async () => {
    const files = { 'go.mod': 'module github.com/acme/widget\n\ngo 1.22\n' };
    const withCrlf = await detectWith(files, crlf);
    expect(withCrlf).toEqual(await detectWith(files, (s) => s));
    expect(withCrlf.declaredName).toBe('widget');
  });

  it('reads a README the same either way', async () => {
    const readme = '# widget\n\n[![badge](x)](y)\n\nA small widget that does one thing.\n\nMore text.\n';
    expect(extractFromReadme(crlf(readme))).toBe(extractFromReadme(readme));
    expect(extractFromReadme(crlf(readme))).toBe('A small widget that does one thing.');
  });

  it('never leaves a stray carriage return in a detected value', async () => {
    const files = {
      'package.json': '{\n  "name": "widget",\n  "description": "A small widget."\n}\n',
      'README.md': '# widget\n\nA small widget that does one thing.\n',
    };
    const detected = await detectWith(files, crlf);
    for (const value of Object.values(detected)) {
      if (typeof value === 'string') expect(value).not.toMatch(/\r/);
    }
  });

  it('parses checkpoint frontmatter written with CRLF', () => {
    const doc = '---\nid: cp_abc\nbranch: main\n---\n\nThe body text.\n';
    const parsed = parseFrontmatter(crlf(doc));
    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual((parseFrontmatter(doc) as { data: unknown }).data);
    // Normalised to LF, trailing newline preserved exactly as with LF input.
    expect(parsed.body).toBe(parseFrontmatter(doc).body);
    expect(parsed.body).toBe('The body text.\n');
    expect(parsed.body).not.toMatch(/\r/);
  });

  it('parses frontmatter that also carries a UTF-8 BOM', () => {
    const doc = '﻿---\nid: cp_abc\n---\n\nBody.\n';
    const parsed = parseFrontmatter(crlf(doc));
    expect(parsed.error).toBeNull();
    expect((parsed.data as Record<string, unknown>)['id']).toBe('cp_abc');
  });
});
