# The name is taken

**Status: RELEASE BLOCKER.** Researched 2026-09-18, before any publication.

`project-brain` cannot be used. Not "is crowded" or "would be hard to rank for" —
the npm package name is owned by an actively maintained product in this exact
category, and the phrase has become the generic noun for the category itself.

This document records what was checked, so the decision does not have to be
re-litigated, and proposes alternatives.

---

## What blocks it

### 1. npm `project-brain` is an active competitor

Verified with `npm view project-brain` on 2026-09-18:

```
project-brain@0.30.0 | MIT | 57 versions | 914 downloads/week
"Local-first MCP server that gives AI tools semantic memory of your codebase."
maintainer: jcsoftdev   first published 2026-06-03   last publish 2026-09-14
bin: project-brain
```

Fifty-seven versions in three months, five cross-platform binary subpackages, a
`project-brain` executable. This is not a squatted placeholder that npm would
transfer on a dispute — it is someone's live product in our own category. Every
`npm install project-brain` typed from memory installs theirs.

`project-brain-mcp` is also taken, described as "MCP server for Project Brain —
persistent memory for AI coding tools", which is close enough to our own pitch to
be uncomfortable. On PyPI both `project-brain` and `project_brain` resolve.

### 2. A commercial product uses the literal name

[getprojectbrain.com](https://www.getprojectbrain.com/) — "Project Brain" by
Avenor, a paid iOS/Windows app with a $2.99/mo tier, marketed at "indie
developers and creative people." Commercial use of the exact two-word name, by a
real company, in a developer-adjacent market. That is the profile of an actual
trademark complainant, and prior commercial use is theirs.

Separately, TheBrain Technologies holds US trademark registration #2169826 for
THE BRAIN in the computer-software class, registered 1998. Not our mark, but it
is a long-tenured registration in our class held by a company with standing.

### 3. GitHub cannot give us a canonical identity

At least nine repositories are named `project-brain`, most of them in
AI-coding-memory. The prominent one is
[Ethan-YS/project-brain](https://github.com/Ethan-YS/project-brain) — 172 stars,
MIT, "One folder. Every session knows where you left off." That is a direct
conceptual competitor under our exact name, and it is what a developer searching
GitHub for "project brain" finds. The `ProjectBrain` GitHub organisation is also
taken.

### 4. "Project brain" is now the category's common noun

This is the deepest problem and the one that cannot be fixed by ranking harder.
Competitors who chose *different* names describe themselves using ours:

- [JordanCoin/codemap](https://github.com/JordanCoin/codemap) (698★) — "a
  **project brain** for your AI."
- [codelocal](https://github.com/codelocal-cloud/codelocal) (73★) — "the
  open-source **Project Brain** for AI coding."
- mindmuxai/brain.md (546★) — "a **project brain** stores decision-grade
  knowledge."

Naming a product after the generic term for its category means never being
findable by it.

### 5. Search and domains are gone

A bare search for "Project Brain" returns neuroscience — the €1B EU Human Brain
Project, PubMed's BRAIN initiative, Wikipedia's "Artificial brain" — with no
software on the first page. Every plausible domain resolves to a live A record:
`projectbrain.{com,ai,dev,io,md,site,tools}`, `project-brain.com`,
`getprojectbrain.com`. `projectbrain.com` is parked and for sale at broker
pricing. We would launch on a fourth-choice domain with no upgrade path.

---

## The `pb` command is also a poor choice

Worth deciding separately, because it survives a rename.

**Not a hard conflict.** No Homebrew core formula, no Debian, Ubuntu, Arch or AUR
package installs a `pb` binary (all verified against their package APIs), and
`which -a pb` finds nothing on a stock macOS machine. `pbcopy`/`pbpaste` share a
prefix but not the name.

**But it is contested and misleading.** npm's `pb@0.4.0` (SheetJS, an OSX
pasteboard interface) declares `bin: { pb: ... }`, so a global install collides
for anyone who has it. At least four separate pastebin tools install a `pb`
command ([0xCD/homebrew-pb](https://github.com/0xCD/homebrew-pb), dom96/pb,
jamestomasino/pb, ptpb/pb). And `.pb` is the protobuf file extension while
cheggaaa/pb (3.7k★) is a well-known Go progress-bar library — so `pb` reads as
"pastebin", "protobuf" or "progress bar" at a glance, and as our tool to nobody.

A two-letter command is inherently high-collision and a common personal alias.
Recommendation: ship a full-word command and let users alias it themselves.

One premise did not hold up on checking: the Pinboard CLI is **not** called `pb`
(it is `pbl`, `pinboard`, or `pinboard.py`).

---

## Alternatives

Every availability claim below was verified on 2026-09-18 against `npm view`,
the Homebrew formula/cask APIs, `which -a`, and GitHub's search API.

| Name | Command | npm | Verdict |
|---|---|---|---|
| **Projectory** | `projectory` (alias `pj`) | free | **Recommended.** Clean everywhere |
| **Sitrep** | `sitrep` | `sitrep-cli` | Best meaning, contested namespace |
| **Stead** | `stead` | free | Cleanest namespace, weakest signal |
| Whereabouts | `whereabouts` | `whereabouts-cli` | Good meaning, long, noisy word |
| Milepost | `milepost` | free | Same-category namesake exists |
| Rollcall | `rollcall` | free | Owned by a US news outlet in search |
| Worksite | `worksite` | free | Returns construction software |
| Stocktake | `stocktake` | free | Owned by retail inventory SaaS |
| Workstate | `workstate` | free | Accurate, generic, unsearchable |
| Landfall | `landfall` | free | Reads as a hurricane |

### Recommended: Projectory

`npm install -g projectory`, command `projectory`, alias `pj`.

The only candidate free simultaneously on npm under its bare name, as a Homebrew
formula token, on PATH for both the long name and the alias, and effectively
unclaimed on GitHub (160 repos, all single-digit-star student projects) and the
open web. The bare `pj` name on npm exists but ships no bin, so the alias is
uncontested.

It means the right thing — project + directory, "the directory of my projects" —
without touching brain/memory/second-brain vocabulary, and it reads well in
practice: `pj resume payments-api`.

Honest weakness: ten characters is long, so it leans on the alias, and a coinage
that must be aliased is a weaker brand than one people type whole. Spoken aloud
it can be misheard as "projectry" or "trajectory".

### Runner-up: Sitrep

Better meaning, worse namespace. "Situation report" is exactly what this tool
returns. But the bare npm name is held by a 2017 single-version placeholder with
no bin — disputable under npm's name policy, unlike `project-brain`, but not ours
today — so day one would be `npm i -g sitrep-cli`, a softer version of the
problem that killed the current name. And
[twostraws/Sitrep](https://github.com/twostraws/Sitrep) (1,351★) already owns
developer search for the word.

### Third: Stead

The only name where npm, the bin and the Homebrew token are all completely
unowned. Nothing to dispute, nothing to work around. The cost is that it tells a
developer nothing about what the tool does, and you pay for the clean namespace
with permanent explaining.

---

## What has to happen

Renaming is a product decision, not an engineering one, so nothing here has been
renamed. The mechanics are ready for whichever name is chosen:

1. Edit the values in [src/core/metadata.ts](../../src/core/metadata.ts) and set
   `METADATA_IS_PLACEHOLDER` to `false`.
2. Run `npm run metadata:sync` to propagate into `package.json`, both plugin
   manifests, and the prose.
3. Run `npm run build && npm run schemas` to regenerate schema `$id` values.
4. Run `npm run check:metadata` to confirm.

`npm run check:metadata` fails while the placeholder flag is set, and it runs in
`release:check`, so a release cannot happen before this is decided.

The display name ("Project Brain" in the README, docs and CLI output) is a
larger, mostly mechanical diff and is deliberately not automated — it should be
done deliberately, in one commit, once a name is chosen.
