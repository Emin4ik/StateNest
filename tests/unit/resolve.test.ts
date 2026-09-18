import { describe, expect, it } from 'vitest';
import { resolveProject, subsequenceScore } from '../../src/core/resolve.js';
import { ProjectSchema, type Project } from '../../src/core/schema.js';

function project(overrides: Partial<Project> & { name: string }): Project {
  return ProjectSchema.parse({
    id: `prj_${overrides.name.replace(/\W/g, '')}`,
    created_at: '2026-01-01T00:00:00Z',
    discovered_at: '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

const PROJECTS: Project[] = [
  project({ name: 'world-war-rts', aliases: ['ww', 'worldwar'] }),
  project({ name: 'taxi-checker' }),
  project({ name: 'scada-platform' }),
  project({
    name: 'payment-api',
    repository: {
      identity: 'github.com/acme/payment-api',
      name: 'payment-api',
      path: 'acme/payment-api',
      previous_identities: [],
    },
  }),
  project({ name: 'internal-api' }),
  project({ name: 'old-api' }),
];

describe('resolveProject', () => {
  it('finds a project by its exact name', () => {
    const result = resolveProject(PROJECTS, 'taxi-checker');
    expect(result).toMatchObject({ status: 'found', kind: 'name' });
  });

  it('is case insensitive', () => {
    expect(resolveProject(PROJECTS, 'TAXI-CHECKER').status).toBe('found');
  });

  it('finds a project by alias', () => {
    const result = resolveProject(PROJECTS, 'ww');
    expect(result).toMatchObject({ status: 'found', kind: 'alias' });
    if (result.status === 'found') expect(result.project.name).toBe('world-war-rts');
  });

  it('finds a project by its exact id', () => {
    const result = resolveProject(PROJECTS, 'prj_taxichecker');
    expect(result).toMatchObject({ status: 'found', kind: 'id' });
  });

  describe('partial terms', () => {
    it.each([
      ['world', 'world-war-rts'],
      ['taxi', 'taxi-checker'],
      ['scada', 'scada-platform'],
      ['war', 'world-war-rts'],
      ['rts', 'world-war-rts'],
      ['checker', 'taxi-checker'],
    ])('resolves %j to %s', (term, expected) => {
      const result = resolveProject(PROJECTS, term);
      expect(result.status).toBe('found');
      if (result.status === 'found') expect(result.project.name).toBe(expected);
    });
  });

  describe('ambiguity is reported, never guessed', () => {
    it('refuses to choose between three projects matching "api"', () => {
      const result = resolveProject(PROJECTS, 'api');
      expect(result.status).toBe('ambiguous');
      if (result.status === 'ambiguous') {
        expect(result.matches.map((match) => match.project.name).sort()).toEqual([
          'internal-api',
          'old-api',
          'payment-api',
        ]);
      }
    });

    it('resolves once the term is specific enough', () => {
      const result = resolveProject(PROJECTS, 'payment');
      expect(result).toMatchObject({ status: 'found' });
      if (result.status === 'found') expect(result.project.name).toBe('payment-api');
    });

    it('prefers an exact name over a substring match', () => {
      const projects = [project({ name: 'api' }), project({ name: 'payment-api' })];
      const result = resolveProject(projects, 'api');
      expect(result).toMatchObject({ status: 'found', kind: 'name' });
      if (result.status === 'found') expect(result.project.name).toBe('api');
    });

    it('prefers an alias over a fuzzy match', () => {
      const projects = [
        project({ name: 'world-war-rts', aliases: ['ww'] }),
        project({ name: 'widget-workshop' }),
      ];
      const result = resolveProject(projects, 'ww');
      expect(result).toMatchObject({ status: 'found', kind: 'alias' });
    });
  });

  describe('word boundaries beat mid-word hits', () => {
    it('prefers the project where the term starts a word', () => {
      const projects = [project({ name: 'software-tools' }), project({ name: 'world-war-rts' })];
      const result = resolveProject(projects, 'war');
      expect(result.status).toBe('found');
      if (result.status === 'found') expect(result.project.name).toBe('world-war-rts');
    });
  });

  it('matches on repository name', () => {
    const result = resolveProject(PROJECTS, 'acme/payment-api');
    expect(result).toMatchObject({ status: 'found', kind: 'repository' });
  });

  describe('no match', () => {
    it('reports not-found for a term that matches nothing', () => {
      expect(resolveProject(PROJECTS, 'zzzzqqq').status).toBe('not-found');
    });

    it('reports not-found for an empty term', () => {
      expect(resolveProject(PROJECTS, '   ').status).toBe('not-found');
    });

    it('handles an empty registry', () => {
      expect(resolveProject([], 'anything').status).toBe('not-found');
    });
  });
});

describe('subsequenceScore', () => {
  it('matches initials spread through a name', () => {
    expect(subsequenceScore('world-war-rts', 'wwrts')).not.toBeNull();
  });

  it('rejects letters that are out of order', () => {
    expect(subsequenceScore('world-war-rts', 'stwr')).toBeNull();
  });

  it('refuses single characters, which would match nearly everything', () => {
    expect(subsequenceScore('world-war-rts', 'w')).toBeNull();
  });

  it('scores a tighter match better', () => {
    const tight = subsequenceScore('widget', 'wid')!;
    const loose = subsequenceScore('world-indexed-gadget', 'wid')!;
    expect(tight).toBeLessThan(loose);
  });
});
