import type { Project } from './schema.js';

/**
 * Turning what the user typed into the project they meant.
 *
 * `pb show world` should find `world-war-rts` without the user remembering an
 * id. The rule that makes this safe rather than merely convenient: when a term
 * is genuinely ambiguous, Project Brain asks instead of guessing. Silently
 * picking one of three projects called `*-api` is how a tool loses trust.
 */

export type MatchKind =
  | 'id'
  | 'name'
  | 'alias'
  | 'repository'
  | 'prefix'
  | 'substring'
  | 'fuzzy';

export interface Match {
  project: Project;
  kind: MatchKind;
  /** Lower is better. Compared only within a tier. */
  distance: number;
}

export type Resolution =
  | { status: 'found'; project: Project; kind: MatchKind }
  | { status: 'ambiguous'; matches: Match[] }
  | { status: 'not-found'; suggestions: Match[] };

/** Tiers are tried in order; the first non-empty tier decides the outcome. */
const TIER_ORDER: MatchKind[] = ['id', 'name', 'alias', 'repository', 'prefix', 'substring', 'fuzzy'];

export function resolveProject(projects: readonly Project[], term: string): Resolution {
  const needle = term.trim().toLowerCase();
  if (needle === '') return { status: 'not-found', suggestions: [] };

  const matches = rankMatches(projects, needle);
  if (matches.length === 0) return { status: 'not-found', suggestions: [] };

  for (const tier of TIER_ORDER) {
    const inTier = matches.filter((match) => match.kind === tier);
    if (inTier.length === 0) continue;

    if (inTier.length === 1) {
      return { status: 'found', project: inTier[0]!.project, kind: tier };
    }

    // Within a tier, a strictly better score still wins outright. Two projects
    // scoring identically is real ambiguity, and the user is asked.
    inTier.sort((a, b) => a.distance - b.distance);
    const best = inTier[0]!;
    const contenders = inTier.filter((match) => match.distance === best.distance);
    if (contenders.length === 1) return { status: 'found', project: best.project, kind: tier };

    return { status: 'ambiguous', matches: inTier };
  }

  return { status: 'not-found', suggestions: matches.slice(0, 5) };
}

/** Every project that plausibly matches, best tier first. Used for search too. */
export function rankMatches(projects: readonly Project[], needle: string): Match[] {
  const matches: Match[] = [];

  for (const project of projects) {
    const match = matchOne(project, needle);
    if (match) matches.push(match);
  }

  matches.sort((a, b) => {
    const tierDelta = TIER_ORDER.indexOf(a.kind) - TIER_ORDER.indexOf(b.kind);
    if (tierDelta !== 0) return tierDelta;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.project.name.localeCompare(b.project.name);
  });

  return matches;
}

function matchOne(project: Project, needle: string): Match | null {
  const name = project.name.toLowerCase();
  const id = project.id.toLowerCase();
  const aliases = project.aliases.map((alias) => alias.toLowerCase());
  const repoName = project.repository?.name?.toLowerCase() ?? '';
  const repoPath = project.repository?.path?.toLowerCase() ?? '';

  if (id === needle) return { project, kind: 'id', distance: 0 };
  // An id prefix long enough to be deliberate is treated as an id.
  if (needle.length >= 6 && id.startsWith(needle)) {
    return { project, kind: 'id', distance: id.length - needle.length };
  }

  if (name === needle) return { project, kind: 'name', distance: 0 };
  if (aliases.includes(needle)) return { project, kind: 'alias', distance: 0 };
  if (repoName === needle || repoPath === needle) {
    return { project, kind: 'repository', distance: 0 };
  }

  // Within a tier, distance encodes *which field* matched, never where in the
  // string the match landed. Position is not a quality signal: `old-api` is
  // not a better match for "api" than `payment-api` is, and ranking by offset
  // would silently pick one of three equally good candidates instead of
  // asking. Equal scores are what make ambiguity visible.
  if (name.startsWith(needle)) return { project, kind: 'prefix', distance: 0 };
  if (aliases.some((alias) => alias.startsWith(needle))) {
    return { project, kind: 'prefix', distance: 1 };
  }
  if (repoName.startsWith(needle)) return { project, kind: 'prefix', distance: 2 };

  // A term matching a whole hyphen- or slash-separated word beats one that
  // happens to land in the middle of another word: `war` should prefer
  // `world-war-rts` over `software-tools`.
  if (startsAWord(name, needle)) return { project, kind: 'substring', distance: 0 };
  if (name.includes(needle)) return { project, kind: 'substring', distance: 100 };
  if (aliases.some((alias) => alias.includes(needle)) || repoPath.includes(needle)) {
    return { project, kind: 'substring', distance: 200 };
  }

  const fuzzyScore = subsequenceScore(name, needle);
  if (fuzzyScore !== null) return { project, kind: 'fuzzy', distance: fuzzyScore };

  return null;
}

/** True when `needle` starts one of the hyphen/underscore/slash-separated words. */
function startsAWord(haystack: string, needle: string): boolean {
  return haystack.split(/[-_/\s.]+/).some((word) => word.startsWith(needle));
}

/**
 * Score `needle` as a subsequence of `haystack` - the "typed a few letters"
 * case, so `wwrts` finds `world-war-rts`.
 *
 * Returns null when the letters do not appear in order at all. A lower score
 * means the matched letters were closer together, which is a good proxy for
 * "this is what they meant".
 */
export function subsequenceScore(haystack: string, needle: string): number | null {
  if (needle.length < 2) return null;

  let haystackIndex = 0;
  let gaps = 0;
  let lastMatch = -1;

  for (const char of needle) {
    const found = haystack.indexOf(char, haystackIndex);
    if (found === -1) return null;
    if (lastMatch >= 0) gaps += found - lastMatch - 1;
    lastMatch = found;
    haystackIndex = found + 1;
  }

  // Penalise long names so a short, tight match wins over a sprawling one.
  return gaps * 10 + (haystack.length - needle.length);
}
