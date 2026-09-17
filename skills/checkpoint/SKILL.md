---
name: checkpoint
description: Record what was accomplished in this session so it can be picked up later. Use when the user says "checkpoint", "save progress", "record what we did", when finishing a substantial piece of work, or before the user steps away.
argument-hint: "[optional note]"
---

# Record a checkpoint

Write down what this session accomplished, for whoever reads it months from now.

## Steps

1. Call `projectbrain_checkpoint` with:
   - `summary` — one or two sentences: what changed and why it mattered
   - `completed` — what was actually finished
   - `decisions` — choices made that a diff would not reveal
   - `blockers` — anything stopping progress
   - `next` — what should happen next

2. Confirm briefly to the user. Do not print the whole checkpoint back.

## Writing a good checkpoint

This is the whole value of the tool. Quality matters far more than frequency.

Bad:
> Updated files. Fixed some bugs.

Good:
> Replaced the mandatory 15-minute match timer with unlimited matches, so AI
> games can now be paused and resumed. The multiplayer protocol is unchanged.
> Economy balancing is still unfinished.

Rules:
- Say what changed *and why it mattered*. The diff already records what changed.
- Name the things that are still broken. A checkpoint that only lists wins is
  misleading six months later.
- Write "next" as something actionable, not "continue working".
- Do not paste code, file listings, or command output into it.

## When not to checkpoint

Do not checkpoint after every edit — that produces memory nobody can read.
Checkpoint when a meaningful unit of work is done, or when the user is leaving.
If nothing substantive happened since the last one, say so instead.
