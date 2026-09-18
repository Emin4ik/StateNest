# Architecture

StateNest is a local-first CLI with adapters. Everything it knows lives in
plain YAML and Markdown under `~/.statenest`, and every feature is built on
a core that has no idea Claude Code exists.

## Dependency direction

```
   CLI        Claude Code adapter       MCP server      Dashboard
    |                 |                      |              |
    +--------+--------+----------+-----------+------+-------+
                                 v
                                CORE
                (registry, identity, context, checkpoints,
                    search, security, discovery)
                                 v
                        STORAGE  /  SYSTEM
                 (YAML + Markdown files, git, filesystem)
```

The rule that keeps this honest: **core never imports an adapter.** Anything
`src/integrations/claude/` needs from core is a plain function that the CLI and
MCP server can call too. Claude Code is the first adapter and the best
supported one; it is not the architecture.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/core/` | Schemas, identity, registry, resume/session context, path layout |
| `src/storage/` | Reading and writing YAML and frontmatter markdown, atomically |
| `src/discovery/` | Filesystem scanning, exclusions, project type detection |
| `src/git/` | Remote URL normalization, repository state (two tiers) |
| `src/checkpoints/` | Creating checkpoints, deciding whether one is worth writing |
| `src/search/` | Local lexical search across everything stored |
| `src/security/` | Secret patterns, redaction, profile audit |
| `src/remotes/` | ssh config parsing |
| `src/machines/` | Machine identity and OS detection |
| `src/sync/` | Optional git synchronization of a profile |
| `src/cli/` | `statenest`, and all human-facing output |
| `src/mcp/` | MCP server exposing core to coding agents |
| `src/integrations/claude/` | Hook handlers, session records, plugin installer |

## The three ideas everything else follows from

### 1. A project's identity is its git remote, not its path

`/Users/alice/code/app` and `D:\Projects\app` are the same project. Identity is
a hash of the **normalized** remote (`github.com/acme/widget`), so two machines
that have never communicated derive the same project id — which is what makes a
synced data directory merge instead of accumulating duplicates.

Repositories without a usable remote get a random id, minted once and carried
in the data. A local path is *never* used as cross-machine identity.

See `src/git/remote-url.ts` and ADR 0002.

### 2. A profile is a self-contained, independently syncable directory

```
~/.statenest/
  config.yaml          global settings
  machine.json         THIS computer's id — outside every profile
  profiles/
    personal/          <- a complete, syncable unit
      profile.yaml
      projects/<id>/{project.yaml,state.md,tasks.yaml,decisions.md}
      checkpoints/<project-id>/YYYY/MM/DD/HHMMSS_<id>.md
      machines/<id>.yaml
      remotes/<id>.yaml
    work/              <- different directory, different git remote
  cache/               derived, disposable, never synced
  logs/                never synced
```

"A work project must never sync into a personal repository" is not a rule the
code has to remember — sync operates on one profile directory, and another
profile's files are simply not inside it. See ADR 0003.

### 3. History is append-only; only "now" is mutable

- **Checkpoints** are immutable, one file each, at a timestamped path. Two
  machines and two concurrent sessions can write freely without contending.
- **Decisions** are appended to one readable file, resolved with git's `union`
  merge driver.
- **`project.yaml` and `state.md`** are the small mutable "what is true right
  now" layer, written atomically.

## Performance

Two decisions carry the latency budget.

**Two-tier git reading.** `readRepoFast` parses `.git` straight off the
filesystem and spawns no process; `readRepoFull` shells out to git. Scanning a
home directory touches hundreds of repositories, and at 5–20ms per spawn the
process cost would dominate. Working-tree dirtiness genuinely requires git, so
only the paths that need it pay for it.

**Bundled plugin entry points.** The hook and MCP server are bundled with
esbuild into `dist-plugin/`, resolving nothing at runtime. See ADR 0006.

Measured on an M-series laptop, 50 repositories:

| Operation | Measured |
| --- | --- |
| Claude Code SessionStart hook, end to end | p50 **116ms** (incl. ~42ms Node startup) |
| Scan `~/Documents` (2,141 dirs, 48 repos found) | **384ms** |
| Scan entire home (9,434 dirs) | 1.8s |
| Injected session brief | ~525 chars |

## Error handling

One error type, `BrainError`, for anything the user can act on. Every instance
carries a message, context lines and **a command that would fix it**. Anything
else stays an ordinary `Error` with its stack, and is reported as a bug.

Corrupt files are never fatal and never deleted: `Store` collects load issues,
the command the user asked for still runs, and `statenest doctor` reports them.

## Extending it

The adapter seam is `src/integrations/<agent>/`. A new adapter needs to:

1. identify the current project (`Registry.identify`),
2. render a brief (`buildResumeBrief` + `renderSessionContext`),
3. record checkpoints (`createCheckpoint`).

All three are core functions with no Claude-specific types. See
`docs/architecture/adapters.md`.
