# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, the on-disk data format may change between minor versions.
Migrations are provided and are never destructive: see `docs/data-model.md`.

## [Unreleased]

StateNest stops needing to be operated. Installing it and opening Claude Code in
a git repository is now the whole workflow: an ordinary day requires no
StateNest command at all. The CLI is unchanged in what it can do — it is simply
no longer on the critical path.

### Added

- **Automatic project recognition.** Opening Claude Code in a git repository
  with a remote registers it, with the same name, type and description logic as
  `statenest add`. A clone of a project you already have is linked as another
  location of the same project, not a second one. Deliberately narrow: a
  repository with no remote is not registered (its id would be random and could
  never merge across machines), a directory that is not a repository is not
  registered, and nothing outside the repository Claude was opened in is ever
  examined.
- **Automatic sync.** A checkpoint, decision or next action schedules a sync in
  the background. Writes coalesce, so a burst costs one push rather than five;
  exactly one sync runs per profile at a time; nothing ever waits for the
  network; and a failure records a health state instead of interrupting anyone.
- **Bounded freshness at session start.** A stale profile gets a few hundred
  milliseconds to catch up before the brief is built, and the session starts
  regardless. A remote recently found unreachable is not re-probed, so being
  offline does not tax every session.
- **`statenest setup`** — one-time onboarding: machine, Claude Code integration
  and sync in one pass. The same command as `statenest init`, under the name
  people look for. On a second machine it joins the existing profile and
  receives what is already there, with no ordering to understand.
- **`statenest sync repair`** — resolve a conflict in StateNest's own terms.
  Shows both versions of each record, named as work rather than as file paths,
  and asks which to keep.
- **A sync health model**, surfaced by `statenest sync status` and
  `statenest doctor`: up to date, offline, waiting, needs attention, or paused
  because something looked like a credential.

### Changed

- **A sync conflict no longer leaves the profile unreadable.** The attempted
  rebase is unwound, so ordinary commands keep working while the disagreement is
  outstanding. Both versions are preserved — yours on the branch, theirs at the
  recorded commit — and neither is ever chosen for you.
- **Normal output speaks StateNest, not git.** No rebase, HEAD or
  `origin/main...HEAD` in ordinary use. `statenest sync status --verbose` still
  shows the underlying git state, and raw git remains available for emergencies.
- **MCP tools are named `statenest_*`** rather than `projectbrain_*`, which was
  left over from the pre-release name. Skills and documentation were updated with
  them.
- **`sync.auto_push` and `sync.auto_pull` are now machine-local and real.** They
  were in the shared profile and read by nothing. Whether to push automatically
  is a per-machine decision — a laptop on a metered connection and a desktop on
  home broadband can disagree — so they live alongside the other machine-local
  state, where the v0.1.2 fix put it. `auto_pull` is retired rather than
  reimplemented: StateNest never force pushes, so sending requires rebasing onto
  the remote first, and "pull" was never separable from "sync at all". An
  existing `auto_pull: false` is honoured once, as `auto_sync: false`.
- **A new location is recorded reliably** at session start rather than
  best-effort, so the same repository at a second path is always remembered.

### Fixed

- Two sleeps used `unref`'d timers, which let the process exit before they
  fired. The debounce and the session-start refresh would both have been silent
  no-ops in a real hook process.

### Unchanged

- No account, no service, no cloud. The sync remote is still an ordinary private
  git repository you create and own.
- Raw transcripts are still never stored, source code is still never stored, and
  the credential scan still runs before anything leaves the machine.
- StateNest still never spawns a model, and still never writes to your source
  repositories.

## [0.1.2] — 2026-09-18

A correctness patch for multi-machine sync. The sync architecture is unchanged
— rebase onto the remote, linear history, conflicts surfaced and never
auto-merged. What is fixed is that StateNest was manufacturing conflicts in its
own control file.

### Fixed

- **A successful sync no longer leaves the profile repository dirty.** `sync`
  wrote `sync.last_sync_at` into `profile.yaml` _after_ the git sync had already
  committed and pushed — inside the directory it had just cleaned. Every
  successful sync therefore ended modified, and `sync status` immediately
  afterwards reported local uncommitted changes with nothing ahead or behind.
- **`last_sync_at` is now machine-local.** It records when _this_ computer last
  synced, so two computers sharing a profile each wrote a different value into
  the same shared line. The second machine to sync hit a `profile.yaml`
  conflict even when no project data disagreed. Because `profile.yaml` is a
  control file, the conflict markers then made the profile unreadable, and
  `projects` answered with the contradictory `No profile named "personal".
Available profiles: personal`.
- **`project_roots` is now machine-local.** The directories a machine scans are
  machine-specific — `~/Documents` on a Mac, `D:\work` on Windows — but were
  stored in the shared profile, so whichever machine synced last silently
  overwrote the others' roots.
- **Joining a second machine no longer rewrites the shared `created_at`.**
  Adoption of the remote profile was correct; the CLI then wrote a stale
  in-memory profile back over it, carrying the joining machine's own
  `created_at`. The same post-sync write caused both problems, and removing it
  fixes both.
- **A conflicted or malformed profile now says so.** An unreadable
  `profile.yaml` used to be reported as a profile that does not exist. The
  error now names the file, recognises git conflict markers, and offers
  `rebase --continue` / `rebase --abort` — and, for `profile.yaml`
  specifically, says not to delete `~/.statenest` or create a replacement
  profile, because everything is still there.

### Changed

- Machine-local state lives in `~/.statenest/local/<profile>.json`, outside
  `profiles/` where sync cannot reach it. Values already present in an existing
  `profile.yaml` are carried forward on first read, so nothing configured is
  lost. The profile schema is unchanged and no migration command is needed.
- A successful sync now has an explicit invariant: it leaves the profile
  repository clean. This is enforced by integration tests that drive a real
  bare remote through first push, second-machine adoption, and repeated
  alternating syncs between two machines.

### Unchanged

- Real conflicts still stop safely. Two machines editing the same record still
  surface both versions and leave the resolution to you. Nothing is
  auto-merged, and no automatic conflict resolution was added.

### Upgrading

Machines sharing a profile should all be updated to 0.1.2 before regular sync
resumes. A machine still running 0.1.1 keeps writing `last_sync_at` into the
shared profile and can still manufacture the conflict for everyone else.

## [0.1.1] — 2026-09-18

A patch release driven by real use: dogfooding v0.1.0 across actual projects,
and preparing StateNest for a second computer.

### Added

- A complete end-user guide ([docs/user-guide.md](docs/user-guide.md)) and a
  command reference ([docs/command-reference.md](docs/command-reference.md))
  written from the CLI itself rather than from memory, with a regression test
  that reads the commands back out of the prose and asks the CLI whether each
  one exists.
- Multi-machine setup and sync documentation
  ([docs/multi-machine.md](docs/multi-machine.md)), derived from tested
  outcomes.
- `statenest dashboard --all-profiles` — a **read-only** view of every profile
  at once. Profile storage and profile sync stay completely separate; nothing
  is copied between them.
- Profile labels on every row of a unified view, and a per-profile breakdown
  alongside the combined totals.

### Fixed

- `scan`, `add` and `init` no longer claim a project came from "another
  machine" when it is simply a second copy of the same repository on this one.
  Both situations produce the same registration outcome, so the claim now comes
  from the data — whether a location on another machine actually exists.
- Two genuinely different repositories that share a name are now
  distinguishable in project listings, qualified by repository path. They were
  never merged; they were merely indistinguishable.
- Ambiguous project names give usable qualifiers instead of impossible advice.
  `resume threads` used to answer `1. threads  2. threads` and suggest "use a
  longer or more specific name", which cannot work when the names are
  identical.

### Documentation and safety

- Stated exactly what `scan` knows and does not know, and separated facts
  derived automatically from memory captured during agent activity from memory
  written down deliberately.
- Made explicit that `scan` does not read Claude Code history, and cannot
  recover conversations from before the integration was installed.
- Documented the Claude Code hook lifecycle, and which checkpoints are
  automatic versus explicit — `SessionEnd` alone may preserve only metadata, so
  `/statenest:checkpoint` still matters after an important short session.
- Documented the safe two-machine first-sync procedure, including what happens
  when both sides already hold different data.
- Documented the production VPS recommendation: a server is a remote plus a
  deployment record, with StateNest **not** installed on it. A full install is
  for hosts you genuinely work on.
- Corrected the discovery wording: a repository is recognised by a `.git`
  _marker_, which is a directory in an ordinary clone and a file in a linked
  worktree or submodule. The implementation has always accepted both.

### Validation

- Two-machine identity and round-trip behaviour is now covered: one repository
  on two computers stays one project with two locations, and a full sync cycle
  duplicates nothing.
- First-sync, both-sides-populated, concurrent-edit, same-record conflict,
  offline, secret-blocking and interrupted-rebase scenarios are covered against
  a real git remote.
- The cross-profile dashboard is proven read-only: both profile directories are
  compared byte for byte after every endpoint is exercised.
- The "42 created, 43 shown" observation from first use was **not reproduced**
  and no defect was found. The invariant it would have violated — stored
  projects equals projects before plus projects created — is now covered by a
  regression test, so a future violation surfaces as a failing test.

## [0.1.0] — 2026-09-18

First public release. Published to npm as
[`statenest`](https://www.npmjs.com/package/statenest).

### Naming

The project was developed under the working name "Project Brain" and renamed to
**StateNest** before any release. That name could not be used: `project-brain`
on npm belongs to an actively maintained product in the same category, a paid
commercial app uses the literal name, and "project brain" had become the generic
phrase for the category. Nothing was ever published under it. See
[docs/research/final-name-selection.md](docs/research/final-name-selection.md).

What changed with it:

- npm package `statenest`; the CLI command is `statenest` (was `pb`)
- Data directory `~/.statenest` (was `~/.project-brain`)
- Environment variables `STATENEST_HOME`, `STATENEST_PROFILE`, `STATENEST_DEBUG`
  (were `PROJECT_BRAIN_*`)
- Claude Code plugin, marketplace and MCP server are all named `statenest`;
  skills are `/statenest:resume`, `/statenest:checkpoint`, `/statenest:where`

**Pre-rename data is detected, never touched.** If `~/.statenest` does not
exist but `~/.project-brain` does, StateNest says so and prints the `mv` command
that moves it, rather than reading the old directory or migrating it
automatically. Supporting two layouts permanently for a name that was never
published would be complexity with no beneficiary. Persisted identifiers —
project ids (`prj_`), checkpoint ids (`cp_`), machine ids and `schema_version` —
are deliberately unchanged, so moving the directory is genuinely all that is
needed.

### Added

- Project registry with git-remote-derived identity that is stable across machines
- Filesystem scanning with aggressive pruning, symlink-cycle detection and
  worktree/submodule awareness
- Append-only checkpoints, one immutable file each
- Decisions, tasks and per-project state
- Local lexical search across projects, checkpoints, decisions, tasks and servers
- Machines and remote environments, with `~/.ssh/config` import by explicit selection
- Profiles as independently syncable directories, isolating work from personal
- Secret detection and redaction on everything written, plus `statenest privacy audit`
- Claude Code plugin: SessionStart brief, Stop tracking, PreCompact/PostCompact
  checkpointing, SessionEnd checkpointing, seven skills and ten MCP tools
- `statenest doctor`, with an actionable fix for every failing check
- Optional sync of one profile to a private git repository, with a blocking
  secret audit before any commit and non-destructive conflict handling
- Local read-only dashboard, loopback-only by default
- `statenest export` / `statenest import` backups, excluding machine-local state
- `statenest uninstall`, which keeps your data unless you explicitly say otherwise
- Published JSON Schemas for every stored record

### Security

- Stored values are redacted again when they are **read**, not only when they
  are written. A credential that reached a file before a detection pattern
  existed can no longer flow out of it into a model's context, the dashboard or
  search results. Redaction on read does not rewrite the file; `statenest privacy
audit` still reports it
- Archive extraction validates every member before unpacking, rejecting
  absolute paths, drive letters, UNC paths, `..` traversal and symlink members,
  so a crafted backup cannot write outside the target directory

### Fixed

- A local-only project that later gained a git remote never recorded the
  remote, so the same repository registered as two projects on two machines.
  This was the most common lifecycle in the product and it was silently broken
- A transferred repository (renamed owner or organisation) kept its old
  identity forever. The new identity is now recorded and the old one retained
  in `previous_identities`, so both resolve to one project and the id never
  changes
- Concurrent Claude Code sessions lost session updates: ten concurrent stops
  recorded one turn. Session records are now updated under an advisory file
  lock, which matters most for the `checkpointed` flag
- Re-running a compaction hook created a duplicate checkpoint; compactions are
  now identified by a digest of their summary
- Reading checkpoints scanned the entire history regardless of the limit
  requested — 43 ms at 672 checkpoints. It now stops early: 0.7 ms, and flat
- `contractHome` used the running platform's path separator, so a Windows path
  was never shortened when displayed on macOS
- A missing `tar` binary was reported as a corrupt archive
- `statenest init --profile work` created a profile called "personal": a global
  `--profile` option and the subcommand's own both parsed the value, and the
  global one won wherever it appeared
- `statenest profile` did not exist, although error messages recommended it
- `statenest resume` never said what the work was about unless `--full` was passed
- Next actions were listed in insertion order, so a months-old aspiration
  outranked the actual next step
- `statenest status` printed only "0 projects" when empty, with no way forward
- `statenest sync init` asked for confirmation about privacy before checking that its
  argument was a git remote at all
- A directory reached through a symlink (macOS `/tmp` -> `/private/tmp`) was
  registered as a second location on the same machine, so `statenest resume` showed a
  project as if it existed on two computers
- `.mcp.json` was missing from the published package, so an npm install
  produced a plugin with working hooks and skills but no MCP tools
- A TOML manifest's `[project]` table was parsed past its own boundary because
  the pattern used `\Z`, a Perl anchor with no JavaScript equivalent
- A password embedded in an scp-style git remote could reach the derived
  project identity

### Known limitations

- Secret detection is a safety net with documented limits, not a guarantee. It
  matches known credential shapes; a format it does not know will not be
  caught. See [docs/security-model.md](docs/security-model.md)
- Search is lexical. It finds words you actually wrote, not synonyms
- Git is optional but nearly essential: without it, branch and
  uncommitted-change information cannot be read
- One repository is one project ([ADR 0004](docs/adr/0004-one-repository-is-one-project.md)).
  A monorepo is one project, not one per package
- A project with no git remote gets a random identity, so the same directory
  cloned to a second machine registers as two projects until a shared remote
  exists
- Sync conflicts are surfaced, never auto-merged. Two machines editing the same
  record leaves the git conflict for you to resolve
- The on-disk format may change before 1.0.0. Migrations are provided, applied
  on read, and back up before writing
