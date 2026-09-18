# ADR 0003: A profile is a directory, and that is the isolation boundary

**Status:** accepted · 2026-09-17

## Context

Users have personal projects, employer projects and client projects on one
machine. A work project must never end up in a personal GitHub repository.

The obvious design — one shared store with a `profile:` field on each record —
makes that guarantee a rule the code must remember at every write and every
sync. Rules like that get broken.

## Decision

Each profile owns a complete directory subtree, and sync operates on exactly
one of them:

```
~/.statenest/profiles/personal/   <- its own git repo, its own remote
~/.statenest/profiles/work/       <- a different repo, a different remote
```

Machine-local and derived state lives **outside** every profile:
`machine.json`, `cache/`, `logs/`, `backups/`.

## Consequences

- Cross-profile leakage is structurally impossible, not merely prevented. A
  work file is not inside the personal directory, so no sync can carry it there.
- Each profile gets independent sync settings, privacy level, project roots and
  scan behaviour, at no extra cost.
- `machine.json` sitting outside every profile means a data repository cloned
  to a second machine cannot tell that machine it is the first one.
- Each profile carries a duplicate machine record. This is the price, and it is
  small: a machine record is a few hundred bytes, and the duplication is what
  makes each profile directory independently complete.
