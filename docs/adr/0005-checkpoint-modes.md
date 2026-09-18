# ADR 0005: Default to metadata checkpoints, with rich ones written where a
model is already in context

**Status:** accepted · 2026-09-17

## Context

A good checkpoint is prose: what changed, why it mattered, what is still
broken. Generating prose needs a model. The brief requires that StateNest
not depend on a paid API, and that it be honest about any cost it does incur.

Research settled the options empirically:

- Session-lifecycle hooks **cannot invoke an LLM**. `prompt` and `agent` hook
  types are unsupported on SessionStart, SessionEnd and PreCompact.
- Shelling out to `claude -p` costs **~$0.03 minimum** per call in a
  plugin-heavy environment, and `--resume` re-sends the whole conversation
  (the docs' own example exceeds $1).
- A `Stop` hook returning `decision: block` *can* make the live model
  summarise, but it hijacks the user's turn.
- **`PostCompact` receives a model-written `compact_summary` for free.**

## Decision

Default mode is `manual-smart`:

| Path | Mode | Cost |
| --- | --- | --- |
| `SessionEnd` | Metadata: branch, commit, dirtiness, file counts | none |
| `PostCompact` | Rich, from the free `compact_summary` | none |
| `/statenest:checkpoint` or MCP tool | Rich, written by the agent already in context | none extra |
| `statenest checkpoint -m "…"` | Rich, written by the user | none |

StateNest never spawns a model. Every rich checkpoint reuses work that has
already been done and paid for.

Metadata-only summaries say only what was observed — "automatic checkpoint on
phase-7 at 72ba934 with 8 uncommitted changes" — never "updated files", which
would be worse than useless later.

## Consequences

- The tool works fully with no API key and no network.
- `PostCompact` turns out to be the highest-value event: a genuine narrative
  checkpoint arrives free, exactly when a long session is about to forget.
- Free-text summaries pass through the secret scanner before being written; a
  summary of a coding session is exactly where a pasted token shows up.
- Low noise is enforced separately by `isCheckpointWorthwhile`: a minimum
  interval plus a requirement that something actually changed.
