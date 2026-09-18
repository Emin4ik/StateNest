---
name: recent
description: Show what the user has been working on lately across all their projects. Use when they ask "what was I doing yesterday", "what did I work on this week", "what have I been up to", or when they seem unsure which project to return to.
argument-hint: "[days]"
---

# Recent activity

1. Call `statenest_list_recent`. Pass `days` if the user named a period.
2. Group the result the way the user thinks about time — today, yesterday,
   earlier this week — and give one line per project.
3. If something is blocked or has an obvious next action, surface it.

Keep it short. This is meant to orient someone in a few seconds, not to be a
complete report. If they want detail on one project, use the resume skill.
