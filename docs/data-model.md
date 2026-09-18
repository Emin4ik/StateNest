# Data model

Everything StateNest knows lives under `~/.statenest` as YAML and
Markdown. You can read it, grep it, edit it and diff it without StateNest
installed — that is a design goal, not a side effect.

JSON Schemas for every record are published in [`schemas/`](../schemas/),
generated from the same definitions the code validates against.

## Layout

```
~/.statenest/
  config.yaml                  global settings
  machine.json                 THIS computer's id — outside every profile,
                               so it can never reach a data repository
  profiles/
    personal/                  a complete, independently syncable unit
      profile.yaml
      .gitattributes           merge rules (written for you)
      projects/
        prj_t4f8drdzsyxc/
          project.yaml         identity, locations, deployments
          state.md             what is true right now
          tasks.yaml           next actions
          decisions.md         decisions, append-only
      checkpoints/
        prj_t4f8drdzsyxc/
          2026/09/17/193612_cp_9qyyxcmd.md
      machines/machine_30cmfcaqe5.yaml
      remotes/remote_a81c9f2b.yaml
    work/                      a different directory, a different git remote
  cache/                       derived, disposable, never synced
  logs/
  backups/
```

## Identity

**A project's id is derived from its git remote**, so two machines that have
never communicated compute the same id for the same repository:

```
git@github.com:Acme/Widget.git
https://github.com/acme/widget          ->  github.com/acme/widget
ssh://git@github.com:2222/acme/widget.git       ->  prj_t4f8drdzsyxc
```

The port is dropped (transport, not identity) and the path is lowercased.
Credentials in a remote URL are stripped and never stored. See
[ADR 0002](adr/0002-project-identity-from-git-remote.md).

Repositories with no usable remote get a random id, minted once.

**A name is never identity.** Rename a project freely; its history follows.

## `project.yaml`

```yaml
schema_version: 1
id: prj_t4f8drdzsyxc
name: world-war-rts
description: A real-time strategy game with base building.
aliases: [world-war, world-war-rts]
type: unity
status: active            # active | paused | waiting | archived
tags: [game]

created_at: 2026-09-17T19:36:12Z
discovered_at: 2026-09-17T19:36:12Z
last_activity_at: 2026-09-17T19:40:01Z
last_checkpoint_at: 2026-09-17T19:36:12Z

repository:
  identity: github.com/emin/world-war-rts
  url: git@github.com:emin/world-war-rts.git   # sanitized
  host: github.com
  path: emin/world-war-rts
  owner: emin
  name: world-war-rts
  web_url: https://github.com/emin/world-war-rts
  default_branch: main

local_locations:
  - machine_id: machine_30cmfcaqe5
    path: /Users/emin/Projects/world-war
    is_worktree: false
    branch: phase-7
    head: 3a57a914c7f8...
    last_seen_at: 2026-09-17T19:40:01Z

deployments:
  - id: dep_a81c9f
    remote_id: remote_prod01
    environment: production
    path: /opt/world-war
    branch: main
    service: world-war.service
    updated_at: 2026-09-17T19:38:00Z

current_focus: Unit and building expansion.
blockers:
  - AI fails to rebuild a destroyed refinery
```

**Status is always yours.** StateNest never archives a project because time
passed; it reports recency separately ("active, last touched 42 days ago") and
lets you decide.

## Checkpoints

One checkpoint is one **immutable** file at a timestamped path. That is what
lets two machines and two concurrent sessions write freely without ever
contending for the same file — and it is why syncing checkpoints between
machines produces a clean merge rather than a conflict.

```markdown
---
id: cp_9qyyxcmd
project_id: prj_t4f8drdzsyxc
timestamp: 2026-09-17T19:36:12Z
machine_id: machine_30cmfcaqe5
source: cli          # manual | cli | claude-code | session-end | pre-compact | post-compact
mode: smart          # smart | metadata
branch: phase-7
commit: 3a57a914c7f8...
dirty: true
changed_files: 1
tags: [gameplay]
---

# Summary

Replaced the mandatory 15-minute match timer with unlimited matches.

# Completed

- unlimited match duration
- pause/resume for AI matches

# Blockers

- AI fails to rebuild a destroyed refinery

# Next

- fix refinery rebuild behaviour
```

The headings are fixed so they can be parsed back out, but the file stays an
ordinary markdown document. Never edit an old checkpoint: it is history.

## `state.md`

The small mutable "right now" layer. Keep it short — history belongs in
checkpoints.

```markdown
# Current focus

Unit and building expansion for phase 7.

# Environment

Unity 2022.3. Builds are tested on Windows only.
```

## `decisions.md`

Append-only. Each entry carries its structured fields in an HTML comment:
invisible when rendered, exact when parsed, and safe to resolve with git's
`union` merge driver when two machines record decisions independently.

```markdown
## Remove the mandatory 15-minute match limit
<!-- pb-decision: {"id":"dec_x1y2","timestamp":"2026-09-17T19:36:40Z",...} -->

Players prefer long base-building sessions, and the timer ended matches that
were still interesting.

**Considered instead:**
- A configurable timer (rejected: another setting nobody would find)
```

## `remotes/*.yaml`

```yaml
schema_version: 1
id: remote_prod01
name: taxi-prod
type: vps
environment: production
ssh_alias: taxi-prod
host: 203.0.113.10
user: deploy
port: 22
provider: hetzner
```

**There is no field for a credential** — no password, no key path, no token.
Not by policy, but by schema. Authentication stays with your ssh config.

## Timestamps

UTC ISO-8601, second precision, trailing `Z`: `2026-09-17T19:36:12Z`. Displayed
in your local timezone. Second precision keeps YAML diffs readable and is more
resolution than "when did I last touch this" needs.

## Schema versions

Every record carries `schema_version`. Every schema is a **loose** object:
fields written by a newer version of StateNest are preserved, not stripped.
An older machine syncing the same data cannot silently drop what a newer one
wrote.

Until 1.0.0 the format may change between minor versions. Migrations are
provided and never destructive.

## Editing by hand

Go ahead. Point your editor at [`schemas/`](../schemas/) for completion and
validation. Two rules:

1. **Do not change an `id`.** It is the link between a project, its
   checkpoints and its tasks.
2. **Do not edit old checkpoints.** They are history, and other machines may
   already have them.

If a file becomes unparseable, StateNest reports it and keeps working with
everything else. It never deletes a file it could not read.
