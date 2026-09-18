# Release readiness

Assessed 2026-09-18 against the current tree.

**Status: NOT READY.** Two blockers, both about identity rather than code. The
software is in good shape; it does not yet have a name it is allowed to use or
a repository to live in.

Run `npm run release:check` for the machine-checkable half of this document. It
exits non-zero today, on the blockers below.

---

## Blockers

Nothing may be published while any of these stands.

### 1. The project name is not available

`project-brain` is taken on npm by an actively maintained product in this same
category — v0.30.0, 57 versions, ~914 downloads a week, describing itself as a
"local-first MCP server that gives AI tools semantic memory of your codebase."
It is not a squat that can be disputed. Separately, `getprojectbrain.com` is a
paid commercial app using the literal name and marketed at developers, which is
the profile of a trademark complainant; `Ethan-YS/project-brain` (172★) is a
direct conceptual competitor under the exact name; and "project brain" has
become the generic phrase other projects use to describe this category.

Evidence and ten researched alternatives: [research/project-name.md](research/project-name.md).
Recommended: **Projectory**, free on npm, Homebrew and PATH.

**Resolution:** choose a name, edit [src/core/metadata.ts](../src/core/metadata.ts),
run `npm run metadata:sync`, `npm run build && npm run schemas`, then
`npm run check:metadata`.

### 2. No repository owner

`package.json`, both plugin manifests, the generated schema `$id` values,
SECURITY.md and CONTRIBUTING.md all point at
`https://github.com/OWNER-NOT-CHOSEN/REPO-NOT-CHOSEN`. That placeholder is
deliberately not plausible-looking, so it cannot quietly ship; a realistic
placeholder is the one that survives into a release and sends users to a
stranger's namespace.

Consequences while unresolved: the SECURITY.md vulnerability-reporting link does
not resolve, the CLI's crash handler deliberately prints no "report it at" URL,
and CI has never run — there is no remote to run it on.

**Resolution:** same four commands as above. `check:metadata` verifies every
consumer agrees and fails while `METADATA_IS_PLACEHOLDER` is true.

---

## Important

Should be resolved before or immediately alongside the first release, but none
of these makes the software unsafe to use.

### The display name is not covered by the rename automation

`metadata:sync` rewrites package names, URLs and manifests. It deliberately does
not rewrite "Project Brain" as it appears in README prose, `docs/`, the CLI
banner and the plugin description — that is a wide, mostly mechanical diff that
should be done deliberately in one commit once a name is chosen, not smuggled in
by a script.

### CI has never executed

`.github/workflows/ci.yml` defines three jobs — a 6-cell test matrix
(Ubuntu/macOS/Windows × Node 22.12/24), a packaging job, and the release gate.
Every step has been run locally on macOS, but the workflow itself has never run
on GitHub because there is no remote. Windows and Linux behaviour is covered by
torture tests that simulate platform differences (path separators, drive
letters, UNC paths, case sensitivity), not by execution on those platforms.

**First push will be the first real test of the matrix.** Expect to fix
something.

### Undocumented commands

`pb dashboard`, `pb migrate`, `pb add` and `pb remove` exist, work and are
tested, but are absent from the README's command list. That list is a curated
subset by design, and `export`/`import` have since been added to it; the rest
are documented only in `--help`.

---

## Nice to have

- **Provenance.** Publishing with `npm publish --provenance` from CI would let
  users verify the tarball was built from the commit it claims.
- **A recorded demo.** The README's value depends on three console blocks that a
  reader must take on trust. An asciinema recording of a real session would do
  more than any paragraph.
- **Homebrew formula.** `npm install -g` is the only install path today.
- **Migration test against real pre-release data.** `pb migrate` is tested
  against synthesised v0 records; nobody has yet migrated a directory that grew
  organically over months.

---

## What was verified

Everything in this section was executed, not reasoned about.

| Area | Result |
| --- | --- |
| Tests | 617 passing, 21 files |
| Typecheck, lint, control bytes | Clean |
| Packaged-artifact verification | 41/41 checks pass (`npm run verify:package`) |
| Schema drift | Generated schemas match the code (9 files) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Runtime dependencies | 4 — commander, picocolors, yaml, zod. None has a dependency of its own |
| Install-time scripts | None in the production tree |
| Licenses | All MIT / ISC / BSD across the tree; project is MIT |
| Real install footprint | 4 packages, 13 MB, from a 584 KB tarball |
| Session-start latency | ~91 ms p50, flat from 10 to 500 projects (`npm run bench`) |
| Context brief size | 603 bytes |
| Documentation links | No broken relative links |
| Test isolation | Full suite run against a snapshot of `~/.claude`, `~/.ssh`, `~/.project-brain`, `~/.gitconfig` and `~/.config/gh`: nothing changed except two files written by the host coding agent itself |

### Acceptance pass on the packaged artifact

The tarball was installed into a clean prefix with an isolated
`PROJECT_BRAIN_HOME`, then driven end to end: `init`, `scan`, `projects`,
`checkpoint`, `resume`, `status`, `search`, `doctor`, `export`, `import`. All
behaved as documented, `doctor` reported every check green, and the resume brief
correctly surfaced the last session's summary, blockers and next actions. A
backup written by `pb export` restored into a fresh home with all three projects
and their checkpoints intact.

The Claude Code integration was then installed from that packaged artifact into
an isolated `CLAUDE_CONFIG_DIR`, confirmed active by both `pb integrate status`
and `pb doctor`, removed with `pb integrate remove claude`, and confirmed gone.
Everything it wrote landed in the isolated directory; the real `~/.claude` was
untouched, verified by timestamp before and after.

This pass found three defects, all now fixed:

1. `--yes` meant "assume the default", so on every prompt guarding something
   destructive it cancelled and exited 0.
2. `CLAUDE_CONFIG_DIR` was ignored when reading Claude Code's state, so
   `pb doctor` reported on the real `~/.claude` even when pointed elsewhere —
   and CONTRIBUTING.md's instruction to use a scratch directory did not protect
   anyone who followed it.
3. Seven user-facing messages hardcoded `npm install -g project-brain`, telling
   users to install an unrelated package.

Confirmed: no `pb` command writes to `CLAUDE_CONFIG_DIR` as a side effect.
Registering the plugin is an explicit `pb integrate claude` step and never
happens during `init`, `scan`, `doctor` or any read command.

---

## Explicitly out of scope for 0.1.0

Stated so that their absence reads as a decision rather than an oversight.

- No library API. `package.json` declares no `main` or `types`; `exports`
  exposes only `package.json`, so `import '<name>'` fails cleanly rather than
  resolving into internal modules. The CLI, the on-disk format and the MCP tools
  are the interface.
- No adapters beyond Claude Code.
- No cloud, no accounts, no embeddings, no vector database.
- Version is 0.1.0 and the on-disk format may change before 1.0.0. Migrations
  are provided and back up before they write.
