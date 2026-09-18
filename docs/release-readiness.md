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

### The resume footer reads as jargon

`pb resume` ends with `Last checkpoint just now. 1 loaded — use --full to read
them.` "1 loaded" describes the program's internals, not the user's situation.
Worth one pass over trailing status lines across commands.

### Undocumented commands

`pb dashboard`, `pb export`, `pb import`, `pb migrate`, `pb add` and `pb remove`
exist, work and are tested, but are absent from the README's command list. That
list is a curated subset by design; `export`/`import` in particular deserve a
mention, because a user who does not know a backup command exists cannot use it.

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
| Tests | 608 passing, 19 files |
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
`checkpoint`, `resume`, `status`, `search`, `doctor`. All behaved as documented,
`doctor` reported every check green, and the resume brief correctly surfaced the
last session's summary, blockers and next actions.

Separately confirmed: no `pb` command writes anything to `CLAUDE_CONFIG_DIR`.
Registering the plugin is an explicit `pb integrate claude` step and never a
side effect of `init`, `scan`, `doctor` or any read command.

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
