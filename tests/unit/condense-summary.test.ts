import { describe, expect, it } from 'vitest';
import { condenseSummary } from '../../src/integrations/claude/handlers.js';

/**
 * Sorting a compaction summary into the right buckets.
 *
 * Claude Code writes these for a model, not for this parser, so the shape
 * varies: sometimes headings, sometimes self-labelled bullets, sometimes a
 * paragraph and nothing else. Getting it wrong is worse than filing nothing —
 * a `Next:` bullet landing under "Recently completed" makes a resume brief
 * claim you finished the thing you were about to start.
 *
 * Everything here is deterministic. Nothing infers a category from prose; a
 * bullet is reclassified only when it names its own category explicitly.
 */
describe('condenseSummary', () => {
  it('files a self-labelled bullet by its own label, not the heading above it', async () => {
    // The exact shape that produced the bug: one bullet list, no headings, and
    // three different kinds of item in it.
    const result = await condenseSummary(
      [
        'Replaced the greedy berth allocator with cost-based allocation.',
        '',
        '- Implemented cost-based allocation',
        '- Next: re-run the winter fixtures',
        '- Blocked: waiting on the upstream tide feed',
      ].join('\n'),
    );

    expect(result.completed).toEqual(['Implemented cost-based allocation']);
    expect(result.next).toEqual(['re-run the winter fixtures']);
    expect(result.blockers).toEqual(['waiting on the upstream tide feed']);
    expect(result.summary).toContain('cost-based allocation');
  });

  it('still honours headings for bullets that do not label themselves', async () => {
    const result = await condenseSummary(
      [
        'Worked through the allocator rewrite.',
        '',
        '## Completed',
        '- Cost-based allocation',
        '- Regression fixtures for tidal windows',
        '',
        '## Next steps',
        '- Re-run the winter fixtures',
        '',
        '## Blockers',
        '- The upstream tide feed is returning 502s',
      ].join('\n'),
    );

    expect(result.completed).toEqual([
      'Cost-based allocation',
      'Regression fixtures for tidal windows',
    ]);
    expect(result.next).toEqual(['Re-run the winter fixtures']);
    expect(result.blockers).toEqual(['The upstream tide feed is returning 502s']);
  });

  it('lets a self-labelled bullet override the heading it sits under', async () => {
    const result = await condenseSummary(
      [
        'Session summary.',
        '',
        '## Completed',
        '- Cost-based allocation',
        '- Blocked: the tide feed is down',
      ].join('\n'),
    );

    expect(result.completed).toEqual(['Cost-based allocation']);
    expect(result.blockers).toEqual(['the tide feed is down']);
  });

  it('captures decisions, which the checkpoint model already supports', async () => {
    const result = await condenseSummary(
      [
        'Chose an allocation strategy.',
        '',
        '## Decisions',
        '- Use cost-based berth allocation; greedy starved small vessels',
        '',
        '## Completed',
        '- Implemented it',
      ].join('\n'),
    );

    expect(result.decisions).toEqual([
      'Use cost-based berth allocation; greedy starved small vessels',
    ]);
    expect(result.completed).toEqual(['Implemented it']);
  });

  it('does not reclassify ordinary prose that happens to contain a colon', async () => {
    // "Refactor" and "Fix" are not categories. A parser that guessed from the
    // words after the colon would scatter these; this one leaves them alone.
    const result = await condenseSummary(
      [
        'Cleanup pass.',
        '',
        '- Refactor: split the allocator into two modules',
        '- Fix: off-by-one in the tidal window',
        '- Added a test for the failing case',
      ].join('\n'),
    );

    expect(result.completed).toEqual([
      'Refactor: split the allocator into two modules',
      'Fix: off-by-one in the tidal window',
      'Added a test for the failing case',
    ]);
    expect(result.next).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it('keeps an unstructured summary safely, rather than inventing structure', async () => {
    const result = await condenseSummary(
      'Spent the session pairing on the allocator. Nothing landed yet; we are still ' +
        'arguing about whether cost should include berth depth.',
    );

    expect(result.summary).toContain('allocator');
    expect(result.completed).toEqual([]);
    expect(result.next).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it('never returns an empty summary', async () => {
    for (const input of ['', '   \n\n  ', '```\nconst x = 1;\n```']) {
      const result = await condenseSummary(input);
      expect(result.summary.length).toBeGreaterThan(0);
    }
  });

  it('redacts a credential wherever it appears, including inside a bullet', async () => {
    const secret = `AKIA${'Q'.repeat(16)}`;
    const result = await condenseSummary(
      ['Wired up deployment.', '', `- Next: rotate ${secret} before shipping`].join('\n'),
    );

    expect(JSON.stringify(result)).not.toContain(secret);
    // The item survives; only the value is removed.
    expect(result.next).toHaveLength(1);
  });

  it('handles a realistic Claude Code compaction summary end to end', async () => {
    const result = await condenseSummary(
      [
        'The user and I worked on the harbour berth allocation service. The main',
        'change was replacing the greedy allocator with a cost-based one.',
        '',
        '## Work completed',
        '',
        '1. Implemented cost-based berth allocation in `allocator.ts`',
        '2. Added regression fixtures covering tidal windows',
        '3. Fixed the refinery income calculation',
        '',
        '## Decisions made',
        '',
        '- Decided to weight by vessel size rather than arrival order',
        '',
        '## Still open',
        '',
        '- Re-run the winter fixtures against the new weights',
        '- Blocked: the upstream tide feed has been returning 502s since Tuesday',
        '',
        '```ts',
        'const cost = depth * draught; // not a bullet, must be ignored',
        '```',
      ].join('\n'),
    );

    expect(result.completed).toEqual([
      'Implemented cost-based berth allocation in allocator.ts',
      'Added regression fixtures covering tidal windows',
      'Fixed the refinery income calculation',
    ]);
    expect(result.decisions).toEqual([
      'Decided to weight by vessel size rather than arrival order',
    ]);
    expect(result.next).toEqual(['Re-run the winter fixtures against the new weights']);
    expect(result.blockers).toEqual([
      'the upstream tide feed has been returning 502s since Tuesday',
    ]);
    // Code fences contribute nothing.
    expect(JSON.stringify(result)).not.toContain('draught');
  });
});
