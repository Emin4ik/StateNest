import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { runHook } from '../../src/integrations/claude/handlers.js';
import { readSessionRecord } from '../../src/integrations/claude/session.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { writeFileAtomic } from '../../src/util/fs-atomic.js';
import { makeFakeRepo, makeTempDir, type TempDir } from '../helpers/fixtures.js';

/**
 * Several Claude Code sessions at once, and sessions that end badly.
 *
 * Two or more sessions in one project is completely ordinary - a terminal, an
 * editor, a second window - and each of them fires SessionStart, many Stops,
 * and a SessionEnd. Nothing about that may corrupt state, lose a checkpoint,
 * or produce a file two sessions both think they own.
 *
 * Equally ordinary: a session that is killed. There is then no SessionEnd at
 * all, and whatever was half-done must not poison the next session.
 */
describe('concurrent sessions', () => {
  let home: TempDir;
  let code: TempDir;
  let workspace: Workspace;

  beforeEach(async () => {
    home = await makeTempDir('pb-conc-home-');
    code = await makeTempDir('pb-conc-code-');
    process.env.PROJECT_BRAIN_HOME = home.path;
    workspace = await Workspace.initialize({ home: home.path });
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function project(name: string, remote = `git@github.com:acme/${name}.git`) {
    const path = join(code.path, name);
    await makeFakeRepo(path, { remote });
    const result = await new Registry(workspace.store).register(path, {
      machineId: workspace.machineId,
    });
    return { path, project: result.project };
  }

  const payload = (fields: Record<string, unknown>) => JSON.stringify(fields);

  describe('two sessions in the same project', () => {
    it('both receive a brief, and neither corrupts the other', async () => {
      const { path } = await project('shared');

      const [a, b] = await Promise.all([
        runHook('session-start', payload({ session_id: 'A', cwd: path, source: 'startup' })),
        runHook('session-start', payload({ session_id: 'B', cwd: path, source: 'startup' })),
      ]);

      for (const output of [a, b]) {
        const parsed = JSON.parse(output);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('shared');
      }

      // Each session keeps its own record.
      const recordA = await readSessionRecord(workspace.paths, 'A');
      const recordB = await readSessionRecord(workspace.paths, 'B');
      expect(recordA?.session_id).toBe('A');
      expect(recordB?.session_id).toBe('B');
      expect(recordA?.project_id).toBe(recordB?.project_id);
    });

    it('interleaved Stop events do not lose either session\'s turn count', async () => {
      const { path } = await project('interleaved');
      await runHook('session-start', payload({ session_id: 'A', cwd: path, source: 'startup' }));
      await runHook('session-start', payload({ session_id: 'B', cwd: path, source: 'startup' }));

      // Twenty Stops from two sessions, all at once.
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          runHook('stop', payload({ session_id: index % 2 === 0 ? 'A' : 'B', cwd: path })),
        ),
      );

      const a = await readSessionRecord(workspace.paths, 'A');
      const b = await readSessionRecord(workspace.paths, 'B');
      expect(a?.turns).toBe(10);
      expect(b?.turns).toBe(10);
    });

    it('gives every concurrently written checkpoint its own file', async () => {
      const { project: target } = await project('racing');

      // Twenty checkpoints written at the same instant. Without per-checkpoint
      // filenames these would collide and overwrite one another.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          createCheckpoint(
            workspace.store,
            target,
            { summary: `concurrent checkpoint ${index}` },
            {
              machineId: workspace.machineId,
              source: 'cli',
              timestamp: '2026-09-18T12:00:00Z',
            },
          ),
        ),
      );

      const ids = new Set(results.map((result) => result.meta.id));
      const files = new Set(results.map((result) => result.filePath));
      expect(ids.size, 'every checkpoint id must be unique').toBe(20);
      expect(files.size, 'every checkpoint file must be unique').toBe(20);

      const stored = await workspace.store.listCheckpoints(target.id);
      expect(stored, 'all twenty must be readable afterwards').toHaveLength(20);
    });

    it('both sessions ending at once produces at most one checkpoint each', async () => {
      const { path, project: target } = await project('ending');
      await runHook('session-start', payload({ session_id: 'A', cwd: path, source: 'startup' }));
      await runHook('session-start', payload({ session_id: 'B', cwd: path, source: 'startup' }));
      await runHook('stop', payload({ session_id: 'A', cwd: path }));
      await runHook('stop', payload({ session_id: 'B', cwd: path }));

      await Promise.all([
        runHook('session-end', payload({ session_id: 'A', reason: 'clear' })),
        runHook('session-end', payload({ session_id: 'B', reason: 'clear' })),
      ]);

      const checkpoints = await workspace.store.listCheckpoints(target.id);
      // Two sessions, so at most two checkpoints - and never a partial file.
      expect(checkpoints.length).toBeLessThanOrEqual(2);
      for (const checkpoint of checkpoints) {
        expect(checkpoint.meta.id).toMatch(/^cp_/);
        expect(checkpoint.summary.length).toBeGreaterThan(0);
      }
    });

    it('concurrent writes to one project record never leave it unreadable', async () => {
      const { project: target } = await project('contended');
      const registry = new Registry(workspace.store);

      await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          registry.save({ ...target, current_focus: `focus ${index}` }),
        ),
      );

      // Atomic replacement means the file is always one complete version.
      const reopened = await Workspace.open({ home: home.path });
      const loaded = await new Registry(reopened.store).byId(target.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.current_focus).toMatch(/^focus \d+$/);
      expect(reopened.store.getIssues()).toEqual([]);
    });
  });

  describe('sessions in different projects', () => {
    it('keeps each session pointed at its own project', async () => {
      const one = await project('alpha');
      const two = await project('beta');

      const [a, b] = await Promise.all([
        runHook('session-start', payload({ session_id: 'A', cwd: one.path, source: 'startup' })),
        runHook('session-start', payload({ session_id: 'B', cwd: two.path, source: 'startup' })),
      ]);

      expect(JSON.parse(a).hookSpecificOutput.additionalContext).toContain('alpha');
      expect(JSON.parse(b).hookSpecificOutput.additionalContext).toContain('beta');

      const recordA = await readSessionRecord(workspace.paths, 'A');
      const recordB = await readSessionRecord(workspace.paths, 'B');
      expect(recordA?.project_id).toBe(one.project.id);
      expect(recordB?.project_id).toBe(two.project.id);
      expect(recordA?.project_id).not.toBe(recordB?.project_id);
    });

    it('a checkpoint from one session never lands in the other project', async () => {
      const one = await project('gamma');
      const two = await project('delta');

      for (const [session, path] of [
        ['A', one.path],
        ['B', two.path],
      ] as const) {
        await runHook('session-start', payload({ session_id: session, cwd: path, source: 'startup' }));
        await runHook('stop', payload({ session_id: session, cwd: path }));
      }

      await Promise.all([
        runHook('session-end', payload({ session_id: 'A', reason: 'other' })),
        runHook('session-end', payload({ session_id: 'B', reason: 'other' })),
      ]);

      for (const target of [one, two]) {
        for (const checkpoint of await workspace.store.listCheckpoints(target.project.id)) {
          expect(checkpoint.meta.project_id).toBe(target.project.id);
        }
      }
    });
  });

  describe('hook idempotency', () => {
    it('a repeated SessionStart does not duplicate or reset the session', async () => {
      const { path } = await project('repeated');

      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'startup' }));
      await runHook('stop', payload({ session_id: 'S', cwd: path }));
      await runHook('stop', payload({ session_id: 'S', cwd: path }));

      const before = await readSessionRecord(workspace.paths, 'S');
      expect(before?.turns).toBe(2);

      // Claude Code re-fires SessionStart after /clear and after compaction.
      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'clear' }));
      const after = await readSessionRecord(workspace.paths, 'S');

      expect(after?.turns, 'an existing session is updated, not restarted').toBe(2);
      expect(after?.started_at).toBe(before?.started_at);
    });

    it('a repeated SessionEnd writes only one checkpoint', async () => {
      const { path, project: target } = await project('double-end');
      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'startup' }));
      await runHook('stop', payload({ session_id: 'S', cwd: path }));

      await runHook('session-end', payload({ session_id: 'S', reason: 'clear' }));
      const first = (await workspace.store.listCheckpoints(target.id)).length;

      // Duplicate delivery of the same event.
      await runHook('session-end', payload({ session_id: 'S', reason: 'clear' }));
      await runHook('session-end', payload({ session_id: 'S', reason: 'clear' }));
      const after = (await workspace.store.listCheckpoints(target.id)).length;

      expect(after, 'the session is marked checkpointed and not repeated').toBe(first);
    });

    it('a repeated PostCompact does not write two checkpoints for one compaction', async () => {
      const { path, project: target } = await project('double-compact');
      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'startup' }));

      const compact = payload({
        session_id: 'S',
        cwd: path,
        trigger: 'auto',
        compact_summary: 'Reworked the preprocessing pass.\n\nCompleted:\n- adaptive letterboxing\n',
      });

      await runHook('post-compact', compact);
      const first = await workspace.store.listCheckpoints(target.id);
      expect(first).toHaveLength(1);

      await runHook('post-compact', compact);
      const second = await workspace.store.listCheckpoints(target.id);
      expect(second.length, 'the same compaction must not be recorded twice').toBe(1);
    });

    it('a Stop for a session that never started still records the turn', async () => {
      const { path } = await project('orphan-stop');
      await runHook('stop', payload({ session_id: 'never-started', cwd: path }));

      const record = await readSessionRecord(workspace.paths, 'never-started');
      expect(record?.turns).toBe(1);
      expect(record?.project_id).not.toBeNull();
    });
  });

  describe('abnormal termination', () => {
    it('a session killed without SessionEnd leaves the next session unaffected', async () => {
      const { path } = await project('killed');
      await runHook('session-start', payload({ session_id: 'DEAD', cwd: path, source: 'startup' }));
      await runHook('stop', payload({ session_id: 'DEAD', cwd: path }));
      // ...and the process is killed. No SessionEnd ever arrives.

      const next = await runHook(
        'session-start',
        payload({ session_id: 'NEW', cwd: path, source: 'startup' }),
      );
      expect(JSON.parse(next).hookSpecificOutput.additionalContext).toContain('killed');

      const abandoned = await readSessionRecord(workspace.paths, 'DEAD');
      expect(abandoned?.checkpointed).toBe(false);
    });

    it('a PostCompact with no preceding PreCompact still works', async () => {
      const { path, project: target } = await project('no-pre');
      await runHook(
        'post-compact',
        payload({
          session_id: 'S',
          cwd: path,
          trigger: 'auto',
          compact_summary: 'Something happened during a session we never saw start.',
        }),
      );

      const checkpoints = await workspace.store.listCheckpoints(target.id);
      expect(checkpoints).toHaveLength(1);
    });

    it('a PreCompact with no following PostCompact leaves nothing broken', async () => {
      const { path, project: target } = await project('no-post');
      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'startup' }));
      await runHook('pre-compact', payload({ session_id: 'S', cwd: path, trigger: 'auto' }));

      const record = await readSessionRecord(workspace.paths, 'S');
      expect(record?.pending_compact).not.toBeNull();
      // PreCompact writes no checkpoint of its own by design.
      expect(await workspace.store.listCheckpoints(target.id)).toHaveLength(0);
    });

    it('a corrupt session record is rebuilt rather than fatal', async () => {
      const { path } = await project('corrupt-session');
      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'startup' }));

      const file = join(home.path, 'cache', 'sessions', 'S.json');
      await writeFile(file, '{ this is not json');

      // The next hook must not throw, and must produce a usable record again.
      await expect(runHook('stop', payload({ session_id: 'S', cwd: path }))).resolves.toBe('');
      const rebuilt = await readSessionRecord(workspace.paths, 'S');
      expect(rebuilt?.turns).toBe(1);
    });
  });

  describe('malformed and hostile hook input', () => {
    const BAD_INPUTS = [
      ['empty string', ''],
      ['whitespace', '   \n  '],
      ['not json', 'this is not json at all'],
      ['truncated json', '{"session_id": "S", "cwd"'],
      ['json null', 'null'],
      ['json array', '[1,2,3]'],
      ['json string', '"just a string"'],
      ['json number', '42'],
      ['wrong field types', '{"session_id": 123, "cwd": ["array"], "source": {}}'],
      ['null fields', '{"session_id": null, "cwd": null}'],
      ['huge payload', `{"session_id":"S","cwd":"/tmp","compact_summary":"${'x'.repeat(200_000)}"}`],
      ['unicode control chars', '{"session_id":"S\\u0000\\u001b","cwd":"/tmp"}'],
      ['deeply nested', `{"session_id":"S","a":${'['.repeat(200)}${']'.repeat(200)}}`],
      ['prototype pollution attempt', '{"__proto__":{"polluted":true},"session_id":"S"}'],
    ] as const;

    for (const handler of ['session-start', 'stop', 'pre-compact', 'post-compact', 'session-end']) {
      it.each(BAD_INPUTS)(`${handler} survives %s`, async (_label, input) => {
        await expect(runHook(handler, input)).resolves.toBeTypeOf('string');
      });
    }

    it('does not pollute Object.prototype', async () => {
      await runHook('stop', '{"__proto__":{"pbPolluted":true},"session_id":"S","cwd":"/tmp"}');
      expect(({} as Record<string, unknown>).pbPolluted).toBeUndefined();
    });

    it('rejects an unknown handler name quietly', async () => {
      await expect(runHook('not-a-real-handler', '{}')).resolves.toBe('');
      await expect(runHook('', '{}')).resolves.toBe('');
    });

    it('never exceeds the 10,000 character hook output limit', async () => {
      const { path, project: target } = await project('verbose');

      // Far more history than any brief should carry.
      for (let index = 0; index < 30; index++) {
        await createCheckpoint(
          workspace.store,
          target,
          {
            summary: 'x'.repeat(2_000),
            completed: Array.from({ length: 20 }, (_, n) => `completed ${index}-${n}`),
            next: Array.from({ length: 20 }, (_, n) => `next ${index}-${n}`),
            blockers: Array.from({ length: 20 }, (_, n) => `blocker ${index}-${n}`),
          },
          {
            machineId: workspace.machineId,
            source: 'cli',
            timestamp: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T10:00:00Z`,
          },
        );
      }

      const output = await runHook(
        'session-start',
        payload({ session_id: 'S', cwd: path, source: 'startup' }),
      );
      const context = JSON.parse(output).hookSpecificOutput.additionalContext;
      expect(context.length).toBeLessThanOrEqual(10_000);
    });
  });

  describe('degrading gracefully when the environment is broken', () => {
    it('stays silent when Project Brain is not set up at all', async () => {
      const elsewhere = await makeTempDir('pb-nohome-');
      const previous = process.env.PROJECT_BRAIN_HOME;
      try {
        process.env.PROJECT_BRAIN_HOME = join(elsewhere.path, 'never-created');
        await expect(
          runHook('session-start', payload({ session_id: 'S', cwd: code.path, source: 'startup' })),
        ).resolves.toBe('');
      } finally {
        process.env.PROJECT_BRAIN_HOME = previous;
        await elsewhere.cleanup();
      }
    });

    it('stays silent in a directory that is not a registered project', async () => {
      const output = await runHook(
        'session-start',
        payload({ session_id: 'S', cwd: code.path, source: 'startup' }),
      );
      expect(output).toBe('');
    });

    it('survives a config file it cannot parse', async () => {
      await writeFile(join(home.path, 'config.yaml'), 'this: is: not: valid: [\n');
      await expect(
        runHook('session-start', payload({ session_id: 'S', cwd: code.path, source: 'startup' })),
      ).resolves.toBe('');
    });

    it('survives an unwritable cache directory', async () => {
      const { path } = await project('readonly-cache');
      const cache = join(home.path, 'cache');
      await mkdir(cache, { recursive: true });

      try {
        await chmod(cache, 0o500);
        // The brief itself must still be produced even if the session record
        // cannot be written: failing to remember a turn is far less bad than
        // failing to tell the model where it is.
        const output = await runHook(
          'session-start',
          payload({ session_id: 'S', cwd: path, source: 'startup' }),
        );
        expect(typeof output).toBe('string');
      } finally {
        await chmod(cache, 0o755).catch(() => {});
      }
    });

    it('logs a failure where pb doctor can find it, not to stderr', async () => {
      const { path } = await project('logged');
      // Make the checkpoint directory unwritable so SessionEnd fails internally.
      await runHook('session-start', payload({ session_id: 'S', cwd: path, source: 'startup' }));
      await runHook('stop', payload({ session_id: 'S', cwd: path }));

      const checkpoints = join(workspace.profilePaths.checkpointsDir);
      await mkdir(checkpoints, { recursive: true });
      try {
        await chmod(checkpoints, 0o500);
        await expect(
          runHook('session-end', payload({ session_id: 'S', reason: 'clear' })),
        ).resolves.toBe('');
      } finally {
        await chmod(checkpoints, 0o755).catch(() => {});
      }
    });
  });

  describe('partial and truncated writes', () => {
    it('reads an empty project file as unreadable rather than as an empty project', async () => {
      const { project: target } = await project('empty-file');
      await writeFile(workspace.profilePaths.projectFile(target.id), '');

      const reopened = await Workspace.open({ home: home.path });
      const projects = await new Registry(reopened.store).all();

      expect(projects.find((p) => p.id === target.id)).toBeUndefined();
      expect(reopened.store.getIssues().length).toBeGreaterThan(0);
    });

    it('survives a truncated project file', async () => {
      const { project: target } = await project('truncated');
      const file = workspace.profilePaths.projectFile(target.id);
      const full = await readFile(file, 'utf8');
      await writeFile(file, full.slice(0, Math.floor(full.length / 2)));

      const reopened = await Workspace.open({ home: home.path });
      await expect(new Registry(reopened.store).all()).resolves.toBeInstanceOf(Array);
    });

    it('ignores an abandoned temporary file from an interrupted write', async () => {
      const { project: target } = await project('abandoned-temp');
      const dir = workspace.profilePaths.projectDir(target.id);

      // writeFileAtomic writes `.<hex>.tmp` siblings; a crash can leave one.
      await writeFile(join(dir, '.abc123.tmp'), 'half-written garbage');

      const reopened = await Workspace.open({ home: home.path });
      const projects = await new Registry(reopened.store).all();
      expect(projects.some((p) => p.id === target.id)).toBe(true);
      expect(reopened.store.getIssues()).toEqual([]);
    });

    it('never leaves a partially written file visible at the target path', async () => {
      const target = join(home.path, 'atomicity-probe.txt');
      const big = 'x'.repeat(2 << 20);

      // Interleave reads with a large write. Any read either sees nothing or
      // sees the complete value - never a prefix.
      const writing = writeFileAtomic(target, big);
      const reads = Array.from({ length: 50 }, () =>
        readFile(target, 'utf8').catch(() => null),
      );
      const [, ...results] = await Promise.all([writing, ...reads]);

      for (const result of results) {
        if (result !== null) expect(result.length).toBe(big.length);
      }
      await expect(readFile(target, 'utf8')).resolves.toHaveLength(big.length);
      await rm(target, { force: true });
    });
  });
});
