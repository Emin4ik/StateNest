---
name: projects
description: List the user's projects, or find ones matching a condition — active, paused, stale, deployed. Use when they ask "what projects do I have", "which ones haven't I touched", "show my active work", or are trying to remember whether a project exists.
argument-hint: "[filter]"
---

# List projects

1. Call `projectbrain_list_projects`. Use `status` or `stale_days` to narrow it
   rather than listing everything and filtering in your reply.
2. Present the result compactly: name, when it was last active, and the current
   focus if there is one.

If the user is looking for something specific and cannot remember the name, use
`projectbrain_search` instead — it searches their own checkpoints, decisions and
notes.

Never suggest archiving or deleting a project on your own. Staleness is
information, not a recommendation; the user decides.
