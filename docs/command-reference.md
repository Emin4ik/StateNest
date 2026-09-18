# StateNest command reference

Every command StateNest implements. For the mental model and how the
pieces fit together, read the [user guide](user-guide.md) first.

Anything here can be checked with `statenest <command> --help`.

---

## Global options

Valid on any command:

| Option             | What it does                                             |
| ------------------ | -------------------------------------------------------- |
| `-v, --version`    | Print the version                                        |
| `--home <dir>`     | Use a different StateNest home instead of `~/.statenest` |
| `--profile <name>` | Act on a specific profile for this one command           |
| `--json`           | Machine-readable output. Every command supports it       |
| `-q, --quiet`      | Suppress warnings                                        |
| `--no-color`       | Disable coloured output                                  |
| `-h, --help`       | Help for any command or subcommand                       |

```bash
statenest --profile work projects
statenest projects --json | jq '.projects[].name'
```

---

## Setup and health

### `statenest setup` (also `statenest init`)

Set up StateNest on this machine. Run once. Explains what it stores before
writing anything, registers the machine, optionally scans for projects,
optionally installs the Claude Code integration, and optionally connects sync to
a private git repository you own.

`setup` and `init` are the same command under two names — `setup` is what you
want on a new machine, `init` is what older documentation and scripts call it.

| Option                  |                                        |
| ----------------------- | -------------------------------------- |
| `-y, --yes`             | Accept every default, ask nothing      |
| `--machine-name <name>` | What to call this computer             |
| `--roots <dirs...>`     | Directories that contain your projects |
| `--no-scan`             | Set up without scanning                |
| `--no-claude`           | Skip the Claude Code integration offer |
| `--no-sync`             | Skip the sync offer                    |

**On a second machine**, this is all you need: give it the same private
repository and it joins the existing profile, receives everything already there,
and keeps its own machine-local settings. You do not have to sync before you
scan, or know anything about how the histories meet.

### `statenest doctor`

Check everything and say exactly how to fix anything broken: Node version,
StateNest version, git, data directory, permissions, profiles, schema version,
project and checkpoint counts, missing local paths, file integrity, sync state
and the Claude Code integration.

| Option     |                                |
| ---------- | ------------------------------ |
| `--repair` | Attempt safe automatic repairs |

**When:** first thing whenever something seems wrong.

---

## Seeing your work

### `statenest recent`

What you have been working on, newest first, across every project.

| Option            |                               |
| ----------------- | ----------------------------- |
| `-n, --limit <n>` | How many entries (default 15) |
| `--days <n>`      | Only the last N days          |
| `--all`           | Include archived projects     |

**When:** the Monday-morning question — _what was I doing?_

### `statenest projects` (alias `ls`)

List every project StateNest knows about.

| Option                                 |                                                     |
| -------------------------------------- | --------------------------------------------------- |
| `--active` / `--paused` / `--archived` | Filter by status                                    |
| `--stale [days]`                       | Untouched for this many days (default 30)           |
| `--dirty`                              | Only projects with uncommitted changes              |
| `--deployed`                           | Only projects with a registered deployment          |
| `--tag <tag>`                          | Only projects carrying this tag                     |
| `--type <type>`                        | Only this ecosystem (`node`, `python`, `rust`, …)   |
| `--all`                                | Include archived (excluded by default)              |
| `--sort <field>`                       | `name`, `activity` or `status` (default `activity`) |

Projects whose display names collide are qualified by repository path, so two
unrelated `threads` are distinguishable.

### `statenest resume <project>`

Everything you need to pick a project back up: the last session's summary, open
blockers, next actions, current branch and commit, uncommitted file count, and
every other place the project exists.

| Option              |                                             |
| ------------------- | ------------------------------------------- |
| `--full`            | Include the full text of recent checkpoints |
| `--checkpoints <n>` | How many checkpoints to read (default 5)    |
| `--no-refresh`      | Skip re-reading live git state (faster)     |

**When:** returning to anything after more than a day.

### `statenest show <project>`

Everything StateNest knows about one project, as a record: metadata, locations,
repository, deployments, tasks, decisions, blockers.

**When:** `resume` tells you what to do next; `show` tells you everything.

### `statenest where <project>`

Every place a project exists — machines, local paths, and its deployments with
server, path, service and URL.

| Option        |                                          |
| ------------- | ---------------------------------------- |
| `--path-only` | Print just the local path, for shell use |

```bash
cd "$(statenest where example --path-only)"
```

### `statenest status`

An overview of everything at once: active, blocked, stale and uncommitted.

| Option             |                                      |
| ------------------ | ------------------------------------ |
| `--stale-days <n>` | How old counts as stale (default 30) |

### `statenest search <query...>`

Search across projects, checkpoints, decisions, tasks and servers. Lexical — it
finds words you actually wrote.

| Option             |                                                                  |
| ------------------ | ---------------------------------------------------------------- |
| `-n, --limit <n>`  | Maximum results (default 20)                                     |
| `--project <name>` | Restrict to one project                                          |
| `--scope <scope>`  | `project`, `state`, `checkpoint`, `decision`, `task` or `remote` |

---

## Registering projects

### `statenest add [path]`

Register one directory as a project. Defaults to the current directory.

| Option          |                                                          |
| --------------- | -------------------------------------------------------- |
| `--name <name>` | Display name (defaults to the repository or folder name) |
| `--tag <tag>`   | Tag it (repeatable)                                      |
| `--no-detect`   | Skip reading manifests and README for a description      |

### `statenest scan [roots...]`

Walk one or more directories and register the git repositories under them. A
repository is recognised by its `.git` marker — a directory in an ordinary
clone, a file in a linked worktree or submodule. See
[how scan works](user-guide.md#how-scan-actually-works) — it does not read your
source code, and it does not read Claude Code history.

| Option              |                                                         |
| ------------------- | ------------------------------------------------------- |
| `--depth <n>`       | How deep to descend (default 8)                         |
| `--dry-run`         | Show what would be registered, change nothing           |
| `--include-non-git` | Also register project-looking directories without git   |
| `--nested`          | Keep descending inside repositories to find nested ones |
| `--save-roots`      | Remember these directories as the profile's scan roots  |

**Always try `--dry-run` first** on an unfamiliar tree.

### `statenest remove <project>` (alias `rm`)

Forget a project. Its checkpoints are kept unless you say otherwise.

| Option           |                                         |
| ---------------- | --------------------------------------- |
| `--with-history` | Also delete its checkpoints permanently |
| `-y, --yes`      | Do not ask for confirmation             |

---

## Recording what happened

### `statenest checkpoint [project]`

Record what you just accomplished. Defaults to the project you are standing in.

| Option                 |                                               |
| ---------------------- | --------------------------------------------- |
| `-m, --message <text>` | One-line summary of what changed              |
| `--did <item>`         | Something completed (repeatable)              |
| `--next <item>`        | Something still to do (repeatable)            |
| `--blocked <item>`     | Something blocking progress (repeatable)      |
| `--decided <item>`     | A decision made (repeatable)                  |
| `--tag <tag>`          | Tag the checkpoint (repeatable)               |
| `--force`              | Write even if nothing appears to have changed |

```bash
statenest checkpoint -m "Replaced the greedy allocator." \
  --did "cost-based allocation" \
  --next "re-run the winter fixtures" \
  --blocked "waiting on the upstream tide feed"
```

Checkpoints are immutable and append-only — one Markdown file each.

### Tasks

```bash
statenest task add "re-run the winter fixtures"
statenest task list
statenest task start <id>
statenest task block <id> -r "waiting on upstream"
statenest task done <id>
statenest task cancel <id>
```

All accept `-p, --project <name>`, defaulting to the current directory.
`task add` also takes `--tag`; `task list` takes `--all` to include completed and
cancelled; `task block` takes `-r, --reason <text>`.

### Decisions

```bash
statenest decision add "Use cost-based berth allocation" \
  -r "greedy starved small vessels" \
  --instead "round-robin" --instead "keep greedy"
statenest decision list
```

`decision add` takes `-p`, `-r, --reason`, `--instead` (repeatable) and `--tag`.
`decision list` takes `-p` and `-n, --limit` (default 20).

**When:** the moment you would otherwise write "why did we do it this way?" in a
commit message nobody will find.

---

## Machines

```bash
statenest machine list       # every computer this profile has been used from
statenest machine current    # this one
statenest machine rename <name>
```

---

## Servers and deployments

A **remote** is a server. A **deployment** connects a project to one.

```bash
statenest remote list
statenest remote add harbour-prod --host harbour.example.com --user deploy --env production
statenest remote import-ssh
statenest remote remove harbour-prod
```

`remote add` options: `--ssh-alias`, `--host`, `--user`, `--port`, `--env`
(`production` | `staging` | `development` | `testing` | `other`), `--type`
(`vps` | `dedicated` | `cloud-instance` | `container-host` | …), `--provider`,
`--notes`.

`remote import-ssh` picks servers from your `~/.ssh/config`, asking before it
registers anything. Options: `--file <path>`, `--include-includes`, `-y, --yes`.

```bash
statenest deploy add harbourmaster --remote harbour-prod \
  --env production --path /srv/harbourmaster --service harbour.service
statenest deploy remove harbourmaster --remote harbour-prod
```

`deploy add` options: `--remote`, `--env`, `--path`, `--branch`, `--service`,
`--url`, `--notes`. `deploy remove` options: `--remote`, `--env`.

**Addresses only — never credentials.** StateNest stores where a thing is, not
how to log in to it.

---

## Profiles

Separate sets of projects — personal, work, a client — each with its own sync
remote. A work project cannot leak into a personal sync repository, because
they are different directories.

```bash
statenest profile list
statenest profile create work --roots ~/Work
statenest profile use work          # change the default
statenest profile show              # the active one
statenest --profile work projects   # one command, other profile
```

---

## Claude Code integration

```bash
statenest integrate claude            # install, or update after upgrading StateNest
statenest integrate claude --repair   # reinstall over an existing install
statenest integrate status            # is it installed and enabled?
statenest integrate remove claude     # remove it; your data is untouched
```

**Run `integrate claude` after upgrading StateNest.** Claude Code installs a
_copy_ of the plugin, so a new npm version does not reach it on its own. The
copy keeps working — its hooks, MCP server and skills all moved together, so it
is old rather than broken — but it stays on the previous version until you say
otherwise. `integrate claude` notices the difference and updates it;
`statenest doctor` reports which version Claude Code is actually running.

`integrate claude` takes `-y, --yes`. `integrate remove` takes `--purge` to also
remove the registered marketplace entry, and the agent name is optional.

See [the lifecycle](user-guide.md#the-session-lifecycle) for what the plugin
does at each point in a session.

---

## Privacy

```bash
statenest privacy audit     # scan your own stored data for credentials
statenest privacy policy    # what is stored and what is never stored
```

`privacy audit` takes `--all-profiles`.

**When:** before enabling sync, and any time you want to check for yourself
rather than take the README's word for it.

---

## Sync (optional)

Mirror one profile to a **private** git repository you own. Off by default;
everything works offline without it.

```bash
statenest sync init git@github.com:you/statenest-data.git
statenest sync            # send and receive now
statenest sync status     # is everything up to date?
statenest sync repair     # choose a side when two machines disagree
```

`sync init` takes `--branch <branch>` (default `main`) and `-y, --yes`.
`statenest sync` is shorthand for `statenest sync run`, which takes
`-m, --message <text>` and `--no-push`. `sync status` takes `--verbose` to show
the underlying git state. `sync repair` takes `-y, --yes` to keep this machine's
version of everything.

**You do not normally need any of these.** Once sync is connected it runs by
itself after anything worth sharing. These are for when you want to look, or to
send something immediately.

Every sync scans for credentials first and refuses to push if it finds any.
Conflicts are surfaced, never auto-merged: StateNest keeps both versions, leaves
your local data usable, and `sync repair` asks which to keep.

---

## Dashboard

```bash
statenest dashboard --open
```

A local, read-only web view of your projects, machines and servers.

| Option              |                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| `-p, --port <port>` | Port to serve on                                                                 |
| `--host <host>`     | Address to bind to (loopback only unless forced)                                 |
| `--yes-expose-me`   | Allow binding to a non-loopback address                                          |
| `--open`            | Open it in your browser                                                          |
| `--all-profiles`    | Show every profile in one **read-only** view, each row labelled with its profile |

`--all-profiles` is a display-only join: profiles keep separate directories and
separate sync remotes, nothing is copied between them, and the dashboard has no
endpoint that writes. See [multi-machine.md](multi-machine.md).

Binds to `127.0.0.1` by default. `--yes-expose-me` is named that way on purpose.

---

## Backup and maintenance

```bash
statenest export backup.tgz     # back up everything to one file
statenest import backup.tgz     # restore
statenest migrate               # bring stored records to the current schema
statenest uninstall             # remove integrations; keeps your data
```

| Command     | Options                                                  |
| ----------- | -------------------------------------------------------- |
| `export`    | `--profile-only`, `--skip-audit` (not recommended)       |
| `import`    | `--force`, `-y, --yes`                                   |
| `migrate`   | `--dry-run`, `-y, --yes`, `--all-profiles`               |
| `uninstall` | `--integrations-only`, `--all` (asks first), `-y, --yes` |

`export` excludes machine-local state, so a backup restores cleanly onto a
different computer. `migrate` backs up before it writes. `uninstall -y` never
implies `--all` — your data is not deleted unless you ask twice.
