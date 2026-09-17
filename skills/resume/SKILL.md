---
name: resume
description: Pick a project back up. Use when the user says "resume X", "what was I doing in X", "where did I leave off", "catch me up on X", or returns to a project after a break. Loads what the project is, what was recently done, what is blocked, what is next, and where it lives.
argument-hint: "[project name]"
---

# Resume a project

Load everything needed to continue work on a project, then summarise it for the user.

## Steps

1. Call `projectbrain_get_resume_context` with the project name the user gave.
   - If they gave no name, call `projectbrain_current_project` first to see which
     project this directory belongs to.
   - Partial names work: "world" resolves "world-war-rts". If the tool reports
     the name is ambiguous, show the user the candidates and ask which they meant.
     Never pick one for them.

2. Read the result and tell the user, in a few sentences:
   - what this project is, if it is not obvious
   - what was last done, and when
   - what is blocked
   - what the next action is

3. Then offer to start on the top next action. Do not start without being asked.

## What matters

Write the summary for someone who has genuinely forgotten. "Last worked on the
refinery AI three weeks ago; it still fails to rebuild after being destroyed,
and that is the next thing" is useful. "This project has 4 checkpoints" is not.

If the context mentions a decision, mention it too — decisions exist
specifically so a later session does not undo them by accident.

If there is no recorded history yet, say so plainly rather than padding.
