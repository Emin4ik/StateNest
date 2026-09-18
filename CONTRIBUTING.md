# Contributing

Thanks for being here. StateNest is a tool people trust with metadata about
all of their work, so the bar is correctness and clarity over speed.

If you are a coding agent rather than a person, read
[AGENTS.md](AGENTS.md) instead — it covers the invariants, commands and testing
rules in the form you need.

## Getting set up

```bash
git clone https://github.com/Emin4ik/StateNest.git
cd StateNest
npm ci
npm run build
npm test
```

Run your working copy without installing it globally:

```bash
node dist/cli/bin.js --help
```

**Always point it at a scratch home while developing.** Otherwise you are
testing against your own real data:

```bash
export STATENEST_HOME=/tmp/pb-dev
node dist/cli/bin.js init --yes
```

## Before opening a pull request

```bash
npm run verify
```

That is typecheck, lint, the control-byte check, the full test suite and a
build. CI runs it on Ubuntu, macOS and Windows, against Node 22.12 and 24.

If you touched anything that ships — `package.json`, the plugin manifests, a
zod schema, the generated JSON Schemas — run the release gate too:

```bash
npm run release:check
```

It adds a schema-drift check, a verification of the packed tarball as actually
installed, and the metadata gate. It exits non-zero today on purpose: the
project name is unresolved. See [docs/release-readiness.md](docs/release-readiness.md).

## What we look for

**Tests that describe behaviour.** `it('refuses to choose between three
projects matching "api"')` tells a future reader what the product promises.
`it('works')` does not.

**Never weaken a test to make it pass.** If a test fails, either the code is
wrong or the test encodes the wrong expectation — say which, in the PR. A
recurring trap: fixtures for format-validated inputs (token lengths, checksums)
should be _generated_ from the constraint, not typed by hand.

**Comments that explain why.** The code already says what it does. A comment
earns its place by explaining a decision, a constraint, or a bug it prevents.

**Errors that name the fix.** Every `BrainError` carries hints. An error the
user cannot act on is an unfinished error.

## Things that need extra care

| Area                                  | Why                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/security/`                       | Changing a pattern changes what leaks. Add tests both ways: it detects the real thing, and it does not fire on the lookalike. |
| `src/git/remote-url.ts`               | Project identity. A change here can split one project in two across machines, or merge two into one.                          |
| `src/storage/`                        | Data loss lives here. Writes are atomic; keep them that way.                                                                  |
| `src/integrations/claude/`            | Runs inside someone else's tool. It must never exit non-zero, never block, and never exceed its deadline.                     |
| Anything touching a user's repository | StateNest **reads** source repositories. It must never write to one. There is a test enforcing this; do not skip it.          |

## Architecture rules

- **Core never imports an adapter.** `src/core/` must not know Claude Code
  exists. The dependency direction is in `docs/architecture/overview.md`.
- **New dependencies need a reason.** Before adding one, ask whether it
  materially improves reliability or developer experience. See ADR 0001.
- **A load-bearing decision gets an ADR.** Short, in `docs/adr/`, explaining the
  context and consequences — not just the decision.

## Verifying an integration

If you change anything the plugin ships, verify it **in its deployed shape**,
not just from the source tree:

```bash
export CLAUDE_CONFIG_DIR=/tmp/claude-test   # never your real ~/.claude
npm run build
claude plugin marketplace add "$PWD"
claude plugin install statenest@statenest
```

The source tree has `node_modules` beside the code; a real install does not.
That gap has already produced one bug that no in-tree test could catch
(ADR 0006).

## Releasing

Maintainers only, and deliberately not automated end to end:

- [docs/release/checklist.md](docs/release/checklist.md) — the checklist to work
  through, including post-publish verification against the real registry
- [docs/release/npm-publishing.md](docs/release/npm-publishing.md) — why the
  first release is published by hand and every one after it is not
- [docs/release/rollback.md](docs/release/rollback.md) — what to do when a
  release is bad. Short version: never replace a published version

Releases are triggered by pushing a `v*` tag, which runs
[.github/workflows/release.yml](.github/workflows/release.yml). That workflow
runs `npm run release:check` — the same gate you run locally — and refuses to
publish if the tag and `package.json` disagree, or if the version already
exists.

## Commit messages

Present tense, explaining the change and why. If it fixes a bug, say what the
bug was — the message is the only place a future reader will find that.
