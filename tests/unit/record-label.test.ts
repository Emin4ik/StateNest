import { describe, expect, it } from 'vitest';
import { describeRecordPath, labelRecord } from '../../src/sync/record-label.js';
import { projectLabels } from '../../src/core/resolve.js';
import { ProjectSchema, type Project } from '../../src/core/schema.js';

/**
 * Naming a conflicted record in the user's own vocabulary.
 *
 * Sync speaks in paths because git does. `projects/prj_57dh4nhah58x/state.md`
 * tells a person nothing, and the first notice they see when two machines
 * disagree is the worst possible moment to be speaking in ids.
 *
 * The rule is: resolve when resolution is certain, fall back to the id when it
 * is not. Never guess, and never drop the only identifying detail.
 */
function project(id: string, name: string, path: string): Project {
  return ProjectSchema.parse({
    schema_version: 1,
    id,
    name,
    aliases: [],
    type: 'node',
    status: 'active',
    tags: [],
    created_at: '2026-09-18T00:00:00Z',
    discovered_at: '2026-09-18T00:00:00Z',
    last_activity_at: '2026-09-18T00:00:00Z',
    repository: {
      previous_identities: [],
      identity: `github.com/${path}`,
      url: `git@github.com:${path}.git`,
      host: 'github.com',
      path,
      owner: path.split('/')[0]!,
      name: path.split('/')[1]!,
      web_url: `https://github.com/${path}`,
    },
    local_locations: [],
    deployments: [],
    blockers: [],
  });
}

/** The resolver the sync commands build, in miniature. */
function resolverFor(projects: Project[]): (id: string) => string | null {
  const labels = projectLabels(projects);
  return (id) => labels.get(id) ?? null;
}

describe('conflicted record labels', () => {
  const harbour = project('prj_57dh4nhah58x', 'harbour', 'acme/harbour');

  it('resolves a known project id to its name', () => {
    const nameOf = resolverFor([harbour]);

    expect(describeRecordPath('projects/prj_57dh4nhah58x/state.md', nameOf)).toBe(
      'harbour — current state',
    );
    expect(describeRecordPath('projects/prj_57dh4nhah58x/tasks.yaml', nameOf)).toBe(
      'harbour — tasks',
    );
    expect(describeRecordPath('projects/prj_57dh4nhah58x/project.yaml', nameOf)).toBe(
      'harbour — project details',
    );
  });

  it('falls back to the id when the project is genuinely unknown', () => {
    // The realistic case: the conflict is *about* a project this machine has
    // not received yet. An id is unhelpful; inventing a name would be wrong.
    const nameOf = resolverFor([harbour]);

    expect(describeRecordPath('projects/prj_notknown/state.md', nameOf)).toBe(
      'prj_notknown — current state',
    );
  });

  it('falls back to the id when there is no resolver at all', () => {
    expect(describeRecordPath('projects/prj_57dh4nhah58x/state.md')).toBe(
      'prj_57dh4nhah58x — current state',
    );
  });

  it('qualifies a name that two projects share', () => {
    // Two unrelated repositories both called "threads" would otherwise produce
    // two identical lines, and the user could not tell which one to repair.
    const work = project('prj_workthreads', 'threads', 'work-org/threads');
    const personal = project('prj_homethreads', 'threads', 'personal-org/threads');
    const nameOf = resolverFor([work, personal, harbour]);

    const first = describeRecordPath('projects/prj_workthreads/state.md', nameOf);
    const second = describeRecordPath('projects/prj_homethreads/state.md', nameOf);

    expect(first).not.toBe(second);
    expect(first).toContain('work-org/threads');
    expect(second).toContain('personal-org/threads');

    // A name nothing collides with stays unqualified.
    expect(describeRecordPath('projects/prj_57dh4nhah58x/state.md', nameOf)).toBe(
      'harbour — current state',
    );
  });

  it('names records that do not belong to a project', () => {
    expect(describeRecordPath('profile.yaml')).toBe('profile settings');
    expect(describeRecordPath('machines/machine_abc.yaml')).toBe('machine record');
    expect(describeRecordPath('remotes/harbour-prod.yaml')).toBe('server record');
  });

  it('describes checkpoints, which are nested under the project id too', () => {
    const nameOf = resolverFor([harbour]);
    expect(
      describeRecordPath('checkpoints/prj_57dh4nhah58x/2026/09/18/161555_cp_x.md', nameOf),
    ).toBe('harbour — checkpoint');
  });

  it('never throws on an unexpected path, and never returns an empty label', () => {
    for (const path of ['', 'something-else', 'projects/', 'projects/x/y/z/deep.yaml']) {
      const label = labelRecord(path);
      expect(typeof label.title).toBe('string');
      expect(label.title.length).toBeGreaterThan(0);
    }
  });

  it('normalises Windows separators', () => {
    const nameOf = resolverFor([harbour]);
    expect(describeRecordPath('projects\\prj_57dh4nhah58x\\state.md', nameOf)).toBe(
      'harbour — current state',
    );
  });
});
