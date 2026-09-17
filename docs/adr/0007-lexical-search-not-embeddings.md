# ADR 0007: Local lexical search, not embeddings

**Status:** accepted · 2026-09-17

## Context

Search covers project names, notes, checkpoints, decisions, tasks and server
labels: a few hundred projects and a few thousand short documents.

## Decision

Direct lexical search over the stored text. All query terms must match (AND),
whole-word hits outrank substring hits, and recency lifts newer checkpoints.
No index, no embeddings, no vector database.

## Consequences

- No model, no API key, no network, no index to rebuild or invalidate — and
  nothing to corrupt.
- Fast enough to feel instant at this scale; every document is short prose.
- It never returns a confidently wrong result the way a similarity score can.
  For "where did I write about the refinery", an exact-match miss is honest and
  a plausible-looking wrong hit is not.
- Genuinely fuzzy recall ("that thing about the camera pipeline") is not
  supported. Semantic search can be added later as an optional module behind
  the same `search()` interface; it is not needed to make the product useful.
