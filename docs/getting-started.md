# Getting started

## Install

```bash
npm install -g project-brain
pb init
```

Node.js 22.12 or newer. Git is optional but strongly recommended: without it,
Project Brain cannot read branches, commits or uncommitted changes.

`pb init` shows you what it stores **before it writes anything**, asks which
directories hold your projects, and scans them.

```
✓ Project Brain initialised
✓ Machine registered: emin-macbook (macos)
✓ 37 projects discovered
✓ 12 active in the last 30 days
```

Non-interactive (CI, scripts, dotfiles):

```bash
pb init --yes --roots ~/Projects ~/Work --no-claude
```

## Your first five minutes

```bash
pb projects          # everything it found
pb recent            # what you have actually been working on
pb status            # blocked, stale, uncommitted
```

Then pick something up:

```bash
pb resume world-war
```

Partial names work. `pb resume world` finds `world-war-rts`. If a term is
ambiguous, Project Brain lists the candidates and asks — it never guesses.

## Record something worth remembering

The value comes out of what goes in. After a real session:

```bash
pb checkpoint -m "Replaced the match timer with unlimited matches" \
  --did "pause/resume for AI matches" \
  --blocked "AI cannot rebuild a destroyed refinery" \
  --next "fix the refinery rebuild logic"
```

Write it for someone who has forgotten everything, because in three months that
is you. "Updated files" is worse than nothing.

Lighter-weight, for a single thought:

```bash
pb task add "test the economy after 30 minutes"
pb decision add "Removed the 15-minute match limit" \
  --reason "Players prefer long base-building sessions"
```

A decision records **why** — the part git history never captures, and the part
that stops a future session undoing the choice by accident.

## Record where things run

```bash
pb remote import-ssh     # pick hosts from your ~/.ssh/config
pb deploy add taxi-checker --remote taxi-prod --path /opt/taxi-checker
pb where taxi            # every copy and every deployment
```

Nothing is imported without you choosing it, host by host. Only the alias,
hostname, user and port are stored — never a key or anything it points to.

## Add a second machine

Project Brain identifies a project by its git remote, so the same repository on
your laptop and your workstation is **one project with two locations**, even
though the paths differ.

On the second machine:

```bash
npm install -g project-brain
pb init
```

To carry your notes across too, sync both to a private repository you own:

```bash
# On the first machine
pb sync init git@github.com:you/project-brain-data.git
pb sync

# On the second
pb sync init git@github.com:you/project-brain-data.git
pb sync
```

## Keep work separate

```bash
pb --profile work init
pb --profile work scan ~/Work
pb --profile work sync init git@github.company.com:you/brain-data.git
```

Each profile is its own directory with its own remote. A work project cannot
reach your personal repository.

Set a default for a shell session:

```bash
export PROJECT_BRAIN_PROFILE=work
```

## Connect Claude Code

```bash
pb integrate claude
```

See [claude-code.md](claude-code.md).

## When something is wrong

```bash
pb doctor
```

Every failing check prints the command that fixes it. If it does not, that is a
bug worth reporting.
