/**
 * Turn a path inside the profile directory into something a person recognises.
 *
 * Sync speaks in file paths because git does. Users do not: nobody has an
 * opinion about `projects/prj_57dh4nhah58x/state.md`, but everybody has one
 * about "harbour — current state". This is the translation layer that lets the
 * conflict and repair flows ask a question worth answering.
 *
 * Nothing here reads a file. It maps a path to a label, and takes the project
 * names it needs from a lookup the caller already has.
 */

export interface RecordLabel {
  /** The path as git reports it, kept for the advanced views. */
  path: string;
  /** What kind of thing this is: "project", "checkpoint", "profile settings". */
  kind: string;
  /** The project this belongs to, when it belongs to one. */
  projectId: string | null;
  /** A single line naming the record, for a list. */
  title: string;
}

const KINDS: { match: RegExp; kind: string }[] = [
  { match: /^projects\/[^/]+\/project\.yaml$/, kind: 'project details' },
  { match: /^projects\/[^/]+\/state\.md$/, kind: 'current state' },
  { match: /^projects\/[^/]+\/tasks\.yaml$/, kind: 'tasks' },
  { match: /^projects\/[^/]+\/decisions\.md$/, kind: 'decisions' },
  { match: /^checkpoints\//, kind: 'checkpoint' },
  { match: /^machines\//, kind: 'machine record' },
  { match: /^remotes\//, kind: 'server record' },
  { match: /^profile\.yaml$/, kind: 'profile settings' },
];

/**
 * Describe one conflicted path.
 *
 * `projectName` resolves a project id to its display name. An unknown id keeps
 * the id: a label that silently drops the only identifying detail is worse than
 * an ugly one.
 */
export function labelRecord(
  path: string,
  projectName: (projectId: string) => string | null = () => null,
): RecordLabel {
  const normalized = path.replace(/\\/g, '/');
  const projectId = normalized.startsWith('projects/')
    ? (normalized.split('/')[1] ?? null)
    : normalized.startsWith('checkpoints/')
      ? (normalized.split('/')[1] ?? null)
      : null;

  const kind = KINDS.find((entry) => entry.match.test(normalized))?.kind ?? 'record';
  const name = projectId ? (projectName(projectId) ?? projectId) : null;

  return {
    path: normalized,
    kind,
    projectId,
    title: name ? `${name} — ${kind}` : kind,
  };
}

/** One-line description, for places that only have room for a string. */
export function describeRecordPath(
  path: string,
  projectName?: (projectId: string) => string | null,
): string {
  return labelRecord(path, projectName).title;
}
