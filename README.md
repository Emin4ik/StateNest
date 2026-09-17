# Project Brain

**You have forty projects. You cannot remember where you stopped in any of them.**

Which repo was that? Where did I clone it on this laptop? Which VPS runs it?
What was I halfway through? What did I decide, and why? Which of these have I
not touched in three months?

Git history does not answer these questions. Neither does an AI chat log.

Project Brain does. It is a local-first control plane for your own work: it
remembers your projects, where each one lives on each machine, which servers
they deploy to, what you finished, what is blocked, and what you meant to do
next.

Everything is plain YAML and Markdown in `~/.project-brain`. Nothing is
uploaded. There is no account.

---

## 30 seconds

```console
$ pb recent

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
$ pb resume world-war

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
$ pb where taxi

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

## Install

```bash
npm install -g project-brain
pb init
```

`pb init` asks which directories hold your projects, scans them, and shows you
what it found. It takes about two minutes, and it tells you exactly what it
stores before it writes anything.

```
✓ Project Brain initialised
✓ Machine registered: emin-macbook (macos)
✓ 37 projects discovered
✓ 12 active in the last 30 days
```

### Claude Code

```bash
pb integrate claude
```

Now, when you open Claude Code inside a registered project, it already knows
where you left off — roughly 500 characters of the right context, not a dump
of your history:

```
# Project Brain

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

You also get skills — `/project-brain:resume`, `/project-brain:checkpoint`,
`/project-brain:where` — and MCP tools that Claude uses on its own when you
ask "what was I doing yesterday?".

Project Brain adds about **116ms** to session start and never spawns a model.

---

## Commands

```
pb init                      set up on this machine
pb scan ~/Projects ~/Work    find and register projects
pb projects                  list everything
pb recent                    what you have been working on
pb resume <project>          pick a project back up
pb where <project>           every copy and every deployment
pb show <project>            everything known about one project
pb status                    active, blocked, stale, uncommitted
pb search "refinery"         search your own history
pb checkpoint -m "..."       record what you just did
pb task add "..."            record a next action
pb decision add "..."        record why you chose something
pb remote import-ssh         pick servers from your ~/.ssh/config
pb deploy add <project> ...  record where a project runs
pb doctor                    check everything, with fixes
pb privacy audit             scan your own data for secrets
```

Every command takes `--json`.

---

## What it stores, and what it never stores

Project Brain reads your home directory. It should have to earn that, so here
it is plainly.

**Stores** — project names and descriptions; where each project lives on each
machine; git branch, commit sha and how many files changed; checkpoints you or
your coding agent write; decisions, tasks and blockers; server addresses and
deploy paths.

**Never stores** — your source code. `.env` files or anything inside them. ssh
private keys, passwords or API tokens. Raw AI transcripts. There is no
telemetry, and no code in this repository that could send any.

The filename deny-list is checked *before* a file is opened, and everything
Project Brain is about to write passes through a secret scanner first. Run
`pb privacy audit` whenever you want to check for yourself.

Full detail: [docs/security-model.md](docs/security-model.md).

### Work and personal are separate directories

```
~/.project-brain/profiles/personal/   your own repo, your own remote
~/.project-brain/profiles/work/       a different repo, a different remote
```

A work project cannot sync into a personal repository, because sync operates on
one profile directory and the other profile's files are not inside it. That is
a property of the layout, not a rule the code has to remember.

### Optional sync, to a repository you own

```bash
pb sync init git@github.com:you/project-brain-data.git   # PRIVATE
```

Your data, your repository, your choice. Everything works without it, offline,
forever. Sync refuses to run if the secret scanner finds anything.

---

## Why not just use an AI memory tool?

Because they solve a different problem. They remember what was said in a
conversation. Project Brain remembers **what is true about your machines and
your repositories right now** — and most of it is re-derived by scanning, not
asserted by a model.

Nothing else joins *project ↔ path ↔ machine ↔ server ↔ progress*. Every tool
in the space owns exactly one of those columns.

See [docs/research/prior-art.md](docs/research/prior-art.md) for the survey
this claim is based on.

---

## Requirements

Node.js 22.12 or newer. Git is optional but strongly recommended — without it,
branches and uncommitted changes cannot be read. Works on macOS, Linux, Windows
and WSL.

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, first scan, first checkpoint |
| [Claude Code](docs/claude-code.md) | Hooks, skills, MCP tools, latency |
| [Data model](docs/data-model.md) | Every file and field |
| [Security model](docs/security-model.md) | Threat model and its limits |
| [Sync](docs/architecture/sync.md) | How multi-machine sync resolves conflicts |
| [Architecture](docs/architecture/overview.md) | How it fits together |
| [ADRs](docs/adr/) | Why the load-bearing decisions were made |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports about **losing or
mishandling data** get priority over everything else.

## License

MIT — see [LICENSE](LICENSE).
