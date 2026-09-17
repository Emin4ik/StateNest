# Sync

Optional. Off by default. Everything works forever without it, offline.

```bash
pb sync init git@github.com:you/project-brain-data.git   # PRIVATE
pb sync
pb sync status
```

Your data, your repository. There is no Project Brain server.

## What syncs

One **profile directory**, and nothing else:

```
~/.project-brain/profiles/personal/    <- this is the git repository
```

Machine-local and derived state is outside every profile by construction:
`machine.json`, `cache/`, `logs/`, `backups/`. A data repository cloned to a
second machine therefore cannot tell that machine it is the first one.

Because sync operates on one profile directory, a work profile cannot reach a
personal remote. That is containment, not a rule.

## Designed so conflicts are rare

The storage layout exists mostly to make this true.

| Data | Shape | Conflict behaviour |
| --- | --- | --- |
| Checkpoints | One immutable file each, at a timestamped path | **Never conflict.** Two machines write different filenames. |
| Decisions | Append-only, one `##` block each | `merge=union` keeps both sides |
| Machine records | One file per machine | Only one machine writes each |
| Server records | One file per server | Rarely edited from two places at once |
| `project.yaml`, `state.md` | Mutable | **Can conflict.** Small and rarely simultaneous. |

`.gitattributes` is written into every profile:

```
projects/*/decisions.md merge=union
* text=auto eol=lf
```

The `eol=lf` line matters more than it looks: without it, a Windows machine and
a macOS machine syncing the same profile rewrite every file on every commit.

## What `pb sync` does

1. **Audit.** Scan the whole profile for anything that looks like a credential.
   A finding **stops here** — before a commit exists. Once a secret is in git
   history, removing it means rewriting history, and it may already be pushed.
2. **Fetch.** An unreachable remote returns `offline` and changes nothing.
   Network failure is not an error state.
3. **First sync only.** If this machine has local files but no commits and the
   remote has history, adopt the remote history and materialise its files,
   keeping files that exist only here. A plain reset would have presented every
   remote project as a local deletion — and the next commit would have deleted
   them for every machine.
4. **Commit** local changes.
5. **Rebase** onto the remote, keeping history linear. A conflict stops and
   names the files.
6. **Push.**

## When it conflicts

```
Two machines changed the same record.

    projects/prj_t4f8drdzsyxc/project.yaml

Nothing was lost. Resolve the files listed, then run `pb sync` again.
```

Nothing is discarded to make a sync succeed. Resolve it as ordinary git:

```bash
cd ~/.project-brain/profiles/personal
git status
# edit to keep what you want
git rebase --continue
pb sync
```

## Multiple machines

Project ids are derived from the git remote, so a project registered on two
machines merges into **one project with two locations** — no coordination, no
server, no ids handed out.

```bash
# laptop
pb sync init git@github.com:you/project-brain-data.git && pb sync

# workstation
pb sync init git@github.com:you/project-brain-data.git && pb sync
pb where taxi     # now shows both machines
```

## Growth

A checkpoint is roughly 500 bytes. Ten a day for a year is under 2MB of text
that compresses well. If this ever becomes a problem, `pb export` archives old
checkpoints; there is no automatic pruning, because silently deleting a user's
memory is not something a memory tool should do.

## Why git

It is already installed, already authenticated, already backed up, already
versioned, and already understood. A tool whose entire premise is local-first
should not ship a sync server.

The cost is conflict handling, which every git-backed tool gets wrong by either
silently discarding data or dumping raw conflict markers on the user. The
layout above avoids most conflicts entirely, and the rest stop loudly with an
exact recovery command.
