# Security model

StateNest reads your home directory and writes a file tree you may sync to
a git repository. That deserves a precise account of what it does, what it
refuses to do, and where the limits are.

This document states the limits honestly, including the ones that are not
flattering. A tool asking for this much access and claiming no weaknesses
should not be trusted.

---

## What it reads

**Deliberately, during a scan**

- Directory listings under the roots you name
- `.git/config`, `.git/HEAD`, `.git/refs/*` — for the remote, branch and commit
- One manifest per project, capped at 256KB: `package.json`, `pyproject.toml`,
  `Cargo.toml`, `go.mod`, `composer.json`, `pom.xml`
- The first ~60 lines of a `README.md`, for a one-line description

**On demand, for one project**

- `git status`, `git log -1`, `git rev-list` — through `execFile` with an
  argument array, never a shell string

**Never**

- Your source code
- `.env` and every variant of it
- Private keys, `.pem`, `.p12`, keystores, `.netrc`, `.npmrc`,
  `.git-credentials`, `terraform.tfstate`, `*.tfvars`
- Anything under a `.ssh` directory except `config`, and from that file only
  the alias, hostname, user and port
- AI conversation transcripts

The deny-list (`src/discovery/exclusions.ts`) is checked **before a file is
opened**, not after it is read.

## What it stores

Under `~/.statenest`, as YAML and Markdown you can read, grep and edit:

| Stored | Example |
| --- | --- |
| Project names, descriptions, tags | `world-war-rts`, "A real-time strategy game" |
| Paths on each machine | `emin-macbook: ~/Projects/world-war` |
| Repository identity | `github.com/emin/world-war-rts` |
| Branch, commit sha, change counts | `phase-7`, `72ba934`, 8 modified |
| Checkpoints | "Replaced the match timer with unlimited matches" |
| Decisions, tasks, blockers | "Removed the 15-minute limit because…" |
| Server addresses and deploy paths | `taxi-prod`, `/opt/taxi-checker` |

## What it cannot store

Not "does not" — **cannot**. The schemas have no field a credential could
occupy. A server record has `ssh_alias`, `host`, `user`, `port` and nothing
else; there is no `password`, no `identity_file`, no `token`. Adding one would
be a visible, reviewable schema change.

This is checked by a test that reads the generated JSON Schema and asserts no
credential-shaped field exists.

## The three layers of protection

**1. Filename deny-list, before opening.** The cheapest and most reliable
layer. A file whose name matches is never read.

**2. Schema shape.** There is nowhere to put a secret even if one were
obtained.

**3. Content scanning, before writing.** Everything StateNest is about to
persist — checkpoint summaries, decisions, project notes, task text — passes
through `redactSecrets` first. A match is replaced with
`[redacted by StateNest]` and the surrounding prose is kept.

Redaction is right when *writing* (a checkpoint with a token removed is still a
useful checkpoint). **Blocking** is right when *sending*: `statenest sync` runs a full
audit first and refuses to push if anything is found, before creating a commit
— because once a credential is in git history, removing it means rewriting
history, and it may already have been pushed.

## What the scanner detects, and what it misses

**Detected** (high precision): private key blocks, AWS access keys and secret
keys, GitHub tokens (classic and fine-grained), Anthropic, OpenAI, Slack,
Google, Stripe, npm, GitLab and Hugging Face keys, JWTs, connection strings
containing a password, URLs with basic auth, bearer and Authorization headers,
and values assigned to secret-looking names that also pass an entropy check.

**Not detected.** Be clear-eyed about this:

- A credential format the ruleset does not know about
- A secret that looks like ordinary prose — a passphrase, a memorable password
- A secret split across lines or otherwise obfuscated
- An internal hostname or IP you consider sensitive. StateNest stores those
  on purpose; that is the product. Use a separate profile for anything you do
  not want in your synced data.

The ruleset is deliberately small and precise rather than broad. StateNest
scans its own short prose output, not arbitrary source trees, and in that
context a rule that fires on a real token is worth far more than one that cries
wolf on every base64 string until the user learns to ignore it.

**A detector is a safety net, not a guarantee.** It is the third layer, behind
two that do not depend on pattern matching at all.

## Profiles

```
~/.statenest/profiles/personal/   its own git repo, its own remote
~/.statenest/profiles/work/       a different repo, a different remote
```

A work project cannot reach a personal repository because sync operates on one
profile directory and the other profile's files are not inside it. This is a
property of the layout rather than a rule the code has to remember — the
distinction matters, because rules get broken during refactors and directory
containment does not.

Machine-local state — `machine.json`, `cache/`, `logs/` — lives outside every
profile and is never syncable.

## Your source repositories are read-only

StateNest **observes** your repositories. It never runs `git add`,
`git commit`, `git push` or any other write against one. The only repository it
ever writes to is its own data repository, inside `~/.statenest`.

This is enforced in three ways: every git write lives in `src/sync/`, which
asserts its working directory is inside the StateNest home before *every*
invocation; the CLI has no command that writes to a project; and a test
registers a repository, checkpoints it, syncs, and asserts the repository's
HEAD and every file are byte-identical afterwards.

## The Claude Code integration

- Hooks run as your user, with your permissions. They read git state and write
  only inside `~/.statenest`.
- The MCP server is **read-mostly**. Its write tools record memory — a
  checkpoint, a decision, a task, a focus line. There is no tool that runs a
  shell command or connects to anything.
- **Registering a server in StateNest does not give a model a way to reach
  it.** There is no ssh execution tool, by deliberate omission. StateNest
  is a memory and control plane, not an infrastructure executor.
- No model is ever spawned. Rich checkpoints reuse work an agent has already
  done; `PostCompact` uses a summary Claude Code generated anyway.

## The dashboard

Binds to `127.0.0.1` by default and refuses any non-loopback address without an
explicit `--yes-expose-me`, because the page lists every project, machine and
server you have registered.

It is read-only: non-GET methods are rejected with 405. It serves
`default-src 'none'` with no remote scripts, styles or images, and inserts every
value with `textContent` rather than `innerHTML`.

Anything running as your user on your machine can reach a loopback port. Do not
run the dashboard on a shared machine.

## Sync

- Optional. Off by default. Everything works forever without it.
- To a repository **you** own. `statenest sync init` warns, twice, that it must be
  private.
- Audited before every push, blocking on any finding.
- Never destructive: a conflict stops and tells you which files to resolve.
  Nothing is discarded to make a sync succeed.

## Telemetry

There is none, and there is no code in this repository that could send any. The
config key exists solely so it can be `false`, and the schema rejects `true`.

## Threat model

| Threat | Mitigation |
| --- | --- |
| A credential ends up in synced git history | Deny-list, no schema field, redaction on write, blocking audit before commit |
| Work data reaches a personal repository | Profiles are separate directory trees; sync cannot leave one |
| StateNest damages a repository | It never writes to one; asserted per-invocation and tested |
| A model reaches a registered server | No execution tool exists |
| Someone on the network reads the dashboard | Loopback-only unless explicitly overridden |
| A malicious path or branch name injects a command | `execFile` with argument arrays; no shell anywhere |
| A malicious id escapes the data directory | Ids are sanitised before becoming path segments |
| A crash corrupts the registry | Atomic writes; unreadable files are reported, never deleted |
| A hook hangs the coding agent | Every handler has a deadline; the hook always exits 0 |

**Out of scope.** StateNest does not defend against an attacker who already
has write access to your home directory. At that point they have your ssh keys.

## Reporting

See [SECURITY.md](../SECURITY.md). Please report privately, and never include a
real credential.
