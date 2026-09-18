---
name: status
description: Overview of everything — what is active, what is blocked, what has uncommitted changes, what has gone stale. Use when the user asks "where do things stand", "what needs attention", "what's the state of everything", or starts a working session without a specific goal.
---

# Where things stand

1. Call `statenest_list_projects` for the overall picture, and
   `statenest_list_recent` for what has moved lately.
2. Lead with anything that needs attention: blocked projects first, then
   anything left with uncommitted work.
3. Finish with a short, concrete suggestion of what to pick up — based on what
   is actually recorded as the next action, not on your own judgement of what
   seems important.

Keep it to a handful of lines. The point is orientation, not a status report.
