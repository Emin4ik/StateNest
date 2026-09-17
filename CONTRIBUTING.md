# Contributing

Thanks for being here. Project Brain is a tool people trust with metadata about
all of their work, so the bar is correctness and clarity over speed.

## Getting set up

```bash
git clone https://github.com/project-brain/project-brain
cd project-brain
npm install
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
export PROJECT_BRAIN_HOME=/tmp/pb-dev
node dist/cli/bin.js init --yes
```

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs all four on Ubuntu, macOS and Windows.

## What we look for

**Tests that describe behaviour.** `it('refuses to choose between three
projects matching "api"')` tells a future reader what the product promises.
`it('works')` does not.

**Never weaken a test to make it pass.** If a test fails, either the code is
wrong or the test encodes the wrong expectation — say which, in the PR. A
recurring trap: fixtures for format-validated inputs (token lengths, checksums)
should be *generated* from the constraint, not typed by hand.

**Comments that explain why.** The code already says what it does. A comment
earns its place by explaining a decision, a constraint, or a bug it prevents.

**Errors that name the fix.** Every `BrainError` carries hints. An error the
user cannot act on is an unfinished error.

## Things that need extra care

| Area | Why |
| --- | --- |
| `src/security/` | Changing a pattern changes what leaks. Add tests both ways: it detects the real thing, and it does not fire on the lookalike. |
| `src/git/remote-url.ts` | Project identity. A change here can split one project in two across machines, or merge two into one. |
| `src/storage/` | Data loss lives here. Writes are atomic; keep them that way. |
| `src/integrations/claude/` | Runs inside someone else's tool. It must never exit non-zero, never block, and never exceed its deadline. |
| Anything touching a user's repository | Project Brain **reads** source repositories. It must never write to one. There is a test enforcing this; do not skip it. |

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
claude plugin install project-brain@project-brain
```

The source tree has `node_modules` beside the code; a real install does not.
That gap has already produced one bug that no in-tree test could catch
(ADR 0006).

## Commit messages

Present tense, explaining the change and why. If it fixes a bug, say what the
bug was — the message is the only place a future reader will find that.
