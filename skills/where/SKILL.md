---
name: where
description: Find where a project lives — local paths on each machine, which server it is deployed to, the ssh alias and deploy path. Use when the user asks "where is X", "which VPS runs X", "what's the path on the server", "where did I clone this".
argument-hint: "[project name]"
---

# Where does this project live?

1. Call `projectbrain_where` with the project name.
2. Report the local copies (with machine names) and every deployment, including
   ssh alias, host, deploy path and service name.

## Important

Project Brain records **addresses only**. It holds no passwords, no keys, and
no way to connect anywhere. If the user wants to act on a server, give them the
command to run themselves — for example `ssh taxi-prod` — rather than
attempting a connection.

If the project has no recorded deployment, say so, and mention they can record
one with `pb deploy add <project> --remote <server> --path /opt/app`.
