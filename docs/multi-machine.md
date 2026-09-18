# Two computers, several servers, one view

Every step and every outcome below was tested against real git repositories and
a real bare remote — see `tests/integration/multi-machine.test.ts` and
`tests/integration/unified-view.test.ts`. Where something is untested or
unsupported, this page says so rather than guessing.

---

## Two models, both supported

There is no single right answer here. **Your privacy requirement decides**, and
the two models cost different things.

### Model A — one shared profile

Every machine uses the **same profile name** and syncs to the **same** private
repository.

```
Home MacBook ─┐
              │
Work laptop ──┼──  profile "personal"  ──▶  PRIVATE statenest-data repo
              │
Dev machine ──┘

VPSes: remotes + deployments in that same profile.
```

**You get:** one complete registry. `statenest projects` lists everything you
own after a sync, `statenest recent` covers all of it, `statenest machine list`
shows every participating machine, `statenest where <project>` shows each
machine's path plus deployments — and plain `statenest dashboard --open` is all
you need. It is the simplest thing to hold in your head.

**You give up:** the structural boundary. Personal and work metadata live in one
private repository, and any machine that syncs it receives all of it. If that is
what you want, this is a completely valid architecture — not a compromise.

### Model B — separate profiles

```
personal  ──▶  private repo A
work      ──▶  private repo B

statenest dashboard --all-profiles --open   # read-only view of both
```

**You get:** isolation that is structural rather than a rule anyone has to
remember. Sync operates on one profile directory, so a work project cannot reach
the personal repository — its files are not inside it.

**You give up:** simplicity. CLI commands stay profile-scoped (`statenest
--profile work projects`), and there is more to set up.

### What makes either safe

1. **A profile is a directory.** Sync operates on one profile directory, so
   profiles cannot bleed into one another's repositories.
2. **The dashboard has no verbs.** Every method except `GET` and `HEAD` is
   refused with 405, so the unified view cannot write anywhere at all.

### About the name

The profile name carries no meaning to StateNest. `personal`, `main`, `default`,
your own name — it is a label. What matters for sharing a dataset is that the
participating machines use **the same profile name and the same sync
repository**.

If you already have real history in a profile called `personal`, keep it.
StateNest has no profile rename and no profile merge, so a prettier name would
cost you your checkpoints, tasks and decisions. That is a bad trade.

---

## The short version

```bash
# On each computer
npm install -g statenest
statenest setup        # give both the same private repository
```

That is the supported path, and it handles the ordering for you. The numbered
walkthrough below does the same thing one step at a time, for when you want to
see exactly what happens or are adding sync to machines you already set up.

---

## 1. First computer

```bash
npm install -g statenest
statenest setup
statenest projects
```

`setup` offers to connect sync. If you skip it there, sections 2 and 3 do it by
hand.

## 2. Choose the private sync repository

Create an **empty, private** repository on GitHub, GitLab or anywhere you can
push to. It will contain your project names, notes, server addresses and deploy
paths. None of that belongs in a public repository.

You do not need to add a README or a licence — an empty repository is the
easiest case, and the one below is written for it.

## 3. First sync, from the first computer

```bash
statenest sync init git@github.com:you/statenest-data.git
statenest privacy audit          # optional; sync runs this itself and refuses on a finding
statenest sync
```

**Tested outcome:** `synced`. The profile is pushed; nothing local is altered.

## 4. Second computer

```bash
npm install -g statenest
statenest setup        # same private repository as the first computer
```

`setup` joins the existing profile and receives everything already in it, in the
right order, without you having to think about it. The rest of this section is
what it is doing on your behalf.

Use the **same profile name** as the first computer. `personal` is the default
on both, so if you never changed it there is nothing to do. If you did:

```bash
statenest profile list          # what exists here
statenest profile create main   # only if that name does not exist yet
statenest profile use main
```

The second machine gets its **own machine id**. That is what lets one project
show up as being in two places.

## 5. First sync on the second computer

```bash
statenest sync init git@github.com:you/statenest-data.git
statenest sync
```

**Tested outcome:** `synced`. The second machine has local files (its own
profile, its own machine record) but no commits, so it cannot fast-forward onto
a repository that has history. StateNest adopts the remote history and then
materialises the remote files, leaving files that exist only here alone.

A plain reset would have presented every remote project as a local deletion, and
the next push would have deleted them for **every** machine. This case is
covered by a test precisely because it is the one that could destroy the other
machine's data.

Check it worked:

```bash
statenest projects       # the first computer's projects
statenest machine list   # both computers
```

> **Sync before you scan on a new machine.** Both orders work — StateNest
> merges a populated local profile with a populated remote, and that case is
> tested. But syncing first means this machine already knows the project
> identities and history before it registers anything, so its local checkouts
> attach to the projects that exist instead of arriving as a separate set to be
> reconciled. It is the sequence with the fewest moving parts, not the only
> safe one.

## 6. Scan the repositories that live on this computer

```bash
statenest scan ~/code --save-roots
```

`--save-roots` remembers these directories on this machine's profile, so later
scans need no arguments.

If a repository here is a clone of one the other machine already knows, its
identity comes from the same git remote, so StateNest links it as **another
location of the same project** rather than creating a second entry — even though
the local path is different.

**Tested outcome:** one project id, two `local_locations`, two machine ids. No
duplicated checkpoints, tasks or decisions.

## 7. Sync both ways

```bash
# on the second computer
statenest sync

# on the first computer
statenest sync
```

Now `statenest where <project>` on either machine shows both checkouts.

### What the lists show once machines share a profile

**`statenest projects` lists every project in the profile — including projects
whose source code is not on this machine.**

```
PROJECT    STATUS  LAST ACTIVE  WHERE
GAME       active  2h ago       local
StateNest  active  1d ago       local
SCADA      active  3h ago       work-laptop
XDR        active  2d ago       work-laptop
```

On the MacBook, `SCADA` and `XDR` are listed with the machine that has them. The
MacBook knows they exist, what they are for, what is next — and does not have
their code.

**Sync moves StateNest's metadata and memory. It does not move your source
code.** Nothing clones a repository for you, and nothing is checked out.

To ask _which machines have this, and where does it run_:

```bash
statenest where SCADA
```

```
SCADA
  Local
    work-laptop
      C:\Projects\SCADA  (main)
      last seen 3h ago
  Deployed
    production
      ssh alias   scada-prod
      path        /srv/scada
```

`statenest machine list` shows every machine participating in the profile, with
`*` marking the one you are on. If two machines end up with the same display
name — easily done, since both are derived from the hostname — run
`statenest machine rename <name>` on one of them. The ids differ regardless, so
nothing is confused; the listing is just easier to read.

## 8. Register VPSes and deployments

**Do not install StateNest on a production server** to make its deployments
visible. A server is a _record_, not a participant:

```bash
statenest remote add prod-1 --host prod-1.example.com --user deploy --env production
statenest deploy add api --remote prod-1 --path /srv/api --service api.service
```

Or import from your ssh config, choosing what to register:

```bash
statenest remote import-ssh
```

Addresses only — never credentials. See [VPSes](#vpses-two-models) below for
when installing StateNest on a host is actually worth it.

## 9. See everything

```bash
statenest dashboard --open                  # the active profile
statenest dashboard --all-profiles --open   # personal and work together
```

The unified view is **read-only aggregation**. Every project card carries its
profile, servers stay attached to the profile that registered them, and the same
project id in two profiles is answered from the profile you asked for.

The CLI (`projects`, `recent`, `status`) is still deliberately one profile at a
time — see [Why not `projects --all-profiles`](#why-the-cli-stays-single-profile).

## 10. Conflict recovery

If two machines changed the **same** record, sync stops and says so:

```
Two machines changed the same record. Nothing was lost - resolve the files
listed, then run `statenest sync` again.
```

**Tested outcome:** `conflict`. Both versions are present in the conflicted file
with ordinary git markers. Nothing was chosen for you.

```bash
cd ~/.statenest/profiles/personal
git status                                  # the conflicted files
$EDITOR <file>                              # keep what you want
git add <file>
git rebase --continue
statenest sync
```

If you would rather start that resolution over:

```bash
git rebase --abort      # back to before the sync; your local data is intact
```

### If `profile.yaml` ever conflicts

It should not. Up to and including **v0.1.1 it did**, routinely: every machine
wrote `last_sync_at` into the shared `profile.yaml` after each sync, so two
machines manufactured a conflict in it even when nothing they cared about
disagreed. That is fixed — machine-local state now lives outside the profile
directory, where sync cannot reach it.

If you do hit one (because two machines genuinely edited the same profile
setting — a description, a privacy level), it is still just a file:

```bash
$EDITOR ~/.statenest/profiles/personal/profile.yaml   # delete the <<<< ==== >>>> lines
git -C ~/.statenest/profiles/personal add profile.yaml
git -C ~/.statenest/profiles/personal rebase --continue
statenest sync
```

While that conflict is unresolved, StateNest cannot read the profile, and every
command says so — naming the file, the conflict and both ways out. **Do not
create a replacement profile and do not delete `~/.statenest`.** Your projects
and checkpoints are untouched throughout; only this one file is unreadable, and
both versions of it are still in git.

### What is machine-local, and what is shared

| Lives in the synced profile             | Lives on this machine only    |
| --------------------------------------- | ----------------------------- |
| profile name, description               | when this machine last synced |
| privacy level                           | this machine's scan roots     |
| sync remote and branch                  | this machine's id             |
| projects, checkpoints, tasks, decisions | caches and logs               |
| machines and servers                    |                               |

Machine-local state is `~/.statenest/local/<profile>.json`, deliberately outside
`profiles/` so that sync cannot carry it anywhere. Your Mac scanning
`~/Documents` and your Linux box scanning `~/code` is normal, and neither
overwrites the other.

A successful `statenest sync` leaves the profile repository clean —
`statenest sync status` should say `local  clean` immediately afterwards. If it
says `uncommitted changes` right after a successful sync, something wrote to the
profile directory that should not have; that is worth reporting.

---

## What happens in the awkward cases

Every row below was tested.

| Situation                                       | What StateNest does                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Remote empty, local populated                   | Commits and pushes. `synced`                                                                                              |
| Remote populated, local empty                   | Adopts the remote history, then materialises it. `synced`. The next push does **not** delete the other machine's projects |
| **Both** already populated, with different data | Rebases. Both sides survive. `synced`                                                                                     |
| Two machines change **different** records       | Both changes kept. `synced`                                                                                               |
| Two machines change the **same** record         | `conflict`. Both versions left in the file with markers. Nothing lost, nothing silently chosen                            |
| Machine offline                                 | `offline`. Local data untouched, every local command keeps working. Recovers on the next sync                             |
| A credential is found                           | `blocked-by-secrets`. Nothing is committed and nothing is pushed                                                          |
| Interrupted rebase                              | Reported, never reported as `synced`. Local data stays readable                                                           |
| Same repository, two machines, different paths  | One project, two locations                                                                                                |
| Same repository twice on **one** machine        | One project, two locations, both on that machine                                                                          |

**Strategy:** rebase, so history stays linear across machines. Checkpoints are
immutable one-file-each, so there is rarely anything to resolve; the exception
is a mutable record two machines both edited.

**Never:** a force push, an automatic merge resolution, or a silent winner.

---

## VPSes: two models

### A. A VPS as a remote + deployment — **recommended**

```bash
statenest remote add prod-1 --host prod-1.example.com --user deploy --env production
statenest deploy add api --remote prod-1 --path /srv/api
```

StateNest is **not installed on the server**. It records the address, the deploy
path, the service name and the environment, and shows them in `where`, the
dashboard and the resume brief.

This is right for essentially every production server. Servers run your code;
they are not where you do your thinking, so there is nothing for StateNest to
remember there. It also means nothing extra to install, patch or trust on a
production host.

### B. A VPS as a full StateNest machine — occasionally

Install StateNest on the host, join it to the same profile sync, and let it scan
repositories there. Worth it only when you genuinely **work on that host** — a
development box, a build machine, a server where you edit and commit in place.

The cost is real: another machine in your sync repository, another install to
keep current, and your project metadata at rest on a public-facing host.

**Rule of thumb:** if you would not open an editor on it, register it as a
remote.

---

## Profiles

| Question                                                 | Answer                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Does `statenest dashboard` show only the active profile? | Yes, unless you pass `--all-profiles`                             |
| Can the dashboard show several profiles at once?         | Yes, read-only, with every row labelled                           |
| Can `projects`, `recent`, `status` aggregate profiles?   | **No**, by design — one profile at a time                         |
| Is sync strictly per profile?                            | Yes. `ProfileSync` operates on one profile directory              |
| Can two profiles use different private repositories?     | Yes, and tested: each remote contains only its own profile's data |

With one shared profile, none of this comes up: every command already covers
everything, and `--all-profiles` is unnecessary.

### Why the CLI stays single-profile

The dashboard is read-only by construction, so a unified view there cannot write
to the wrong profile. The CLI is not: `projects`, `recent` and `status` sit
beside `checkpoint`, `task add` and `remove`, and a `--all-profiles` habit that
works for the read commands is a habit that eventually gets typed next to a
write. One place to see everything is the requirement; every command growing a
cross-profile mode is not.

### Collapsing profiles is a choice, not a workaround

If you want the isolation, do not collapse profiles merely to get one view —
`--all-profiles` exists so you do not have to pay for a viewer with your
boundary.

But choosing **one shared profile deliberately** is a different thing entirely,
and it is fully supported. That is Model A above: one namespace, one sync
repository, the plain `statenest dashboard` and every CLI command covering
everything you own. The question is not which is correct; it is whether you need
work and personal metadata kept apart. Only you know that.

---

## If you already have two profiles and want one

Say you started with `personal` on the MacBook and `work` on the laptop, and
have since decided you want a single namespace.

**There is no merge command, and there is no supported way to copy records
between profile directories.** Do not do it by hand — the files reference
machine ids and project ids that only make sense inside their own profile, and
nothing validates the result.

What does work:

1. **Choose the profile holding the memory you would most hate to lose** —
   usually the one with the most checkpoints and decisions. That becomes the
   shared profile.
2. **Sync it first**, from the machine it lives on, to the private repository
   you intend to share.
3. **On the other machine, join that same profile**: `statenest profile use
<name>` (or `create` it first if the name does not exist there), then
   `sync init` against the same repository, then `sync`.
4. **Scan that machine's repositories** — `statenest scan ~/code --save-roots` —
   and sync again. Its checkouts attach to the projects that already exist.
5. **Leave the old profile alone.** It is still on disk, still complete, and
   costs nothing. It is your backup.
6. **Only then** consider what is genuinely missing. Checkpoints in the
   abandoned profile are Markdown files you can read; tasks and decisions are
   YAML. If something matters, re-record it deliberately — a handful of
   `statenest checkpoint` and `statenest decision add` calls is safer than any
   copy, because it goes through the same validation as everything else.

Do not delete the old profile until you have used the shared one for a while and
are sure nothing is missing. StateNest will not delete it for you, and it does
not get in the way.

## What is not supported

Said plainly, so nobody builds on an assumption:

- **No cross-profile CLI aggregation.** Dashboard only.
- **No profile rename, merge or delete.** `statenest profile` has `list`,
  `create`, `use` and `show`, and nothing else. Choose a name you can live with,
  and do not plan on consolidating two populated profiles later.
- **No automatic conflict resolution.** You resolve it, or you abort it.
- **No merging of two projects that merely share a name.** Identity is the git
  remote, and nothing else.
- **A repository with no git remote cannot merge across machines.** It gets a
  random id, because there is nothing to match on. Give it a remote if you want
  it to follow you.
- **Two machines can end up with the same display name** if their hostnames
  match. The ids differ, so nothing is confused, but
  `statenest machine rename <name>` makes listings readable.
- **StateNest never modifies a source repository.** Verified by comparing every
  file in the fixtures, byte for byte, before and after a full multi-machine
  sync.
