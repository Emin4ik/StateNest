# Final name: StateNest

**Decided by the repository owner. Verified available 2026-09-18.**

The name was chosen by the owner, not selected by research. This document records
the availability verification that had to pass before any metadata was renamed,
and keeps the fallback candidates on file with their verified status.

The predecessor working name and why it was abandoned:
[project-name.md](project-name.md).

---

## The decision

| | |
| --- | --- |
| Display name | **StateNest** |
| npm package | `statenest` |
| CLI command | `statenest` |
| GitHub | [Emin4ik/StateNest](https://github.com/Emin4ik/StateNest) |
| Default branch | `main` |
| Visibility | public |
| License | MIT |

### Why it fits

The product's claim is that it knows the *state* of your work — which machine a
project is on, which branch, what was decided, what is unfinished — and keeps it
in one place you own. "State" is the noun the product actually deals in, and
"nest" is a container you return to rather than a system of record. Together
they read as "where the state of my work lives", which is the pitch.

It also sits outside the vocabulary the category is drowning in. It is not a
*brain*, *memory*, *context*, *recall*, *ledger*, *trail* or *atlas*, so it does
not compete for search terms with DevRecall, RepoRecall, ContextLedger, Code
Trail, DevLedger, Project Atlas, ContextDock, WorkTrail, CodeRecall or
RepoRelay — and it is not the generic phrase for its own category, which is
precisely what sank `project-brain`.

---

## Availability, as verified on 2026-09-18

Every line below is the result of a command or request that was actually run.

| Check | Method | Result |
| --- | --- | --- |
| npm `statenest` | `npm view statenest` | **E404 — free** |
| npm `statenest` | `GET registry.npmjs.org/statenest` | **HTTP 404 — free** |
| npm search "statenest" | registry search API | **0 packages** |
| PyPI `statenest` | `GET pypi.org/pypi/statenest/json` | **HTTP 404 — free** |
| CLI on PATH | `which -a statenest`, `type statenest` | **not found** |
| Homebrew formula | `formulae.brew.sh/api/formula/statenest.json` | **HTTP 404 — free** |
| Homebrew cask | `formulae.brew.sh/api/cask/statenest.json` | **HTTP 404 — free** |
| Arch packages | `archlinux.org/packages/search/json/?name=statenest` | **0 results** |
| AUR | `aur.archlinux.org/rpc/v5/info?arg[]=statenest` | **0 results** |
| GitHub repositories | GitHub search API, `q=statenest` | **1 result: `Emin4ik/StateNest`** (ours, empty) |
| Commercial / trademark | web search, "StateNest" software company product | **no product, company or mark found** |

`statenest` is uncontested on npm, on PATH, in Homebrew, in the Arch
repositories and the AUR, on PyPI, and on GitHub. The only repository bearing
the name is the owner's own.

### The one real risk

**"Nest" reads as NestJS inside the Node ecosystem.** An npm search for "state
nest" returns 133,411 results led by `@nestjs/throttler`, `@nestjs/common` and
`@nestjs/core`. Nothing collides — no package, binary or repository is named
`statenest` — but a Node developer skimming the name may assume a NestJS state
library before reading further.

This is a positioning cost, not an availability problem, and it is mitigated by
the tagline doing the work the name cannot: *a local-first developer control
plane that remembers projects, machines, infrastructure and where you stopped.*
Recorded here so the decision is made with open eyes.

---

## Fallback candidates

Kept on file so a future rename does not start from zero. All verified on
2026-09-18 by `npm view`; none was researched further, because `statenest` was
available and the decision was already made.

| Display name | npm | Status | Note |
| --- | --- | --- | --- |
| **StateNest** | `statenest` | **free — chosen** | "Nest" reads as NestJS to Node developers |
| DevAnchor | `devanchor` | free | "Dev" prefix is the most crowded shelf in the category |
| ContextBeacon | `contextbeacon` | free | "Context" puts it directly among context engines |
| Resumark | `resumark` | free | Coined and distinct, but reads as résumé at a glance |
| StateNest (hyphen) | `state-nest` | free | Held as a defensive variant only |

Ranking, had a choice still been open:

1. **StateNest** — distinct, outside every crowded vocabulary, clean namespace
2. **Resumark** — most distinctive, but the résumé misread is permanent
3. **DevAnchor** — clear meaning, generic prefix
4. **ContextBeacon** — accurate but lands in the busiest category
5. **state-nest** — defensive variant, not a product name

No alternative was needed. `statenest` was free on every registry checked.

---

## What was not re-researched

Per the owner's instruction, no further product-name *selection* research was
performed. The checks above are availability and collision verification only,
which was the stated gate before renaming.
