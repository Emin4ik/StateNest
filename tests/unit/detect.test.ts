import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  detectProjectMetadata,
  extractFromReadme,
  normalizeDescription,
  suggestProjectName,
} from '../../src/discovery/detect.js';
import { makeTempDir, writeFiles, type TempDir } from '../helpers/fixtures.js';

describe('detectProjectMetadata', () => {
  let dir: TempDir;

  beforeEach(async () => {
    dir = await makeTempDir('pb-detect-');
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it('reads a node project from package.json', async () => {
    await writeFiles(dir.path, {
      'package.json': JSON.stringify({ name: '@acme/widget', description: 'Widgets, but good.' }),
    });

    const detected = await detectProjectMetadata(dir.path);
    expect(detected.type).toBe('node');
    expect(detected.declaredName).toBe('@acme/widget');
    expect(detected.description).toBe('Widgets, but good.');
    expect(suggestProjectName(dir.path, detected.declaredName)).toBe('widget');
  });

  describe('TOML manifests', () => {
    it('reads name and description from pyproject.toml', async () => {
      await writeFiles(dir.path, {
        'pyproject.toml': [
          '[build-system]',
          'requires = ["setuptools"]',
          '',
          '[project]',
          'name = "scada-platform"',
          'description = "Industrial SCADA monitoring."',
          'version = "1.2.0"',
          '',
          '[tool.ruff]',
          'line-length = 100',
        ].join('\n'),
      });

      const detected = await detectProjectMetadata(dir.path);
      expect(detected.type).toBe('python');
      expect(detected.declaredName).toBe('scada-platform');
      expect(detected.description).toBe('Industrial SCADA monitoring.');
    });

    it('does not read a value out of a later table', async () => {
      // Regression: the section bound used a Perl `\Z` anchor, which matched a
      // literal "Z" and let the scope run past the end of the [package] table.
      await writeFiles(dir.path, {
        'Cargo.toml': [
          '[package]',
          'name = "real-name"',
          '',
          '[dependencies]',
          'serde = "1"',
          '',
          '[[bin]]',
          'name = "wrong-name"',
        ].join('\n'),
      });

      const detected = await detectProjectMetadata(dir.path);
      expect(detected.declaredName).toBe('real-name');
    });

    it('handles a table at the very end of the file', async () => {
      await writeFiles(dir.path, {
        'Cargo.toml': '[package]\nname = "widget"\ndescription = "A widget."',
      });

      const detected = await detectProjectMetadata(dir.path);
      expect(detected.declaredName).toBe('widget');
      expect(detected.description).toBe('A widget.');
    });
  });

  it('reads the module name from go.mod', async () => {
    await writeFiles(dir.path, { 'go.mod': 'module github.com/acme/widget\n\ngo 1.22\n' });
    const detected = await detectProjectMetadata(dir.path);
    expect(detected.type).toBe('go');
    expect(detected.declaredName).toBe('widget');
  });

  it('falls back to the README when a manifest has no description', async () => {
    await writeFiles(dir.path, {
      'go.mod': 'module github.com/acme/widget\n',
      'README.md': '# Widget\n\n[![build](https://img.shields.io/badge.svg)](https://ci)\n\nA service that validates widgets before they ship.\n',
    });

    const detected = await detectProjectMetadata(dir.path);
    expect(detected.description).toBe('A service that validates widgets before they ship.');
  });

  it('recognises an unmanifested docker project', async () => {
    await writeFiles(dir.path, { 'docker-compose.yml': 'services:\n  app:\n    image: nginx\n' });
    expect((await detectProjectMetadata(dir.path)).type).toBe('docker');
  });

  it('returns unknown for an empty directory', async () => {
    const detected = await detectProjectMetadata(dir.path);
    expect(detected).toMatchObject({ type: 'unknown', description: null, declaredName: null });
  });

  it('does not fail on a malformed package.json', async () => {
    await writeFiles(dir.path, { 'package.json': '{ this is not json' });
    const detected = await detectProjectMetadata(dir.path);
    expect(detected.type).toBe('node');
    expect(detected.declaredName).toBeNull();
  });

  it('falls back to the directory name when nothing declares one', async () => {
    expect(suggestProjectName('/code/taxi-checker', null)).toBe('taxi-checker');
  });
});

describe('extractFromReadme', () => {
  it('skips the title and badges', () => {
    const readme = [
      '# StateNest',
      '',
      '[![npm](https://img.shields.io/npm/v/x.svg)](https://npm)',
      '<img src="logo.png">',
      '',
      'Remembers where you left off.',
    ].join('\n');
    expect(extractFromReadme(readme)).toBe('Remembers where you left off.');
  });

  it('stops at the next heading', () => {
    const readme = '# Title\n\nFirst paragraph.\n\n## Install\n\nRun npm install.';
    expect(extractFromReadme(readme)).toBe('First paragraph.');
  });

  it('returns null for a README with only a title', () => {
    expect(extractFromReadme('# Just A Title\n')).toBeNull();
  });
});

describe('normalizeDescription', () => {
  it('collapses whitespace and strips markdown', () => {
    expect(normalizeDescription('A  **bold**  `thing`\nacross lines')).toBe(
      'A bold thing across lines',
    );
  });

  it('unwraps links to their text', () => {
    expect(normalizeDescription('See [the docs](https://example.com) for more')).toBe(
      'See the docs for more',
    );
  });

  it('truncates with an ellipsis rather than cutting silently', () => {
    const long = 'word '.repeat(100);
    const result = normalizeDescription(long, 50)!;
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns null for empty input', () => {
    expect(normalizeDescription('   ')).toBeNull();
    expect(normalizeDescription(null)).toBeNull();
  });
});

describe('unused import guard', () => {
  it('join is available for path building in fixtures', () => {
    expect(join('a', 'b')).toContain('a');
  });
});
