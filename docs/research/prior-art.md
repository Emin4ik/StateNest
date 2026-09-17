# Prior art

Surveyed 2026-09-17, before implementation. The purpose was to decide what
**not** to build, and to steal good ideas honestly.

The conclusion that shaped everything else:

> The AI-memory category is crowded and largely settled. The
> **project/machine/infrastructure inventory** problem is not solved by
> anything, in either category.

---

## 1. AI coding-agent memory tools

Representative of the category: **Goldfish**, **claude-mem**, **mem0**,
**basic-memory**, `@modelcontextprotocol/server-memory`, and a long tail of
"claude code memory" plugins.

**What they do well**

- Hook into the session lifecycle rather than hoping the model calls a tool.
  This is the single most important lesson: *a tool the agent must remember to
  call will not get called.* Project Brain captures through hooks first and
  exposes MCP tools second.
- A small always-loaded index plus detail files read on demand. Our
  ~500-character session brief plus MCP tools for depth is the same shape.
- Markdown-native storage that a human can read without the tool.

**Where we deliberately do not compete**

- **Session and conversation memory.** claude-mem owns Claude Code lifecycle
  capture; mem0 owns the general layer; Claude Code has native checkpointing
  and `/resume`. Entering here would be a guaranteed loss.
- **Semantic recall over chat history.** Well served, and not the problem a
  developer with fifty repositories actually has.

**Mistakes we avoided**

| Observed | What we did |
| --- | --- |
| Goldfish's README, `package.json` and `plugin.json` all claim MIT, but the repo ships **no LICENSE file** — as published, it is not safely reusable | `LICENSE` exists from the first commit |
| Requiring a git clone, a specific runtime, and a hardcoded absolute path in every client config | `npm install -g project-brain` then `pb init`; the plugin installs through Claude Code's own CLI |
| Requiring an LLM or embedding API key before anything can be written | Metadata checkpoints need no model at all; rich ones reuse work the agent has already done |

---

## 2. Non-AI developer tooling

Surveyed: **ghq**, **ghorg**, **gita**, **mani**, **mgitstatus**, **zoxide**,
**sesh**, **tmux-sessionizer**, **mise**, **direnv**, VS Code Project Manager,
JetBrains Toolbox, **devpod**.

**Conventions adopted**

- Zero-argument invocation is a listing; one argument resolves through an
  **exact → prefix → substring → fuzzy** ladder. This is exactly what
  `src/core/resolve.ts` implements.
- Aggregate existing sources rather than demanding the user re-enter them —
  hence reading `~/.ssh/config` instead of asking people to type host details.
- Discovery by scanning, not by manual `add`. Registries that only grow by hand
  drift out of date and get abandoned.

**Mistakes we avoided**

| Observed | What we did |
| --- | --- |
| ghorg's re-run **overwrites local changes** unless `--no-clean` is passed | No Project Brain command ever writes to a source repository. Enforced by a test. |
| ghorg's default concurrency of 25 reliably causes "too many open files" | Scanner concurrency defaults to 16 and is bounded everywhere |
| Every tool surveyed is **single-machine** | Machines are first-class; a project's identity is deliberately independent of its path |

**The gap.** Each of these owns exactly one column: acquisition (ghq), dirty
status (gita), navigation (zoxide), session launch (sesh), environment (mise),
remote (devpod). Nothing joins *project ↔ path ↔ machine ↔ server ↔ progress*.
That join is the product.

---

## 3. Engineering pitfalls

Researched specifically because they change implementation, not architecture.

| Pitfall | What we do |
| --- | --- |
| `fs.readdir(p, {recursive:true})` blocks the event loop and follows symlinks with **no cycle detection** (nodejs/node#51749, #51858 — both closed as not planned). One `ln -s ..` under `$HOME` is an unbounded walk. | Hand-rolled breadth-first walker with `realpath`-based cycle detection |
| Checking `.git` with `isDirectory()` misses linked worktrees and submodules, where `.git` is a **file** containing `gitdir: <path>` | `resolveGitDir()` handles both, and distinguishes a worktree from a submodule |
| Git filename case collisions on macOS/Windows, and NFD vs NFC unicode normalization | Record filenames are generated ids from a fixed lowercase alphabet; human names live in file *content* |
| Rename-over-existing intermittently fails with EPERM on Windows under antivirus | `writeFileAtomic` retries with backoff |
| Line endings rewriting every file when a repo is shared between Windows and macOS | `.gitattributes` with `* text=auto eol=lf` is written into every profile |
| Conflict UX is where every git-backed tool fails users | Checkpoints are immutable one-file-each; decisions use `merge=union`; sync refuses loudly rather than silently losing data |

**Secret detection.** gitleaks, trufflehog and detect-secrets all combine
high-precision prefix rules with entropy checks, and all struggle with false
positives on the entropy half. Since Project Brain scans only its *own* short
prose output — not arbitrary source trees — we ship a small explicit ruleset
where a hit is nearly always real, and gate the one broad rule behind an
entropy threshold. The limits of this are documented for the user in
`docs/security-model.md` rather than being papered over.

---

## 4. Where Project Brain is different

Stated plainly, because a new entrant in a crowded category owes the reader
this:

> Existing tools remember **what the AI learned**. Project Brain remembers
> **where all of your projects live and what operational state they are in** —
> across every machine you own and every server you deploy to.

It is closer to an **inventory** than a memory: most of it is re-derivable by
scanning git, the filesystem and your ssh config, which is a different
trust level from "the model wrote this down and hopefully it was right".
