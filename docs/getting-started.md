# Getting started

> The short version. For the mental model, what `scan` actually does and how
> the Claude Code integration works, read the [user guide](user-guide.md); for
> every command and option, the [command reference](command-reference.md).

## Install

```bash
npm install -g statenest
statenest init
```

Node.js 22.12 or newer. Git is optional but strongly recommended: without it,
StateNest cannot read branches, commits or uncommitted changes.

`statenest init` shows you what it stores **before it writes anything**, asks which
directories hold your projects, and scans them.

```
✓ StateNest initialised
✓ Machine registered: emin-macbook (macos)
✓ 37 projects discovered
✓ 12 active in the last 30 days
```

Non-interactive (CI, scripts, dotfiles):

```bash
statenest init --yes --roots ~/Projects ~/Work --no-claude
```

## Your first five minutes

```bash
statenest projects          # everything it found
statenest recent            # what you have actually been working on
statenest status            # blocked, stale, uncommitted
```

Then pick something up:

```bash
statenest resume world-war
```

Partial names work. `statenest resume world` finds `world-war-rts`. If a term is
ambiguous, StateNest lists the candidates and asks — it never guesses.

## Record something worth remembering

The value comes out of what goes in. After a real session:

```bash
statenest checkpoint -m "Replaced the match timer with unlimited matches" \
  --did "pause/resume for AI matches" \
  --blocked "AI cannot rebuild a destroyed refinery" \
  --next "fix the refinery rebuild logic"
```

Write it for someone who has forgotten everything, because in three months that
is you. "Updated files" is worse than nothing.

Lighter-weight, for a single thought:

```bash
statenest task add "test the economy after 30 minutes"
statenest decision add "Removed the 15-minute match limit" \
  --reason "Players prefer long base-building sessions"
```

A decision records **why** — the part git history never captures, and the part
that stops a future session undoing the choice by accident.

## Record where things run

```bash
statenest remote import-ssh     # pick hosts from your ~/.ssh/config
statenest deploy add taxi-checker --remote taxi-prod --path /opt/taxi-checker
statenest where taxi            # every copy and every deployment
```

Nothing is imported without you choosing it, host by host. Only the alias,
hostname, user and port are stored — never a key or anything it points to.

## Add a second machine

StateNest identifies a project by its git remote, so the same repository on
your laptop and your workstation is **one project with two locations**, even
though the paths differ.

On the second machine:

```bash
npm install -g statenest
statenest init
```

To carry your notes across too, sync both to a private repository you own.
**Use the same profile name on both machines** — `personal` is the default, so
usually there is nothing to change:

```bash
# On the first machine
statenest sync init git@github.com:you/statenest-data.git
statenest sync

# On the second, sync BEFORE scanning: receive what already exists,
# then register what lives here.
statenest sync init git@github.com:you/statenest-data.git
statenest sync
statenest scan ~/code --save-roots
statenest sync
```

Both machines now share one registry. `statenest projects` lists everything,
including projects whose code is only on the other machine, and
`statenest where <project>` says which machine has what.

Full walkthrough, including what happens when two machines disagree:
[multi-machine.md](multi-machine.md).

## Optionally, keep work separate

Profiles are an **optional** isolation boundary, not something you have to use.
Reach for one when personal and work metadata must not share a sync repository:

```bash
statenest --profile work init
statenest --profile work scan ~/Work
statenest --profile work sync init git@github.company.com:you/brain-data.git
```

Each profile is its own directory with its own remote. A work project cannot
reach your personal repository. To see both at once, read-only:

```bash
statenest dashboard --all-profiles --open
```

If you would rather have one namespace for everything, that is equally valid —
keep a single profile and skip this section.

Set a default for a shell session:

```bash
export STATENEST_PROFILE=work
```

## Connect Claude Code

```bash
statenest integrate claude
```

See [claude-code.md](claude-code.md).

## When something is wrong

```bash
statenest doctor
```

Every failing check prints the command that fixes it. If it does not, that is a
bug worth reporting.
