# AGENTS.md

Orientation for a coding agent working **on** StateNest. Human contributors want
[CONTRIBUTING.md](CONTRIBUTING.md); this file does not repeat it.

Read the invariants section before changing anything under `src/sync/`,
`src/storage/` or `src/integrations/`. Every rule there exists because breaking
it loses or leaks a user's data.

---

## What this is

A local-first memory and control layer for coding agents. It records project
state — progress, decisions, blockers, next actions, machines, deployments — as
plain YAML and Markdown under `~/.statenest`, injects the relevant part into an
agent session, and optionally syncs it to a private git repository the user owns.

TypeScript, ESM (NodeNext), Node >= 22.12, four runtime dependencies
(`commander`, `picocolors`, `yaml`, `zod`).

## Architecture in one pass

```
src/cli/          commander entry points; one file per command
src/mcp/          MCP server + 10 statenest_* tools
src/integrations/ agent adapters. claude/ is the only one
src/core/         workspace, registry, paths, schema, context, machine-local
src/storage/      atomic reads/writes of the on-disk format
src/sync/         git sync, auto-sync scheduling, conflict repair
src/checkpoints/  checkpoint creation and worthwhileness
src/discovery/    project scanning, manifest/README detection, exclusions
src/git/          git exec, remote-url normalisation, repo reads
src/security/     secret scanning and redaction
src/util/         atomic fs, file locks, paths, time, errors
```

**Dependency direction is one-way, and a test enforces it.** `core`, `storage`,
`sync`, `checkpoints`, `git`, `discovery` and `security` must never import
`src/integrations/`. Only CLI commands do, to install and inspect the adapter.
[`tests/unit/architecture.test.ts`](tests/unit/architecture.test.ts) fails with
the offending file and line if that changes — if you hit it, move the shared
code into core or invert the call so the adapter depends on core. Do not add an
exception. Claude Code is the first adapter, not the architecture; the seam is
[docs/architecture/adapters.md](docs/architecture/adapters.md).

Three ideas everything follows from, explained in
[docs/architecture/overview.md](docs/architecture/overview.md):

1. A project's identity is a hash of its **normalised git remote**, not its path.
2. A profile is a **self-contained, independently syncable directory**.
3. History is **append-only**; only "now" is mutable.

## Commands

```bash
npm run build          # tsc + esbuild plugin bundle. Run before anything that uses dist/
npm test               # vitest
npm run typecheck
npm run lint
npm run release:check  # the authoritative gate: typecheck, lint, byte check, build,
                       # tests, schema check, package verification, metadata check
```

`npm run release:check` must exit 0 before you propose a change. It is the same
gate the release workflow runs; do not approximate it with a subset.

Tests that shell out to git are skipped when git is absent rather than failing.
`npm run demo:zero-touch` drives the real hooks end to end if you want to see
the product behave.

---

## Data-safety invariants

These are not style preferences. Each one has a bug behind it.

**1. Never write to a user's source repository.** StateNest reads git state and
writes only inside the StateNest home. `ProfileSync` asserts every git
invocation is inside that home before running it
(`assertInsideBrainHome`), and nothing outside `src/sync/git-sync.ts` runs a git
write command at all. Covered by tests in `zero-touch.test.ts` and
`security.test.ts` that snapshot the tree, `git status` and `HEAD` around a
session.

**2. A successful sync leaves the profile repository clean.** `git status
--porcelain` must be empty after a sync reports success. This was violated in
v0.1.1: `last_sync_at` was written into the synced `profile.yaml` _after_ the
push, so every successful sync dirtied the repository it had just cleaned and
two machines manufactured a conflict in a control file. Anything that belongs to
one machine goes in `~/.statenest/local/<profile>.json`, outside `profiles/`,
never in the profile. Covered by `sync-profile-metadata.test.ts`.

**3. A conflict preserves both sides and leaves local data usable.** A
conflicting rebase is aborted, not left in progress — a half-finished rebase puts
conflict markers in live files, and in `profile.yaml` that takes every command
down with it. Ours stays on the branch, theirs at the recorded sha. Nothing is
ever auto-merged. Do not add automatic resolution.

**4. A credential blocks the push.** The audit runs _before_ the commit, so a
secret never enters git history. Findings report file and line, never the value —
including in anything persisted to machine-local state.

**5. Never store source code, `.env` contents, ssh keys, tokens or raw agent
transcripts.** Filenames are checked against a deny-list before a file is opened.
Project detection reads a fixed manifest list plus a README, nothing else.

**6. StateNest never spawns a model.** Checkpoints reuse the compaction summary
Claude Code has already written. If a feature seems to need an LLM call, it is
the wrong feature.

**7. Hooks always exit 0 and always have a deadline.** StateNest failing must
never look like Claude Code failing, and a hook must never hang a session.

---

## Testing rules

**Always use an isolated `STATENEST_HOME`.** Every test and every manual check
gets a throwaway home under the system temp directory, plus a local bare git
repository as the sync remote. `tests/helpers/fixtures.ts` has the helpers.

**Never touch the developer's real `~/.statenest`.** Not to read it, not to
"just check" something. The same goes for any real sync remote. If you need to
verify against real data, build a fixture that reproduces its shape.

When exercising a background sync, pass the home explicitly — the detached
process inherits no `--home` flag, only the environment. `scheduleAutoSync`
passes `STATENEST_HOME` and `STATENEST_PROFILE` for exactly this reason.

`CLAUDE_CONFIG_DIR` must be honoured anywhere Claude Code's config is read;
point it at a scratch directory before testing an integration.

Do not weaken a test to make a change pass. If a test now asserts the wrong
thing, change the assertion deliberately and say why in the commit message.

---

## Release and publish safety

- **Never run `npm publish` by hand.** Publishing goes through
  `.github/workflows/release.yml` using GitHub OIDC and npm Trusted Publishing.
  There is no token anywhere.
- **Never bump the version, tag, or create a GitHub Release unless explicitly
  asked.** Version, tag and `package.json` must agree; the workflow enforces it.
- **Never fix a failed release** by deleting an npm version, moving a published
  tag, force-pushing, or publishing over the workflow.
- The Claude plugin is **copied** by `claude plugin install` into a
  version-keyed cache, so upgrading the npm package does not update it.
  `statenest integrate claude` detects the mismatch; `statenest doctor` reports
  it.

---

## Documentation sources of truth

Keep these consistent when behaviour changes. The first two are the ones that go
stale fastest.

| Question                                       | File                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| How do we describe StateNest externally?       | [docs/positioning.md](docs/positioning.md)             |
| What happens automatically, and what does not? | [docs/user-guide.md](docs/user-guide.md) §8            |
| Every command and option                       | [docs/command-reference.md](docs/command-reference.md) |
| Hooks, MCP tools, skills, latency              | [docs/claude-code.md](docs/claude-code.md)             |
| Threat model and its limits                    | [docs/security-model.md](docs/security-model.md)       |
| Every file and field on disk                   | [docs/data-model.md](docs/data-model.md)               |
| Platform and version support                   | [docs/compatibility.md](docs/compatibility.md)         |
| Why a decision was made                        | [docs/adr/](docs/adr/)                                 |
| Curated entry point for agents                 | [llms.txt](llms.txt)                                   |

A test reads the command reference back and asks the CLI whether each command it
names exists, so an invented command fails CI. Nothing checks prose for accuracy
— that is on you.

**If a document claims something the implementation does not do, fix the
document, not the test.** Verify behaviour by reading the code or running it
before writing it down.
