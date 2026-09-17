import { Command } from 'commander';
import { openContext, wantsJson } from '../context.js';
import { heading, print, printJson, pluralize, style } from '../output.js';
import { search, type SearchHit, type SearchScope } from '../../search/search.js';
import { relativeTime } from '../../util/time.js';
import { contractHome } from '../../util/paths.js';

export function searchCommand(): Command {
  return new Command('search')
    .description('Search across projects, checkpoints, decisions, tasks and servers')
    .argument('<query...>', 'words to look for; use "quotes" for a phrase')
    .option('-n, --limit <n>', 'maximum results', (v) => Number.parseInt(v, 10), 20)
    .option('--project <name>', 'restrict to one project')
    .option('--scope <scope>', 'project | state | checkpoint | decision | task | remote', collect, [])
    .action(async (words: string[], options: SearchOptions) => {
      const { workspace, registry } = await openContext();
      const query = words.join(' ');

      const projectId = options.project
        ? (await registry.resolveOrThrow(options.project)).id
        : undefined;

      const hits = await search(workspace.store, await registry.all(), query, {
        limit: options.limit ?? 20,
        ...(options.scope.length > 0 ? { scopes: options.scope as SearchScope[] } : {}),
        ...(projectId ? { projectId } : {}),
      });

      if (wantsJson()) {
        printJson({ query, count: hits.length, results: hits });
        return;
      }

      if (hits.length === 0) {
        print('');
        print(`Nothing found for ${style.bold(query)}.`);
        print('');
        print(style.dim('Search covers project names and notes, checkpoints, decisions,'));
        print(style.dim('tasks and server labels — but not your source code.'));
        print('');
        return;
      }

      print('');
      heading(`${pluralize(hits.length, 'result')} for "${query}"`);
      print('');

      let lastProject: string | null = null;
      for (const hit of hits) {
        const projectLabel = hit.projectName ?? 'servers';
        if (projectLabel !== lastProject) {
          if (lastProject !== null) print('');
          print(`  ${style.bold(projectLabel)}`);
          lastProject = projectLabel;
        }
        print(`    ${formatHit(hit)}`);
      }

      print('');
    });
}

interface SearchOptions {
  limit?: number;
  project?: string;
  scope: string[];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function formatHit(hit: SearchHit): string {
  const when = hit.timestamp ? style.dim(relativeTime(hit.timestamp).padEnd(12)) : ' '.repeat(12);
  const scope = style.dim(hit.scope.padEnd(11));
  return `${when} ${scope} ${highlight(hit.excerpt, hit.highlights)}`;
}

/**
 * Bold the matched substrings.
 *
 * Offsets are applied from the end so that inserting escape codes does not
 * shift the positions of the matches still to be processed.
 */
export function highlight(text: string, ranges: readonly [number, number][]): string {
  const trimmed = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  let result = trimmed;

  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    if (start >= trimmed.length) continue;
    const safeEnd = Math.min(end, trimmed.length);
    result =
      result.slice(0, start) + style.bold(result.slice(start, safeEnd)) + result.slice(safeEnd);
  }

  return result;
}

export { contractHome };
