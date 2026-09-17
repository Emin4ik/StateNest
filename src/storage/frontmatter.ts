import { parse as parseYaml } from 'yaml';
import { serializeYaml } from './yaml-file.js';

/**
 * Markdown files with YAML frontmatter.
 *
 * Checkpoints and project state are stored this way rather than as pure data
 * because a developer must be able to open `~/.project-brain` and read their
 * own memory without Project Brain installed. The frontmatter is what queries
 * run against; the prose below it is what a human actually reads six months
 * later.
 */
export interface FrontmatterDocument {
  /** Parsed frontmatter, or an empty object when the file has none. */
  data: Record<string, unknown>;
  /** Everything after the frontmatter block, with leading blank lines trimmed. */
  body: string;
  /** Set when a frontmatter block was present but could not be parsed. */
  error: string | null;
}

const FENCE = '---';

export function parseFrontmatter(raw: string): FrontmatterDocument {
  // A UTF-8 BOM ahead of the opening fence is common on Windows editors and
  // would otherwise make the document look like it has no frontmatter at all.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const normalized = text.replace(/\r\n/g, '\n');

  if (!normalized.startsWith(`${FENCE}\n`)) {
    return { data: {}, body: normalized.trimStart(), error: null };
  }

  const endIndex = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (endIndex === -1) {
    return {
      data: {},
      body: normalized,
      error: 'frontmatter block was opened but never closed',
    };
  }

  const frontmatterText = normalized.slice(FENCE.length + 1, endIndex);
  const afterFence = normalized.slice(endIndex + 1 + FENCE.length);
  const body = afterFence.replace(/^[^\S\n]*\n/, '').trimStart();

  let data: unknown;
  try {
    data = parseYaml(frontmatterText);
  } catch (error) {
    return {
      data: {},
      body,
      error: `invalid YAML frontmatter: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }

  if (data === null || data === undefined) return { data: {}, body, error: null };
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { data: {}, body, error: 'frontmatter must be a YAML mapping' };
  }

  return { data: data as Record<string, unknown>, body, error: null };
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = serializeYaml(data).trimEnd();
  const prose = body.trim();
  return `${FENCE}\n${yaml}\n${FENCE}\n\n${prose}\n`;
}

/**
 * Split a markdown body into its `# Heading` sections.
 *
 * Checkpoints use a fixed set of headings (Summary, Completed, Decisions,
 * Blockers, Next). Extracting them structurally means a checkpoint stays a
 * readable document while still being queryable, instead of needing a parallel
 * machine-readable copy that can drift out of sync with the prose.
 */
export function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split('\n');
  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    if (currentHeading !== null) {
      sections.set(currentHeading, buffer.join('\n').trim());
    }
    buffer = [];
  };

  for (const line of lines) {
    // A `#` inside a fenced code block is code, not a heading.
    if (/^\s*(?:```|~~~)/.test(line)) inCodeFence = !inCodeFence;

    const heading = inCodeFence ? null : /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      currentHeading = heading[1]!.trim().toLowerCase();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

/** Pull the bullet items out of a section body, ignoring prose around them. */
export function extractListItems(sectionBody: string | undefined): string[] {
  if (!sectionBody) return [];
  const items: string[] = [];
  let inCodeFence = false;

  for (const line of sectionBody.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const text = bullet[1]!
        // Strip a leading task-list checkbox so "- [ ] thing" reads as "thing".
        .replace(/^\[[ xX~-]\]\s*/, '')
        .trim();
      if (text !== '') items.push(text);
    }
  }
  return items;
}
