# StateNest user guide

For the complete list of commands and options, see the
[command reference](command-reference.md).

---

## 1. The mental model

StateNest is a **local-first control plane for your own work**. It is a memory
of what you are doing across every project, machine and server you have — kept
in plain files on your computer.

It is not a note-taking app, not a task manager, and not a chat-history
archive. The one question it exists to answer is *"what was I doing, where, and
what did I decide?"* — weeks later, on whichever machine you happen to be at.

### What it connects

```
                    ┌──────────────────────────┐
                    │        PROJECT           │
                    │  the thing you work on   │
                    └────────────┬─────────────┘
                                 │
      identity comes from ───────┤
      the git remote             │
                                 │
   ┌──────────────┬──────────────┼──────────────┬──────────────┐
   │              │              │              │              │
┌──┴───┐   ┌──────┴─────┐  ┌─────┴──────┐  ┌────┴─────┐  ┌─────┴──────┐
│ local│   │  machine   │  │ checkpoints│  │  remote  │  │   coding   │
│ path │   │            │  │   tasks    │  │  server  │  │   agent    │
│      │   │ laptop /   │  │  decisions │  │ + deploy │  │  context   │
│      │   │ workstation│  │  blockers  │  │   path   │  │            │
└──────┘   └────────────┘  └────────────┘  └──────────┘  └────────────┘
```

Read that as one sentence: **a project has an identity derived from its git
remote; it exists at one or more local paths, each on a machine; it accumulates
checkpoints, tasks and decisions; it may deploy to a server; and all of that is
what gets handed to your coding agent when you start a session.**

### Why identity comes from the git remote

A project's id is a hash of its **normalised git remote**. So
`git@github.com:acme/api.git` and `https://github.com/acme/api` are the same
project — and the same repository cloned on your laptop at `~/code/api` and on
your workstation at `D:\work\api` is **one** StateNest project with two
locations, not two unrelated entries.

This is why StateNest can tell you "you also have this on the workstation, on a
different branch".

A repository with **no remote** gets a random id instead. It still works, but it
cannot merge with a copy elsewhere, because there is nothing to match on.

### What StateNest never stores

- **Your source code.** It reads a handful of manifest files and a README for a
  description. It does not index, copy or upload your code.
- **`.env` files or anything inside them.** The filename is checked *before* the
  file is opened.
- **SSH keys, passwords, API tokens.**
- **Raw Claude Code transcripts.** Ever.

Everything StateNest writes is scanned for credential shapes first, and
everything it reads back is scanned again — so a secret that was stored before
a detection pattern existed still cannot reach your agent's context. Check for
yourself with `statenest privacy audit`.

Nothing leaves your machine unless you explicitly set up git sync to a private
repository you own.

---

## 2. First installation

```bash
npm install -g statenest      # requires Node.js 22.12 or newer
statenest --version
statenest init
statenest doctor
statenest integrate claude    # optional, if you use Claude Code
```

`statenest init` tells you exactly what it stores *before* it writes anything,
registers this machine, and offers to scan for projects.

### Which commands care where you are

| Run from anywhere | Usually run inside a project |
| --- | --- |
| `init`, `doctor`, `projects`, `recent`, `status`, `search` | `checkpoint` |
| `resume <project>`, `show <project>`, `where <project>` | `add .` |
| `scan <dir>`, `machine`, `remote`, `profile`, `sync` | `task add`, `decision add` |
| `integrate`, `privacy`, `dashboard`, `export`, `import` | `scan .` |

Commands that act on "the current project" work out which one you mean from your
working directory. `task`, `decision` and `checkpoint` all accept
`-p <project>` if you would rather say it explicitly.

---

## 3. Finding your projects

### The three ways in

```bash
statenest add .                 # register exactly this directory
statenest scan ~/Projects       # walk that tree and register what it finds
statenest scan .                # walk the current directory
```

`add` registers **one** directory you name. `scan` **walks a tree** and
registers everything that looks like a project. `scan .` is just `scan` pointed
at where you are — it is not special.

### How `scan` actually works

This matters, because it is easy to assume it does more than it does.

1. **It looks for git repositories.** A directory containing `.git` is a
   candidate. That is the default rule.
2. **It descends recursively**, breadth-first, to a maximum depth of **8** by
   default (`--depth <n>` to change it, or `discovery.max_depth` in your
   config).
3. **It stops descending once it finds a repository root.** A repository inside a
   repository — a vendored dependency, a submodule — is *not* registered unless
   you pass `--nested`. This is deliberate: most nested repositories are
   somebody else's code.
4. **`--include-non-git` widens the net** to directories that merely look like
   projects — ones carrying a `package.json`, `Cargo.toml` and so on — even
   without git.
5. **Noise is pruned hard.** 78 directory names are never entered
   (`node_modules`, `vendor`, `.venv`, `target`, `dist`, `Pods`, `.gradle`, …),
   along with 11 home-relative directories (`Library`, `Applications`,
   `Dropbox`, `OneDrive`, …) and 11 system paths (`/proc`, `/System`,
   `C:/Windows`, …).
6. **It does not read your source files.** Not one.

> `statenest scan` reads directory entries and a few small metadata files. It
> does not analyse your code, and it does not read Claude Code history.

### Where a project's name and description come from

In order, first hit wins:

1. **A project manifest**, if one is present at the root — `package.json`,
   `deno.json`, `pyproject.toml`, `Cargo.toml`, `composer.json`, `go.mod`,
   `setup.py`, `requirements.txt`, `Pipfile`, `Gemfile`, `pom.xml`,
   `build.gradle(.kts)`, `Package.swift`, `CMakeLists.txt`. This also
   establishes the project's ecosystem type.
2. **The README**, for a description — the first real sentence, skipping the
   title and badges.
3. **The directory name**, as a fallback.

The git remote supplies the identity, the owner and the web URL.

### Two projects can have the same name

That is normal — a `threads` at work and a `threads` at home. StateNest keeps
them separate because their **remotes** differ, and it never merges projects by
name. When names collide, listings and errors qualify them:

```
PROJECT                         STATUS  LAST ACTIVE
threads (work-org/threads)      active  2h ago
threads (personal-org/threads)  paused  3 weeks ago
```

and you can address either one by its repository path (`work-org/threads`) or
its id.

---

## 4. Everyday commands

The full reference is in [command-reference.md](command-reference.md). These are
the ones you will actually use.

```bash
statenest recent                # what have I been doing?
statenest resume <project>      # pick this back up
statenest projects              # everything I know about
statenest where <project>       # where does this live and deploy?
statenest search "refinery"     # find that thing I wrote down
statenest checkpoint -m "..."   # record what I just did
```

`resume` is the one to learn first. It gives you, in one screen: the last
session's summary, open blockers, the next actions, which branch you are on,
how many files are uncommitted, and where else the project exists.

Add `--full` to read the actual text of recent checkpoints rather than a
summary.

---

## 5. Claude Code integration

### What it is — and what it is not

`statenest integrate claude` installs a **Claude Code plugin**, globally. From
then on, Claude Code calls StateNest at five points in a session's life.

> **`statenest scan` does not read Claude Code history.** It never has and it
> never will. Scanning finds git repositories on disk. Everything StateNest
> knows about your *sessions* comes from the plugin, from the moment you
> installed it onwards.

### The session lifecycle

| Hook | What StateNest does |
| --- | --- |
| **SessionStart** | Works out the project from your working directory and its repository identity, then injects a compact resume brief — roughly 600 characters of what you were doing, what is blocked and what is next. |
| **Stop** | Records session activity and turn count, and associates the running session with a registered project where it can. |
| **PreCompact** | Captures git metadata — branch, commit, dirty state — just before context is compacted. |
| **PostCompact** | Reuses the compact summary Claude Code has **already generated** to write a semantic checkpoint. No second model is invoked. |
| **SessionEnd** | Writes a metadata checkpoint if the session did meaningful work and no checkpoint was written already. |

### Four things to understand

1. **StateNest never spawns a model.** Not at session start, not at compaction,
   not ever. The PostCompact summary is one Claude Code produced anyway.
2. **No raw transcripts are stored.** A checkpoint is a short summary, not a log.
3. **It cannot reconstruct the past.** Conversations that happened before you
   registered a project — or before you installed the integration — are not
   recoverable. StateNest starts remembering when you start it.
4. **A rich checkpoint comes from PostCompact or from you.** SessionEnd alone
   may only preserve metadata: branch, commit, that work happened. If a short,
   important session never compacted, run `/statenest:checkpoint` before you
   finish — otherwise the *meaning* of that session is lost even though the
   metadata is kept.

### The skills

Inside Claude Code you get seven:

```
/statenest:resume      pick a project back up
/statenest:checkpoint  record what you just did
/statenest:where       find a project's copies and servers
/statenest:recent      what you have been working on
/statenest:projects    list your projects
/statenest:status      the overview
/statenest:doctor      check the installation
```

### `statenest resume GAME` vs `/statenest:resume GAME`

They are not the same thing, and the difference matters:

- **`statenest resume GAME`** — run in your terminal. Prints the context **for
  you** to read. Claude does not see it.
- **`/statenest:resume GAME`** — run inside Claude Code. Puts the context **into
  Claude's working memory** so it can act on it. You see it too, but the point
  is that Claude now knows.

### The normal workflow is simpler than either

Most of the time you do not need to run anything:

```bash
cd ~/Projects/example
claude
```

SessionStart injects the brief automatically for any registered project. The
skills are for when you want something specific — a different project, a
checkpoint right now, a deployment lookup mid-conversation.

---

## 6. A real workflow

**The first time:**

```bash
statenest init
statenest scan ~/Projects
statenest projects
```

**Starting work:**

```bash
cd ~/Projects/example
claude                          # context arrives automatically
```

**During or after something important:**

```
/statenest:checkpoint
```

Especially if the session was short and never compacted.

**Coming back weeks later:**

```bash
statenest recent                # what was I doing, across everything?
statenest resume example        # the detail on this one
```

**Finding where something runs:**

```bash
statenest where example
```

---

## 7. What StateNest actually knows

Three different kinds of knowledge, with three different levels of confidence.
Keeping them apart is the point of this section.

### 1. Facts it derives automatically

Re-read from disk, never guessed:

- repository identity, owner and web URL, from the git remote
- the local path, and which machine it is on
- current branch and HEAD commit
- how many files are uncommitted
- last git activity time
- ecosystem type, name and description from manifests and README

These are **cheap and always current**. `resume` re-reads them live.

### 2. Memory captured while a coding agent worked

Only exists if the Claude Code integration is installed, and only from that
point forward:

- session activity and turn counts
- compact summaries, turned into checkpoints at PostCompact
- automatic metadata checkpoints at SessionEnd

This is **partial by nature**. A session that never compacted and never got an
explicit checkpoint leaves metadata, not meaning.

### 3. Memory you or your agent wrote down deliberately

The most valuable and the only kind StateNest cannot produce on its own:

- checkpoint narratives — what you did, what you decided, what is next
- tasks, with state: todo, in progress, blocked, done, cancelled
- decisions, with the reasoning and the alternatives rejected
- blockers
- deployments: which server, which path, which service

### The thing to take away

`statenest scan` gives you category 1 and nothing else. It does **not**
understand your codebase, and it does **not** know about any conversation you
had before you installed it. Categories 2 and 3 accumulate from the day you
start using StateNest. That is why a checkpoint at the end of a hard session is
worth thirty seconds.

---

## Where to go next

| | |
| --- | --- |
| [Command reference](command-reference.md) | Every command and option |
| [Getting started](getting-started.md) | The short version |
| [Claude Code](claude-code.md) | Hooks, skills, MCP tools, latency |
| [Data model](data-model.md) | Every file and field on disk |
| [Security model](security-model.md) | Threat model and its limits |
| [Troubleshooting](troubleshooting.md) | When something is wrong |
