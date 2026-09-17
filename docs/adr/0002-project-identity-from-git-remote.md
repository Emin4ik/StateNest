# ADR 0002: A project is identified by its normalized git remote

**Status:** accepted · 2026-09-17

## Context

The same project lives at different paths on different machines. Any identity
derived from a filesystem path fragments the moment a second machine appears —
which is precisely the case the product exists to serve.

## Decision

A project's id is `prj_` plus a truncated SHA-256 of its **normalized remote
identity**: `github.com/acme/widget`.

Normalization (in `src/git/remote-url.ts`) collapses every URL form for one
repository to one string. Two deliberate choices:

- **The port is dropped.** A repository reachable on ssh 22 and 2222 is one
  repository; the port is transport, not identity.
- **The path is lowercased.** Hosts differ on case sensitivity, but the
  realistic failure modes are asymmetric: the same project appearing twice
  because two machines typed the URL differently is common, whereas two
  distinct repositories on one host differing only by case is vanishingly rare.

Credentials embedded in a remote URL are stripped and never returned, so a
token cannot be persisted by accident — it is not in the result object.

Repositories with no usable remote (or a `file:`/local-path remote, which is
machine-specific) get a random id, minted once.

## Consequences

- Two machines derive the same id independently, with no coordination. This is
  what makes a synced data directory merge rather than duplicate.
- The id is also a **fast path**: the project file can be addressed directly
  from the remote, so the SessionStart hook reads one file instead of loading
  every project.
- A project that gains a remote after being registered keeps its random id. The
  lookup falls back to a full scan on a miss, so nothing breaks.
- Provider-specific rules (Azure DevOps `v3/`/`_git/`, Bitbucket `/scm/`) are
  an explicit, short, documented list. Each exists because that host genuinely
  serves one repository under two path shapes.
