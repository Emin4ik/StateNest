# Positioning

The canonical source for describing StateNest to other people. If a description
somewhere else disagrees with this file, this file is right and the other one
should be fixed.

Everything here is checked against the implementation. Nothing is aspirational.
When something is a limitation, it is stated as one — the limitations are part
of the pitch, not a disclaimer at the bottom.

---

## One-line description

> StateNest is a local-first memory and control layer for coding agents.

Alternative, when the audience will not know what that means yet:

> StateNest remembers what you were doing in each project — and hands it back to
> your coding agent when you start work, on whichever computer you are at.

---

## 30-second description

StateNest is a local-first memory and control layer for coding agents. You
install it once and work normally; it recognises the git repository you opened
your agent in, restores what you were doing into the session, records what the
session achieved, and syncs that memory to your other computers through a
private git repository you own. An ordinary day needs no StateNest commands. It
stores project state — progress, decisions, blockers, next actions, which
machines hold the project, where it deploys — as plain YAML and Markdown in
`~/.statenest`. It does not store your source code or your conversations, and
there is no account or service of any kind.

---

## Longer explanation

Open a project you last touched three weeks ago and the state you actually need
is nowhere. Git history tells you what changed, not what it was for or what you
were about to do next. The reasoning behind a decision was in a conversation
that has since been compacted away. Which laptop has the working copy, which VPS
runs it, what was blocking you — none of that is written down anywhere, by
anyone. Your coding agent has the same problem and worse: it starts every
session knowing nothing about the last one.

StateNest joins information that normally lives in separate places: the project,
its progress and decisions, the machines it exists on, the servers it deploys
to, and the context an agent needs at the start of a session. It keeps that as
plain files under `~/.statenest`, and most of it is re-derived from disk rather
than asserted by a model — repository identity, branch, uncommitted count and
ecosystem type are read fresh, not remembered.

A project's identity is a hash of its normalised git remote, not its path. The
same repository on a MacBook at `~/Projects/harbour` and on a Linux workstation
at `~/code/harbour` is **one** project with two locations. That is what lets
context follow you between machines: finish something on one, open your agent on
the other, and the brief it receives already includes what you did.

Claude Code is currently the only implemented adapter, and it is a deep one —
five hooks, ten MCP tools and seven skills. The core is agent-independent and
does not import it; the seam another agent would use is documented. That is an
architectural property, not a promise of other integrations.

---

## What problem it solves

- **"Where did I stop?"** — across many projects, weeks apart, on more than one
  computer.
- **"Why is it like this?"** — decisions and their rejected alternatives,
  recorded when they are made rather than reconstructed later.
- **"Where does this even live?"** — which machines hold the project, which
  server runs it, under which path and service name.
- **"My agent has no idea what happened last time."** — the reason the whole
  thing exists.

---

## StateNest vs CLAUDE.md

The cleanest framing:

> `CLAUDE.md` describes **how this repository should be worked on**.
> StateNest records **what has happened to this project, and where it exists**.

`CLAUDE.md` is committed, reviewed and shared with the team. That is exactly
what makes it the right home for conventions and architecture rules, and the
wrong home for "I am half way through the allocator rewrite and blocked on the
tide feed" — which is personal, changes hourly, and is different on each of your
machines.

They complement each other. StateNest does not read `CLAUDE.md`, does not
replace it, and does not want to. **Never pitch StateNest by criticising
`CLAUDE.md`.**

Same for `TODO.md` and git history: a TODO file is a list you maintain by hand,
and git history is what changed rather than what it meant.

---

## StateNest vs AI conversation memory

Conversation-memory tools remember **what was said**. StateNest records **what is
true about your projects and machines right now**.

Concretely, StateNest does **not**:

- archive your chats,
- put your tokens in a vector database,
- index your codebase,
- watch your filesystem,
- read Claude Code's transcripts.

What it keeps is a structured record plus selected checkpoints — and those
checkpoints come from the compaction summary Claude Code has already written, so
no extra model is ever run for them.

This is a boundary worth leading with rather than hiding. It is the difference
between "a tool that remembers your project" and "a tool that keeps everything
you have ever typed".

---

## Current limitations

State these plainly. They are the credibility.

- **Claude Code is the only adapter that exists today.** The core is
  agent-independent, but no other integration is implemented.
- **A short session that never compacted yields metadata, not meaning.** Branch,
  commit and that work happened — not what it meant. The supported hook data has
  no per-turn content, and producing a summary without it would mean reading the
  raw transcript or running another model. StateNest does neither.
- **Repositories without a hosted remote are not registered automatically.**
  Identity comes from the remote; without one, an id cannot mean the same thing
  on two machines. `statenest add .` still registers them.
- **There is no daemon.** Sync runs when StateNest or Claude Code is active.
- **Genuine same-record conflicts need a human decision.** `statenest sync repair`
  asks; nothing is ever auto-merged.
- **Early-stage.** v0.2.0, actively dogfooded. Workflows and the on-disk format
  may still change before 1.0; migrations are provided and back up before they
  write.

---

## Security wording

Accurate phrasing, to reuse verbatim:

> StateNest is local-first. Nothing leaves your machine unless you configure
> sync, and then it goes to a private git repository you own — there is no
> StateNest account or service. It does not store your source code, `.env`
> contents, ssh keys, passwords, API tokens, or raw Claude Code transcripts.
> Filenames are checked against a deny-list before a file is opened, and
> everything it writes passes a secret scanner. Sync scans again before anything
> leaves the machine and refuses to push on a finding, reporting the file and
> line rather than the value.

Followed by the limit, in the same breath:

> Secret detection is a safety net with documented limits, not a guarantee. It
> matches known credential shapes; a format it does not know will not be caught.

**Never say "secure" as an absolute.** Never say "guaranteed", "can't leak" or
"military-grade". Say what it does, then what it does not cover.

Point at evidence rather than asserting trustworthiness: the properties above
are covered by tests that run in CI, and the threat model is in
[security-model.md](security-model.md).

---

## Example launch text (GitHub / Hacker News)

> **StateNest – local-first memory layer for coding agents**
>
> I kept losing context between sessions and between machines. Git history says
> what changed, not what I was doing or why. My agent started every session
> knowing nothing about the last one.
>
> StateNest is a local-first memory layer for coding agents. Install it once,
> then work normally: it recognises the git repository you opened Claude Code
> in, restores what you were doing, records what the session achieved, and syncs
> that to your other machines through a private git repo you own. An ordinary
> day needs no StateNest commands.
>
> A project's identity is a hash of its normalised git remote, so the same
> repository at `~/Projects/harbour` on a Mac and `~/code/harbour` on a Linux
> box is one project with two locations. Finish something on one, open Claude on
> the other, and the brief already includes it.
>
> Everything is plain YAML and Markdown in `~/.statenest`. It does not store
> source code or conversations, there is no account, and it works offline.
> Checkpoints reuse the compaction summary Claude Code already generates, so no
> second model is ever run.
>
> Claude Code is the only adapter today — five hooks, ten MCP tools, seven
> skills. The core is agent-independent and the seam is documented, but nothing
> else is implemented yet.
>
> It is early (v0.2.0) and I use it every day across several machines. Feedback
> on the sync and privacy boundaries especially welcome.

---

## Example Reddit post

> **I built a local-first memory layer so my coding agent remembers between sessions and machines**
>
> The problem: I work across a lot of projects on two computers. Coming back to
> one after a few weeks, the thing I actually need — where I stopped, what was
> blocking me, why I chose an approach — is not in git history, and my agent has
> no idea either.
>
> StateNest stores that as plain YAML/Markdown in `~/.statenest` and hands the
> relevant part to Claude Code when a session starts. After `statenest setup` you
> do not run any commands: it recognises the repository, injects context,
> captures a checkpoint when Claude Code compacts (reusing the summary it already
> wrote, so no extra model call), and syncs in the background to a private git
> repo you own.
>
> The bit I find most useful is cross-machine. Identity is a hash of the git
> remote, not the path, so the same repo on both machines is one project with two
> locations, and context follows me.
>
> Honest limitations: Claude Code is the only integration that exists; short
> sessions that never compact only get metadata, not a real summary (the hook
> data has no per-turn content and I am not going to read your transcript or run
> a second model to fake one); repos without a hosted remote need an explicit
> `statenest add`; and genuine conflicts between two machines ask you rather than
> merging.
>
> No account, no service, no telemetry, works offline. It does not store your
> source code or your conversations. MIT.

---

## Example answer to "Why wouldn't I just use CLAUDE.md + git?"

> You should keep using both — StateNest does not replace either.
>
> `CLAUDE.md` is for how the repository should be worked on: conventions,
> architecture, build commands. It is committed and shared with your team, which
> is why it is the wrong place for "half way through the allocator rewrite,
> blocked on the tide feed" — that is personal, changes hourly, and is different
> on each of your machines. Git history tells you what changed, not what it was
> for or what you meant to do next.
>
> Three things neither covers:
>
> 1. **Nobody maintains them for you.** A `TODO.md` is only as current as the
>    last time you remembered to edit it. StateNest captures a checkpoint when
>    Claude Code compacts and when a session ends, without being asked.
> 2. **They are per-repository.** Neither knows that this project also lives on
>    your workstation at a different path, or that it deploys to a particular VPS
>    under a particular service name. StateNest joins project, machine, path,
>    server and deployment.
> 3. **They do not travel separately from the code.** StateNest's memory syncs on
>    its own, to a private repo you own, so context arrives on the other machine
>    without being committed into the project's own history where your team would
>    see it.
>
> If you work on one project, on one machine, and you keep your own notes
> diligently, `CLAUDE.md` plus git genuinely may be enough. StateNest earns its
> place at several projects and more than one computer.

---

## Words to avoid

| Avoid | Because |
| --- | --- |
| "remembers everything" | It stores structured state and selected checkpoints, not everything |
| "AI memory" / "your agent's brain" | Suggests transcript archival or a vector database; neither exists |
| "secure", "guaranteed", "cannot leak" | Absolute claims the implementation cannot support |
| "syncs your projects" | Ambiguous — it syncs its own memory, never your source code |
| "works with any agent" | Only the Claude Code adapter is implemented |
| "enterprise-ready", "battle-tested" | It is v0.2.0 |
| "zero-config" | There is a setup step; the accurate claim is zero *daily* commands |
