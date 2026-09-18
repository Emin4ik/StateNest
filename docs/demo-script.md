# Demo script

A reproducible two-minute terminal demo of the thing StateNest is actually for:
context following you from one computer to another, with no StateNest commands
in between.

Every block of output below was captured from a real run of the published
package. Nothing here is illustrative or hand-written. Where real output is
awkward, that is noted rather than tidied away.

---

## Run it yourself

```bash
npm run build
npm run demo:zero-touch          # or: -- --fast, with no pauses
```

`scripts/demo-zero-touch.mjs` performs the whole sequence below against two
throwaway homes and a local bare repository in the system temp directory,
driving the **real** Claude Code hook processes and the **real** background
sync. Every block it prints came out of StateNest; the script writes no output
of its own. It never touches your real `~/.statenest`.

To record it as a GIF without committing a binary to the repository:

```bash
brew install vhs                              # github.com/charmbracelet/vhs
vhs scripts/recording/zero-touch.tape         # -> docs/assets/zero-touch.gif
```

The `.tape` file is committed; the GIF deliberately is not. It regenerates from
the real product in about a minute, and a re-recorded binary would grow the
repository every time.

---

## What the demo has to show

In order of importance:

1. An unregistered repository becomes known **just by opening Claude Code**.
2. Work is captured **without anyone running `checkpoint`**.
3. A second machine receives that context **without anyone running `sync`**.
4. Both machines are **one project with two locations**.

If a recording shows only the CLI, it has demonstrated the least interesting
part of the product.

---

## Setup (before recording)

You need two machines — or two shells with separate `STATENEST_HOME` values,
which is how the captures below were made — plus a private git repository they
both reach. An empty bare repository on a local disk works for a demo.

```bash
npm install -g statenest
statenest setup
```

`setup` registers the machine, installs the Claude Code integration and offers
to connect sync. Do this on both machines, giving both the same repository.

Then clone the same project to a **different path** on each machine. The
different path is the point: it is what proves identity comes from the git
remote, not from where the directory happens to be.

```
Machine A   ~/Projects/harbour
Machine B   ~/code/harbour
```

---

## Machine A

### 1. Nothing is registered yet

```console
$ statenest projects

No projects registered yet.

StateNest finds projects by scanning directories you name:

  • statenest scan ~/Projects ~/Work
  • statenest add .   (register the current directory)
```

Leave that on screen for a second. It is the "before".

### 2. Open Claude Code — no `add`, no `scan`

```bash
cd ~/Projects/harbour
claude
```

StateNest registers the repository and injects a brief. At this point there is
no history, so the brief is short — which is honest and worth showing:

```
# StateNest

Project: harbour
About: Berth allocation service
Machine: mac-mini
Branch: main
Last activity: just now

Use the statenest MCP tools for more detail, or to record a checkpoint, decision or next action.
```

### 3. It is registered now

```console
$ statenest projects

PROJECT  STATUS  LAST ACTIVE  WHERE  NEXT
harbour  active  just now     local

1 project shown · profile: personal
```

**Nothing was typed to make that happen.** That is the single most important
beat in the demo — do not rush it.

### 4. Do some work, and let Claude Code compact

Work normally in the session. When Claude Code compacts, StateNest turns the
summary it has already written into a checkpoint — no second model is invoked.

For a short recording you can trigger the same path explicitly with
`/statenest:checkpoint`. Say which one you did; do not imply compaction happened
if you forced it.

```console
$ statenest recent

TODAY
  harbour  main
    Replaced the greedy berth allocator with cost-based allocation.

statenest resume <project> to pick one back up
```

### 5. It has already synced

```console
$ statenest sync status

Sync — profile "personal"

  ✓ StateNest is up to date. (last synced just now)
```

No `statenest sync` was run. The checkpoint scheduled a background sync when it
was written.

---

## Machine B

### 6. Open Claude Code in the same project, at a different path

```bash
cd ~/code/harbour
claude
```

```
# StateNest

Project: harbour
About: Berth allocation service
Machine: linux-box
Last activity: just now

## Last session
- Replaced the greedy berth allocator with cost-based allocation.

## Recently completed
- Implemented cost-based allocation
- Added regression fixtures for tidal windows
- Fixed the refinery income calculation

Use the statenest MCP tools for more detail, or to record a checkpoint, decision or next action.
```

That is the demo. Machine B's Claude session opened already knowing what
happened on machine A — with no `add`, no `scan`, no `checkpoint` and no `sync`
typed on either machine.

### 7. One project, two locations

```console
$ statenest where harbour

harbour

  Local

    mac-mini
      ~/Projects/harbour  (main)
      last seen 2m ago

    linux-box  (this machine)
      ~/code/harbour  (main)
      last seen just now

  Repository
    https://github.com/acme/harbour
```

Two machines, two paths, **one** project — because the identity is a hash of the
normalised git remote.

---

## Optional closing beats

Pick at most one. A demo that tries to show everything shows nothing.

**Offline.** Disconnect the network, start a session, work, reconnect. The
session starts normally, the checkpoint is captured, and sync catches up
afterwards. `statenest sync status` shows `○ Offline — local memory is safe.`
while disconnected.

**A conflict.** Change the same record on both machines and sync. StateNest
stops, keeps both versions, and leaves the local profile working; `statenest
sync repair` shows both sides and asks which to keep. This one is worth showing
to a technical audience, because "what happens when it goes wrong" is the
question they are actually asking.

---

## Honest notes for whoever records this

- **Machine names come from the hostname.** Two shells on one physical machine
  will show the _same_ machine name, even though the machine ids differ and
  everything else is correct. `npm run demo:zero-touch` sets them explicitly;
  if you record by hand, use two real machines or say so.
- **The second machine's own location appears from its second session.** Its
  first session adopts the remote history, which replaces the record it had just
  created locally. Everything else is correct immediately, and the demo script
  accounts for this — do not present the first session's `where` output.
- **Paths in the captures above were shortened.** The real output prints
  absolute paths, including the temporary directories a fixture run uses.
  Shorten for legibility, never invent.
- **The first session's brief is nearly empty.** That is correct — there is no
  history yet. Showing it makes the second machine's brief mean something.
- **A bullet that labels itself is filed by its own label.** `- Next: …` and
  `- Blocked: …` land under "Next" and "Open blockers", not under "Recently
  completed". Bullets with no label follow the heading above them. Nothing is
  inferred from prose, so `- Refactor: split the allocator` stays where it was
  written.
- **Do not fake latency.** Session start is around 100ms; there is nothing to
  hide and nothing to speed up in post.
- **Use a throwaway `STATENEST_HOME` and example remotes.** Never record your
  real `~/.statenest`, real repository names or real server addresses.

---

## Reproducing the captures

The output above came from driving the real hook entry points against isolated
homes and a local bare repository — the same approach as
[`tests/integration/zero-touch.test.ts`](../tests/integration/zero-touch.test.ts),
which asserts this whole sequence on every commit.

If you want to script it rather than record it, that test is the reference: it
does exactly this and then checks that the profile is clean, the source
repositories are untouched, and the project was not duplicated.
