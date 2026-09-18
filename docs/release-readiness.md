# Release readiness

Assessed 2026-09-18 against the current tree, after the rename to StateNest and
the first real CI runs.

**Status: released.** v0.1.0 was published to npm on 2026-09-18. The two
blockers that held it — an unusable name and no repository identity — were
resolved, and the cross-platform matrix actually executed rather than merely
existing as YAML.

This document is kept as the record of what was verified before that release.
The living process lives in [release/checklist.md](release/checklist.md).

Run `npm run release:check` for the machine-checkable half of this document. It
exits 0.

---

## Blockers

**None.**

For the record, the two that stood until this phase:

1. **The name.** `project-brain` was taken on npm by an actively maintained
   product in the same category, a paid commercial app used the literal name,
   and the phrase had become the generic term for the category. Resolved: the
   owner chose **StateNest**, verified free on npm, PyPI, Homebrew, Arch, the
   AUR, PATH and GitHub before anything was renamed
   ([final-name-selection.md](research/final-name-selection.md)).
2. **No repository owner.** Resolved:
   [Emin4ik/StateNest](https://github.com/Emin4ik/StateNest), public, MIT,
   default branch `main`.

`statenest@0.1.0` is on npm, `v0.1.0` is tagged, and the GitHub Release exists.

---

## Important

- **0.1.0 carries no provenance attestation.** It had to be published by hand,
  because npm will not configure a trusted publisher for a package that does not
  exist yet. Trusted publishing is configured now, so every release after it is
  published from GitHub Actions with provenance.
- **No recorded demo.** `npm run demo` is deterministic and safe to record
  (invented data, throwaway home, fixed machine name), but no recording exists,
  so the README still asks readers to take its console blocks on trust.
- **Branch protection is off.** Appropriate now that CI is known-good, but it
  changes the owner's own push workflow, so it has deliberately not been enabled
  without asking.

---

## Nice to have

- Homebrew formula; `npm install -g` is the only install path.
- `statenest dashboard`, `migrate`, `add` and `remove` are documented only in
  `--help`.
- `statenest migrate` has only been exercised against synthesised v0 records.
- A short CLI alias. `statenest` is nine characters and typed often; nothing
  claims `sn`, but adding an alias is a product decision, not an engineering one.

---

## What was verified

Everything here was executed.

| Area | Result |
| --- | --- |
| Tests | 638 passing, 24 files |
| Local release gate | `npm run release:check` exits 0 |
| GitHub Actions | Full matrix green — see below |
| Packaged-artifact verification | 41/41 (`npm run verify:package`) |
| Packaged install, per OS | Ubuntu, macOS, Windows (`npm run smoke:install` in CI) |
| Schema drift | Generated schemas match the code (9 files) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Runtime dependencies | 4 — commander, picocolors, yaml, zod; none has a dependency of its own |
| Install-time scripts | None across the 4 production packages |
| Licenses | MIT / ISC / BSD throughout; project is MIT |
| Release artifact | `statenest-0.1.0.tgz`, 507 KB compressed, 2.37 MB unpacked, 186 files |
| Security suites | 175 tests across redaction, leakage, traversal, injection, isolation |
| Claude integration | Installed, verified and removed from a packed tarball into an isolated `CLAUDE_CONFIG_DIR` |
| Session-start latency | Flat from 10 to 500 projects (see Performance) |
| Documentation links | No broken relative links |

### Real CI

The matrix is no longer hypothetical. Every job below ran on GitHub Actions:

| Job | Result |
| --- | --- |
| ubuntu-latest / node 22.12 | pass |
| ubuntu-latest / node 24 | pass |
| macos-latest / node 22.12 | pass |
| macos-latest / node 24 | pass |
| windows-latest / node 22.12 | pass |
| windows-latest / node 24 | pass |
| Package / ubuntu-latest | pass |
| Package / macos-latest | pass |
| Package / windows-latest | pass |
| Release gate | pass |

The first run failed every cell. The causes and fixes are in the phase report
and the commit history; Windows alone accounted for 290 failures traced to a
single path-comparison bug.

### Performance

Session start is flat from 10 to 500 projects, which is the property that
matters — it means the project is resolved by a hash of its git remote rather
than by searching. The absolute numbers from the most recent run were taken on a
machine carrying an unrelated process using ~5.8 cores (load average 15), so
they are inflated: ~150 ms p50 against ~91 ms measured on a quiet machine
earlier. Nothing in the rename touches those code paths. Re-run `npm run bench`
on an idle machine before quoting a figure publicly.

---

## Explicitly out of scope for 0.1.0

- No library API. `package.json` declares no `main` or `types`, and `exports`
  exposes only `package.json`, so `import 'statenest'` fails cleanly rather than
  resolving into internal modules. The CLI, the on-disk format and the MCP tools
  are the interface.
- No adapters beyond Claude Code.
- No cloud, no accounts, no embeddings, no vector database.
- Version is 0.1.0. The on-disk format may change before 1.0.0; migrations are
  applied on read and back up before writing.
- Pre-rename data in the old data directory is detected and reported, never read
  or migrated. See the CHANGELOG.
