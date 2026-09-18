# StateNest

**You have forty projects. You cannot remember where you stopped in any of them.**

Which repo was that? Where did I clone it on this laptop? Which VPS runs it?
What was I halfway through? What did I decide, and why? Which of these have I
not touched in three months?

Git history does not answer these questions. Neither does an AI chat log.

StateNest does. It is a local-first control plane for your own work: it
remembers your projects, where each one lives on each machine, which servers
they deploy to, what you finished, what is blocked, and what you meant to do
next.

Everything is plain YAML and Markdown in `~/.statenest`. There is no account,
and nothing leaves your machine by default. Optional sync sends StateNest's own
data — never your source code — to a private git repository **you** choose.

---

## 30 seconds

```console
$ statenest recent

TODAY
  taxi-checker  main
    Replaced fixed-resolution preprocessing with adaptive letterboxing.
    next: re-benchmark the iOS build

3 DAYS AGO
  world-war-rts  phase-7
    Replaced the mandatory 15-minute match timer with unlimited matches.
    next: fix refinery rebuild behaviour
    blocked: AI fails to rebuild a destroyed refinery
```

```console
$ statenest resume world-war

world-war-rts
active  ·  3d ago

  A real-time strategy game with base building.

  Here   ~/Projects/world-war  ·  phase-7  ·  72ba934  ·  8 uncommitted
  Also   workstation  D:\AI\world-war

  Recently completed
    • unlimited match duration
    • pause/resume for AI matches
    • refinery income fix

  Blockers
    • AI fails to rebuild a destroyed refinery

  Next
    1. fix refinery rebuild behaviour
    2. add SAM defensive structures

  Decisions worth knowing
    • Removed the mandatory 15-minute match limit (3 weeks ago)
```

```console
$ statenest where taxi

taxi-checker

  Local
    emin-macbook  (this machine)
      ~/Projects/taxi-checker  (main)

  Deployed
    production
      ssh alias   taxi-prod
      path        /opt/taxi-checker
      service     taxi.service
```

That is the product.

---

## Install once, then forget it

```bash
npm install -g statenest
statenest setup

cd my-project
claude
```

That is the whole workflow. Requires Node.js 22.12 or newer. To work on
StateNest itself instead, see [CONTRIBUTING.md](CONTRIBUTING.md).

`statenest setup` registers this machine, installs the Claude Code integration,
and offers to connect a private git repository so your other computers see the
same memory. It tells you exactly what it stores before it writes anything.

```
✓ Machine registered: emin-macbook (macos)
✓ Claude Code integration installed
✓ Sync connected
✓ Ready

  Open Claude Code inside a git project.
  StateNest will take it from here.
```

From then on, opening Claude Code inside a git repository is enough. StateNest

- **recognises the repository** and registers it if it is new — no `add`, no `scan`,
- **restores your context** into the session automatically,
- **remembers what happened**, reusing the summary Claude Code already writes,
- **synchronises it** to your own private repository in the background.

**An ordinary day needs no StateNest commands.** The CLI is still there for when
you want to look — `statenest recent`, `resume`, `where`, `status` — but nothing
routine depends on you remembering to run it.

### What is automatic, and what is not

| Automatic                                                               | Not automatic                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Registering a git repository **with a remote**, when Claude opens in it | Registering a repository with **no remote** — run `statenest add .`; a remote is what lets two machines agree it is one project |
| Restoring context at session start                                      | Registering directories that are not git repositories                                                                           |
| A checkpoint when Claude Code compacts, and at session end              | A rich summary of a short session that never compacted — run `/statenest:checkpoint`                                            |
| Sync, after anything worth sharing                                      | Resolving a genuine conflict — StateNest asks, and never merges for you                                                         |

Nothing is scanned. StateNest looks at the repository Claude was opened in and
nothing else: not its parent, not its siblings, not your home directory.

### Claude Code

Installed by `statenest setup`, or on its own with `statenest integrate claude`.

When you open Claude Code inside a project, it already knows where you left
off — about 600 characters of the right context, not a dump of your history:

```
# StateNest

Project: world-war-rts
Branch: phase-7
Last activity: 3d ago

## Recently completed
- unlimited match duration
- pause/resume for AI matches

## Open blockers
- AI fails to rebuild a destroyed refinery

## Next
- fix refinery rebuild behaviour
```

You also get skills — `/statenest:resume`, `/statenest:checkpoint`,
`/statenest:where` — and MCP tools that Claude uses on its own when you
ask "what was I doing yesterday?".

StateNest adds about **90ms** to session start — including Node's own
startup — and never spawns a model. That figure is flat from 10 projects to
500, because session start resolves the project by a hash of its git remote
rather than by searching. Reproduce it with `npm run bench`.

---

## Commands

```
statenest setup                     set up on this machine, end to end
statenest scan ~/Projects ~/Work    find and register projects in bulk
statenest projects                  list everything
statenest recent                    what you have been working on
statenest resume <project>          pick a project back up
statenest where <project>           every copy and every deployment
statenest show <project>            everything known about one project
statenest status                    active, blocked, stale, uncommitted
statenest search "refinery"         search your own history
statenest checkpoint -m "..."       record what you just did
statenest task add "..."            record a next action
statenest decision add "..."        record why you chose something
statenest remote import-ssh         pick servers from your ~/.ssh/config
statenest deploy add <project> ...  record where a project runs
statenest profile create work       keep work and personal separate
statenest export backup.tgz         back up everything to one file
statenest import backup.tgz         restore from a backup
statenest sync                      send and receive now, rather than waiting
statenest sync status               is everything up to date?
statenest sync repair               choose a side when two machines disagree
statenest doctor                    check everything, with fixes
statenest privacy audit             scan your own data for secrets
```

Every command takes `--json`. None of them is required for ordinary work — they
are for looking, and for the occasions when you want to decide something
yourself.

---

## What it stores, and what it never stores

StateNest reads your home directory. It should have to earn that, so here
it is plainly.

**Stores** — project names and descriptions; where each project lives on each
machine; git branch, commit sha and how many files changed; checkpoints you or
your coding agent write; decisions, tasks and blockers; server addresses and
deploy paths.

**Never stores** — your source code. `.env` files or anything inside them. ssh
private keys, passwords or API tokens. Raw AI transcripts. There is no
telemetry, and no code in this repository that could send any.

The filename deny-list is checked _before_ a file is opened, and everything
StateNest is about to write passes through a secret scanner first. Run
`statenest privacy audit` whenever you want to check for yourself.

Full detail: [docs/security-model.md](docs/security-model.md).

### Many machines: one profile, or several

**One profile is the simple case, and usually the right one.** Every machine
uses the same profile name and syncs to the same private repository, so
`statenest projects` lists everything you own — including projects whose code
lives on your other laptop.

```
Home MacBook ─┐
              ├── profile "personal" ──▶ PRIVATE statenest-data repo
Work laptop ──┘
```

**Profiles are an optional isolation boundary**, for when personal and work
metadata must not share a repository:

```bash
statenest profile create work        # a separate set of projects
statenest profile use work           # switch
statenest profile list               # see them all
statenest dashboard --all-profiles   # read-only view of everything
```

A work project then cannot sync into a personal repository, because sync
operates on one profile directory and the other profile's files are not inside
it — a property of the layout, not a rule anyone has to remember.

Neither model is more correct. Your privacy requirement decides, and
[docs/multi-machine.md](docs/multi-machine.md) walks through both.

### Optional sync, to a repository you own

`statenest setup` offers it; you can also connect it later:

```bash
statenest sync init git@github.com:you/statenest-data.git   # PRIVATE
```

**This is not cloud sync.** There is no StateNest service and no account. The
remote is an ordinary private git repository that you create and own, and the
only thing that ever talks to it is the StateNest on your machines.

Once connected, sync happens on its own after anything worth sharing — a
checkpoint, a decision, a next action — with a short pause so a burst of writes
costs one push rather than five. You never type a git command.

Four things it will not do:

- **Wait for the network.** A write records that a sync is wanted and returns.
  Claude Code never starts slowly because GitHub is slow, and never fails to
  start because you are offline.
- **Run twice at once.** Several Claude sessions and a terminal can all be
  writing; exactly one sync runs per profile.
- **Push a credential.** The secret scanner runs before anything leaves the
  machine. A finding pauses sync and tells you where to look, never what it saw.
- **Merge a disagreement.** If two machines changed the same record, StateNest
  keeps both, leaves your local data working, and asks you which to keep:
  `statenest sync repair`.

Everything works without sync, offline, forever.

---

## Why not just use an AI memory tool?

Because they solve a different problem. They remember what was said in a
conversation. StateNest remembers **what is true about your machines and
your repositories right now** — and most of it is re-derived by scanning, not
asserted by a model.

Nothing else joins _project ↔ path ↔ machine ↔ server ↔ progress_. Every tool
in the space owns exactly one of those columns.

See [docs/research/prior-art.md](docs/research/prior-art.md) for the survey
this claim is based on.

---

## Requirements

Node.js 22.12 or newer. Git is optional but strongly recommended — without it,
branches and uncommitted changes cannot be read. Works on macOS, Linux, Windows
and WSL.

## Documentation

|                                                |                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| [User guide](docs/user-guide.md)               | **Start here.** The mental model, what scan really does, the Claude Code lifecycle |
| [Command reference](docs/command-reference.md) | Every command and option                                                           |
| [Getting started](docs/getting-started.md)     | Install, first scan, first checkpoint                                              |
| [Multi-machine](docs/multi-machine.md)         | Two computers, VPSes, sync, and one unified view                                   |
| [Claude Code](docs/claude-code.md)             | Hooks, skills, MCP tools, latency                                                  |
| [Data model](docs/data-model.md)               | Every file and field                                                               |
| [Security model](docs/security-model.md)       | Threat model and its limits                                                        |
| [Sync](docs/architecture/sync.md)              | How multi-machine sync resolves conflicts                                          |
| [Architecture](docs/architecture/overview.md)  | How it fits together                                                               |
| [ADRs](docs/adr/)                              | Why the load-bearing decisions were made                                           |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports about **losing or
mishandling data** get priority over everything else.

## License

MIT — see [LICENSE](LICENSE).
