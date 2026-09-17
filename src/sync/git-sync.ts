import { join } from 'node:path';
import { git } from '../git/exec.js';
import { normalizeRemoteUrl } from '../git/remote-url.js';
import { pathExists } from '../util/fs-atomic.js';
import { isPathInside } from '../util/paths.js';
import { BrainError } from '../util/errors.js';
import { auditProfile, describeBlock, hasBlockingFindings } from '../security/audit.js';
import type { ProfilePaths } from '../core/paths.js';

/**
 * Optional synchronization of one profile through a git repository the user
 * owns.
 *
 * Three rules, each of which exists because breaking it would be severe:
 *
 * 1. **Only the profile directory is ever touched.** Every git invocation is
 *    asserted to be inside the Project Brain home before it runs. Project Brain
 *    observes the user's source repositories; it must never commit to one.
 *
 * 2. **A credential blocks the push.** The audit runs before anything leaves
 *    the machine, and a finding stops the operation with the file and line
 *    named - never the value.
 *
 * 3. **Network failure is not an error state.** Everything local keeps working;
 *    sync reports that it could not reach the remote and gets on with it.
 */

export type SyncOutcome =
  | 'synced'
  | 'up-to-date'
  | 'local-only'
  | 'blocked-by-secrets'
  | 'conflict'
  | 'offline'
  | 'not-configured';

export interface SyncResult {
  outcome: SyncOutcome;
  /** Commits pulled in from the remote. */
  pulled: number;
  /** Commits pushed to the remote. */
  pushed: number;
  /** Files changed in the commit this run created, if any. */
  changed: number;
  message: string;
  /** Masked findings, when the outcome is `blocked-by-secrets`. */
  blockers: string[];
  /** Paths that conflicted, when the outcome is `conflict`. */
  conflicts: string[];
}

export interface SyncStatus {
  initialised: boolean;
  remote: string | null;
  branch: string;
  /** Uncommitted changes in the profile directory. */
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
}

const COMMIT_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 120_000;

/**
 * Guard against ever running git outside the Project Brain home.
 *
 * This is the structural half of "never commit the user's source repository".
 * The other half is that nothing outside this module runs a git write command
 * at all.
 */
function assertInsideBrainHome(profileRoot: string, brainHome: string): void {
  if (!isPathInside(profileRoot, brainHome)) {
    throw new BrainError(
      'UNSAFE_SYNC_TARGET',
      'Refusing to run sync outside the Project Brain home.',
      {
        details: [`Profile: ${profileRoot}`, `Home: ${brainHome}`],
        hints: ['This is a bug in Project Brain - please report it.'],
      },
    );
  }
}

export class ProfileSync {
  constructor(
    private readonly paths: ProfilePaths,
    private readonly brainHome: string,
  ) {
    assertInsideBrainHome(paths.root, brainHome);
  }

  private get cwd(): string {
    return this.paths.root;
  }

  async isInitialised(): Promise<boolean> {
    return pathExists(join(this.cwd, '.git'));
  }

  /**
   * Turn the profile directory into a git repository pointed at the user's own
   * private remote.
   *
   * The remote is validated but never contacted here: `pb sync init` must work
   * on a plane.
   */
  async initialise(remoteUrl: string, branch = 'main'): Promise<void> {
    const normalized = normalizeRemoteUrl(remoteUrl);
    if (!normalized) {
      throw new BrainError('INVALID_REMOTE', `"${remoteUrl}" is not a valid git remote.`, {
        hints: ['pb sync init git@github.com:you/project-brain-data.git'],
      });
    }

    if (!(await this.isInitialised())) {
      const init = await this.run(['init', '--quiet', `--initial-branch=${branch}`]);
      if (!init.ok) {
        throw new BrainError('GIT_INIT_FAILED', 'Could not create the data repository.', {
          details: [init.stderr.trim()],
        });
      }
    }

    // Replace rather than append: a profile has exactly one sync remote, and
    // silently keeping an old one is how data reaches the wrong place.
    await this.run(['remote', 'remove', 'origin']);
    const add = await this.run(['remote', 'add', 'origin', normalized.sanitized]);
    if (!add.ok) {
      throw new BrainError('GIT_REMOTE_FAILED', 'Could not set the data repository remote.', {
        details: [add.stderr.trim()],
      });
    }

    // Identify commits as the tool, not as whoever happens to be configured.
    await this.run(['config', 'user.name', 'Project Brain']);
    await this.run(['config', 'user.email', 'project-brain@localhost']);
  }

  async status(): Promise<SyncStatus> {
    if (!(await this.isInitialised())) {
      return {
        initialised: false,
        remote: null,
        branch: 'main',
        dirty: false,
        ahead: null,
        behind: null,
        lastCommit: null,
      };
    }

    const [remote, branch, statusResult, tracking, log] = await Promise.all([
      this.run(['remote', 'get-url', 'origin']),
      this.run(['rev-parse', '--abbrev-ref', 'HEAD']),
      this.run(['status', '--porcelain=v1', '-z']),
      this.run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
      this.run(['log', '-1', '--format=%h %s']),
    ]);

    const [behind, ahead] = tracking.ok
      ? tracking.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10))
      : [null, null];

    return {
      initialised: true,
      remote: remote.ok ? remote.stdout.trim() : null,
      branch: branch.ok ? branch.stdout.trim() : 'main',
      dirty: statusResult.stdout.trim() !== '',
      ahead: Number.isFinite(ahead) ? (ahead as number) : null,
      behind: Number.isFinite(behind) ? (behind as number) : null,
      lastCommit: log.ok && log.stdout.trim() !== '' ? log.stdout.trim() : null,
    };
  }

  /**
   * Pull, commit, push.
   *
   * Order matters. The audit runs before the commit, so a credential never
   * enters git history in the first place - once committed, removing it means
   * rewriting history, and by then it may already have been pushed.
   */
  async sync(options: { message?: string; push?: boolean } = {}): Promise<SyncResult> {
    const empty: SyncResult = {
      outcome: 'up-to-date',
      pulled: 0,
      pushed: 0,
      changed: 0,
      message: '',
      blockers: [],
      conflicts: [],
    };

    if (!(await this.isInitialised())) {
      return { ...empty, outcome: 'not-configured', message: 'Sync is not set up for this profile.' };
    }

    // -- 1. Refuse to send anything that looks like a credential -------------
    const audit = await auditProfile(this.paths);
    if (hasBlockingFindings(audit)) {
      return {
        ...empty,
        outcome: 'blocked-by-secrets',
        blockers: describeBlock(audit),
        message:
          'Sync stopped: something in your Project Brain data looks like a credential. Nothing was sent.',
      };
    }

    const status = await this.status();
    let pulled = 0;
    const conflicts: string[] = [];
    let remoteReachable = false;

    // -- 2. Fetch -----------------------------------------------------------
    if (status.remote) {
      const fetch = await this.run(['fetch', 'origin', status.branch], NETWORK_TIMEOUT);
      if (fetch.ok) {
        remoteReachable = true;
      } else if (looksOffline(fetch.stderr)) {
        // Local work continues; the remote is simply unreachable right now.
        return {
          ...empty,
          outcome: 'offline',
          message: 'Could not reach the remote. Everything local is unaffected.',
        };
      }
      // A fetch that fails for any other reason (empty remote, first push) is
      // not fatal: there may simply be nothing there yet.
    }

    // -- 3. First sync onto a repository that already has history ------------
    //
    // A second machine has already created its own profile.yaml, README and
    // machine record before it ever syncs. It therefore has local files but no
    // commits, and cannot fast-forward onto a remote that does.
    //
    // Adopting the remote history and then materialising the remote files
    // brings everything across while leaving files that exist only here - such
    // as this machine's own record - untouched. A plain reset would have
    // presented every remote project as a local deletion, and the next commit
    // would have deleted them for every machine.
    if (remoteReachable && !(await this.hasCommits()) && (await this.remoteHasCommits(status.branch))) {
      const adopted = await this.adoptRemoteHistory(status.branch);
      if (!adopted.ok) {
        return {
          ...empty,
          outcome: 'local-only',
          message: `Could not adopt the existing remote history: ${firstLine(adopted.stderr)}`,
        };
      }
      pulled = Number.parseInt(
        (await this.run(['rev-list', '--count', 'HEAD'])).stdout.trim(),
        10,
      ) || 0;
    }

    // -- 4. Commit local changes --------------------------------------------
    const staged = await this.run(['add', '--all', '.']);
    if (!staged.ok) {
      return { ...empty, outcome: 'local-only', message: `Could not stage changes: ${staged.stderr.trim()}` };
    }

    const pending = await this.run(
      (await this.hasCommits())
        ? ['diff', '--cached', '--name-only']
        : ['diff', '--cached', '--name-only', '--no-renames'],
    );
    const changed = pending.stdout.split('\n').filter(Boolean).length;

    if (changed > 0) {
      const commit = await this.run(
        ['commit', '--quiet', '-m', options.message ?? defaultCommitMessage(changed)],
        COMMIT_TIMEOUT,
      );
      if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return {
          ...empty,
          outcome: 'local-only',
          changed,
          message: `Could not commit: ${commit.stderr.trim() || commit.stdout.trim()}`,
        };
      }
    }

    // -- 5. Replay our commits on top of the remote --------------------------
    //
    // Rebase keeps history linear across machines. Checkpoints are immutable
    // one-file-each, so there is almost never anything to resolve; the
    // exception is a mutable record that two machines both edited.
    if (remoteReachable && (await this.remoteHasCommits(status.branch))) {
      const behind = Number.parseInt(
        (await this.run(['rev-list', '--count', `HEAD..origin/${status.branch}`])).stdout.trim(),
        10,
      );
      if (Number.isFinite(behind) && behind > 0) {
        const rebase = await this.run(['rebase', `origin/${status.branch}`], COMMIT_TIMEOUT);
        if (!rebase.ok) {
          const conflicted = await this.run(['diff', '--name-only', '--diff-filter=U']);
          conflicts.push(...conflicted.stdout.split('\n').filter(Boolean));
          return {
            ...empty,
            outcome: 'conflict',
            pulled: behind,
            changed,
            conflicts,
            message:
              'Two machines changed the same record. Nothing was lost - resolve the files listed, then run `pb sync` again.',
          };
        }
        pulled += behind;
      }
    }

    // -- 6. Push -------------------------------------------------------------
    if (options.push === false || !status.remote) {
      return {
        ...empty,
        outcome: changed > 0 || pulled > 0 ? 'synced' : 'up-to-date',
        pulled,
        changed,
        message: status.remote ? 'Committed locally; not pushed.' : 'No remote configured.',
      };
    }

    const push = await this.run(
      ['push', '--set-upstream', 'origin', status.branch],
      NETWORK_TIMEOUT,
    );
    if (!push.ok) {
      if (looksOffline(push.stderr)) {
        return {
          ...empty,
          outcome: 'offline',
          pulled,
          changed,
          message: 'Committed locally, but the remote was unreachable. Run `pb sync` again later.',
        };
      }
      return {
        ...empty,
        outcome: 'local-only',
        pulled,
        changed,
        message: `Committed locally, but the push failed: ${firstLine(push.stderr)}`,
      };
    }

    const pushed = changed > 0 ? 1 : 0;
    return {
      ...empty,
      outcome: pulled > 0 || changed > 0 ? 'synced' : 'up-to-date',
      pulled,
      pushed,
      changed,
      message:
        pulled === 0 && changed === 0
          ? 'Already up to date.'
          : `Synced: ${changed} file(s) sent, ${pulled} commit(s) received.`,
    };
  }

  /** True once this repository has at least one commit. */
  private async hasCommits(): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
  }

  private async remoteHasCommits(branch: string): Promise<boolean> {
    return (await this.run(['rev-parse', '--verify', '--quiet', `origin/${branch}`])).ok;
  }

  /**
   * Take on the remote's history without discarding anything local.
   *
   * `reset --mixed` moves HEAD and the index to the remote while leaving the
   * working tree alone; `checkout -- .` then writes the remote's files into
   * the working tree. Files that exist only locally - this machine's own
   * record, a project registered before the first sync - survive both steps
   * and are committed as additions afterwards.
   */
  private async adoptRemoteHistory(branch: string) {
    const reset = await this.run(['reset', '--mixed', `origin/${branch}`]);
    if (!reset.ok) return reset;
    return this.run(['checkout', `origin/${branch}`, '--', '.']);
  }

  private async run(args: string[], timeoutMs = COMMIT_TIMEOUT) {
    // Re-asserted on every invocation, not just in the constructor: this is the
    // guarantee that Project Brain never writes to a source repository.
    assertInsideBrainHome(this.cwd, this.brainHome);
    return git(args, { cwd: this.cwd, timeoutMs });
  }
}

function defaultCommitMessage(changed: number): string {
  return `Update ${changed} record${changed === 1 ? '' : 's'}`;
}

/**
 * Distinguish "the network is not there" from "git refused".
 *
 * The difference matters: an unreachable remote is normal and must not look
 * like a failure, whereas a rejected push is something the user should see.
 */
function looksOffline(stderr: string): boolean {
  return /could not resolve host|network is unreachable|connection refused|connection timed out|temporary failure in name resolution|no route to host|operation timed out/i.test(
    stderr,
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text.trim();
}
