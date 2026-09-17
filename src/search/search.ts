import type { Store } from '../storage/store.js';
import type { Project } from '../core/schema.js';
import type { Timestamp } from '../util/time.js';

/**
 * Local lexical search.
 *
 * Deliberately not embeddings. For a few hundred projects and a few thousand
 * short checkpoints, scanning the text directly is fast enough to feel
 * instant, needs no model, no index to rebuild, and no network - and it never
 * returns a confidently wrong result the way a similarity score can. Semantic
 * search is a later, optional addition; see docs/adr/0007.
 */

export type SearchScope = 'project' | 'state' | 'checkpoint' | 'decision' | 'task' | 'remote';

export interface SearchHit {
  scope: SearchScope;
  projectId: string | null;
  projectName: string | null;
  /** Short label: a checkpoint date, a task status, a project name. */
  label: string;
  /** The matching line, with surrounding context trimmed. */
  excerpt: string;
  /** Character offsets of each match within `excerpt`, for highlighting. */
  highlights: [number, number][];
  timestamp: Timestamp | null;
  /** File on disk, so the user can open it. */
  filePath: string | null;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  scopes?: readonly SearchScope[];
  /** Restrict to one project. */
  projectId?: string;
  /** Checkpoints per project to read. Bounds the cost of a broad search. */
  checkpointsPerProject?: number;
}

const DEFAULT_SCOPES: SearchScope[] = ['project', 'state', 'checkpoint', 'decision', 'task', 'remote'];

/**
 * Relative weights.
 *
 * A hit in a project's name or current focus is almost always more useful than
 * the same word buried in an old checkpoint, so recency and specificity both
 * push a result up.
 */
const SCOPE_WEIGHT: Record<SearchScope, number> = {
  project: 10,
  state: 8,
  task: 6,
  decision: 5,
  remote: 4,
  checkpoint: 3,
};

export async function search(
  store: Store,
  projects: readonly Project[],
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const terms = tokenize(rawQuery);
  if (terms.length === 0) return [];

  const scopes = new Set(options.scopes ?? DEFAULT_SCOPES);
  const limit = options.limit ?? 30;
  const targets = options.projectId
    ? projects.filter((project) => project.id === options.projectId)
    : projects;

  const hits: SearchHit[] = [];

  if (scopes.has('remote')) {
    for (const remote of await store.listRemotes()) {
      const text = [remote.name, remote.ssh_alias, remote.host, remote.provider, remote.notes]
        .filter(Boolean)
        .join(' ');
      const match = matchText(text, terms);
      if (match) {
        hits.push({
          scope: 'remote',
          projectId: null,
          projectName: null,
          label: remote.environment,
          excerpt: text,
          highlights: match.highlights,
          timestamp: remote.updated_at,
          filePath: null,
          score: match.score * SCOPE_WEIGHT.remote,
        });
      }
    }
  }

  await Promise.all(
    targets.map(async (project) => {
      if (scopes.has('project')) {
        // Each field is matched separately so the excerpt shows the thing that
        // actually matched. Concatenating every field into one blob matches
        // more often but produces a result line nobody can read.
        const fields: { label: string; text: string }[] = [
          { label: 'name', text: project.name },
          ...(project.description ? [{ label: 'about', text: project.description }] : []),
          ...(project.current_focus ? [{ label: 'focus', text: project.current_focus }] : []),
          ...project.blockers.map((blocker) => ({ label: 'blocker', text: blocker })),
          ...(project.repository ? [{ label: 'repo', text: project.repository.identity }] : []),
          ...(project.tags.length > 0 ? [{ label: 'tags', text: project.tags.join(' ') }] : []),
          ...(project.aliases.length > 0 ? [{ label: 'alias', text: project.aliases.join(' ') }] : []),
        ];

        let best: { label: string; text: string; match: TextMatch } | null = null;
        for (const field of fields) {
          const match = matchText(field.text, terms);
          if (match && (!best || match.score > best.match.score)) {
            best = { ...field, match };
          }
        }

        if (best) {
          hits.push({
            scope: 'project',
            projectId: project.id,
            projectName: project.name,
            label: best.label,
            excerpt: best.text,
            highlights: best.match.highlights,
            timestamp: project.last_activity_at ?? null,
            filePath: null,
            score: best.match.score * SCOPE_WEIGHT.project,
          });
        }
      }

      if (scopes.has('state')) {
        const state = await store.readState(project.id);
        if (state) {
          for (const line of interestingLines(state)) {
            const match = matchText(line, terms);
            if (!match) continue;
            hits.push({
              scope: 'state',
              projectId: project.id,
              projectName: project.name,
              label: 'state',
              excerpt: line,
              highlights: match.highlights,
              timestamp: project.last_activity_at ?? null,
              filePath: null,
              score: match.score * SCOPE_WEIGHT.state,
            });
          }
        }
      }

      if (scopes.has('task')) {
        const tasks = await store.readTasks(project.id);
        for (const task of tasks.tasks) {
          const match = matchText(task.text, terms);
          if (!match) continue;
          hits.push({
            scope: 'task',
            projectId: project.id,
            projectName: project.name,
            label: task.status,
            excerpt: task.text,
            highlights: match.highlights,
            timestamp: task.updated_at,
            filePath: null,
            // A task that is still open is more actionable than one long done.
            score: match.score * SCOPE_WEIGHT.task * (task.status === 'done' ? 0.4 : 1),
          });
        }
      }

      if (scopes.has('decision')) {
        for (const decision of await store.readDecisions(project.id)) {
          const text = [decision.title, decision.reason, ...decision.alternatives]
            .filter(Boolean)
            .join(' · ');
          const match = matchText(text, terms);
          if (!match) continue;
          hits.push({
            scope: 'decision',
            projectId: project.id,
            projectName: project.name,
            label: 'decision',
            excerpt: decision.title,
            highlights: matchText(decision.title, terms)?.highlights ?? [],
            timestamp: decision.timestamp,
            filePath: null,
            score: match.score * SCOPE_WEIGHT.decision,
          });
        }
      }

      if (scopes.has('checkpoint')) {
        const checkpoints = await store.listCheckpoints(project.id, {
          limit: options.checkpointsPerProject ?? 50,
        });
        for (const checkpoint of checkpoints) {
          const lines = [
            checkpoint.summary,
            ...checkpoint.completed,
            ...checkpoint.decisions,
            ...checkpoint.blockers,
            ...checkpoint.next,
          ].filter(Boolean);

          for (const line of lines) {
            const match = matchText(line, terms);
            if (!match) continue;
            hits.push({
              scope: 'checkpoint',
              projectId: project.id,
              projectName: project.name,
              label: checkpoint.meta.branch ?? 'checkpoint',
              excerpt: line,
              highlights: match.highlights,
              timestamp: checkpoint.meta.timestamp,
              filePath: checkpoint.filePath,
              score: match.score * SCOPE_WEIGHT.checkpoint * recencyBoost(checkpoint.meta.timestamp),
            });
            break; // One hit per checkpoint keeps results varied.
          }
        }
      }
    }),
  );

  return hits.sort((a, b) => b.score - a.score || (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, limit);
}

/** Split a query into terms, honouring "quoted phrases". */
export function tokenize(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const term = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    if (term.length > 0) terms.push(term);
  }
  return terms;
}

export interface TextMatch {
  score: number;
  highlights: [number, number][];
}

/**
 * Score a piece of text against the query terms.
 *
 * All terms must appear - an AND search, because a developer looking for
 * "refinery rebuild" wants the thing that mentions both, not everything that
 * mentions either. Whole-word hits score higher than substring hits.
 */
export function matchText(text: string, terms: readonly string[]): TextMatch | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  const highlights: [number, number][] = [];
  let score = 0;

  for (const term of terms) {
    let index = haystack.indexOf(term);
    if (index === -1) return null;

    let best = 0;
    while (index !== -1) {
      const before = index === 0 ? ' ' : haystack[index - 1]!;
      const after = haystack[index + term.length] ?? ' ';
      const wholeWord = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
      const wordStart = !/[a-z0-9]/.test(before);

      best = Math.max(best, wholeWord ? 3 : wordStart ? 2 : 1);
      highlights.push([index, index + term.length]);
      index = haystack.indexOf(term, index + term.length);
    }
    score += best;
  }

  return { score, highlights: mergeRanges(highlights) };
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]!];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/** Recent checkpoints rank above old ones, without burying history entirely. */
function recencyBoost(timestamp: Timestamp): number {
  const age = Date.now() - new Date(timestamp).getTime();
  const days = age / 86_400_000;
  if (days < 7) return 1.6;
  if (days < 30) return 1.3;
  if (days < 180) return 1.0;
  return 0.8;
}

function interestingLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^[-*+]\s*/, '').replace(/^#+\s*/, '').trim())
    .filter((line) => line.length > 3);
}
