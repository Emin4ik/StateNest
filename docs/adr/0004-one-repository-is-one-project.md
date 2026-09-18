# ADR 0004: One git repository is one project

**Status:** accepted · 2026-09-17

## Context

Scanning finds nested repositories, worktrees, submodules and monorepos. Each
could plausibly be "a project".

## Decision

For the MVP: **one git repository is one project.** The scanner stops
descending as soon as it finds a repository root.

- **Worktrees** are another *location* of the same project, not a new one. A
  `.git` file pointing into `…/worktrees/<name>` is detected and recorded with
  `is_worktree: true` and the main working tree's path.
- **Submodules** (a `.git` file pointing into `…/modules/<name>`) are part of
  their parent and are not registered separately.
- **Monorepos** are one project. Sub-project support is deliberately deferred.

`--nested` opts back in to descending, for submodule-heavy setups.

## Consequences

- Scanning is dramatically faster: a large monorepo is one `readdir`, not a
  full tree walk.
- A user who genuinely wants a sub-directory tracked separately can
  `statenest add path/to/subdir`, which registers it explicitly.
- The data model already separates project from location, so adding
  sub-projects later is additive rather than a migration.
