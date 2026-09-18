# Two computers, several servers, one view

Every step and every outcome below was tested against real git repositories and
a real bare remote — see `tests/integration/multi-machine.test.ts` and
`tests/integration/unified-view.test.ts`. Where something is untested or
unsupported, this page says so rather than guessing.

---

## The shape of it

```
Home MacBook                     Work laptop
  personal profile                 work profile
  └─ private sync repo A           └─ private sync repo B
            │                                │
            └──────── never meet ────────────┘

VPSes
  registered as remotes + deployments, inside whichever profile owns them.
  StateNest is NOT installed on them.

Local dashboard
  └─ statenest dashboard --all-profiles
     read-only, both profiles, every row labelled
```

Two rules make this safe, and they are structural rather than enforced by
policy:

1. **A profile is a directory.** Sync operates on one profile directory, so a
   work project cannot reach a personal sync repository — the files are not
   inside it.
2. **The dashboard has no verbs.** Every method except `GET` and `HEAD` is
   refused with 405. A unified view cannot write to the wrong profile because it
   cannot write at all.

---

## 1. First computer

```bash
npm install -g statenest
statenest init
statenest scan ~/Projects
statenest projects
```

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
statenest init
```

Use the **same profile name** as the first computer — `personal` is the default
on both, so if you did not change it, there is nothing to do.

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

## 6. Scan the repositories that live on this computer

```bash
statenest scan ~/code
```

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

## 8. Register VPSes and deployments

**Do not install StateNest on a production server** to make its deployments
visible. A server is a *record*, not a participant:

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

---

## What happens in the awkward cases

Every row below was tested.

| Situation | What StateNest does |
| --- | --- |
| Remote empty, local populated | Commits and pushes. `synced` |
| Remote populated, local empty | Adopts the remote history, then materialises it. `synced`. The next push does **not** delete the other machine's projects |
| **Both** already populated, with different data | Rebases. Both sides survive. `synced` |
| Two machines change **different** records | Both changes kept. `synced` |
| Two machines change the **same** record | `conflict`. Both versions left in the file with markers. Nothing lost, nothing silently chosen |
| Machine offline | `offline`. Local data untouched, every local command keeps working. Recovers on the next sync |
| A credential is found | `blocked-by-secrets`. Nothing is committed and nothing is pushed |
| Interrupted rebase | Reported, never reported as `synced`. Local data stays readable |
| Same repository, two machines, different paths | One project, two locations |
| Same repository twice on **one** machine | One project, two locations, both on that machine |

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

| Question | Answer |
| --- | --- |
| Does `statenest dashboard` show only the active profile? | Yes, unless you pass `--all-profiles` |
| Can the dashboard show several profiles at once? | Yes, read-only, with every row labelled |
| Can `projects`, `recent`, `status` aggregate profiles? | **No**, by design — one profile at a time |
| Is sync strictly per profile? | Yes. `ProfileSync` operates on one profile directory |
| Can two profiles use different private repositories? | Yes, and tested: each remote contains only its own profile's data |

### Why the CLI stays single-profile

The dashboard is read-only by construction, so a unified view there cannot write
to the wrong profile. The CLI is not: `projects`, `recent` and `status` sit
beside `checkpoint`, `task add` and `remove`, and a `--all-profiles` habit that
works for the read commands is a habit that eventually gets typed next to a
write. One place to see everything is the requirement; every command growing a
cross-profile mode is not.

### Do not merge profiles to get one view

It would work, and it would cost you the isolation you set the profiles up for:
one sync repository holding both, work project names in a personal backup, and
no structural barrier left. `--all-profiles` exists so you do not have to make
that trade.

---

## What is not supported

Said plainly, so nobody builds on an assumption:

- **No cross-profile CLI aggregation.** Dashboard only.
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
