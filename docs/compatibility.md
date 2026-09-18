# Compatibility

What is actually tested, what is supported, and what is neither. The three
columns mean different things and are not interchangeable:

| Term          | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| **Tested**    | Exercised by the test suite in CI, on every commit                            |
| **Supported** | Intended to work and fixed if it does not, but not covered by automated tests |
| **Untested**  | No claim either way. It may work; nobody has checked                          |

---

## Node.js

|               |                                                               |
| ------------- | ------------------------------------------------------------- |
| **Minimum**   | 22.12.0, declared in `engines` and enforced by npm on install |
| **Tested**    | 22.12 and 24, on every commit                                 |
| **Supported** | Any release line at or above 22.12                            |
| **Untested**  | Odd-numbered and pre-release lines                            |

The release workflow itself runs Node 24, because npm Trusted Publishing needs
npm >= 11.5.1 and Node >= 22.14.

## Operating systems

| Platform    | Status                              | Notes                                                                                                                                                                  |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | **Tested** — `macos-latest` in CI   | Primary development platform                                                                                                                                           |
| **Linux**   | **Tested** — `ubuntu-latest` in CI  |                                                                                                                                                                        |
| **Windows** | **Tested** — `windows-latest` in CI | Full suite, including path handling, atomic renames and 8.3 short-name resolution                                                                                      |
| **WSL**     | **Supported, untested**             | A normal Linux environment to StateNest. Treat a WSL install and a Windows install as two separate machines — they have different home directories and different paths |

Path handling, atomic replacement and git behaviour differ enough between these
that the matrix is not ceremony. Every platform above runs the full suite on
both Node versions.

## Git

|                          |                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Required?**            | No. StateNest runs without git                                                                                                                                                               |
| **Strongly recommended** | Without it, branch, commit and uncommitted-change information cannot be read, and project identity falls back to a random id that cannot merge across machines                               |
| **Required for sync**    | Yes. Sync is a git repository                                                                                                                                                                |
| **Version**              | No minimum is declared or enforced. Everything used is long-established plumbing — `init`, `add`, `commit`, `fetch`, `rebase`, `push`, `rev-parse`, `rev-list`, `status --porcelain`, `show` |

Tests that shell out to git skip themselves when git is absent rather than
failing, so the suite still runs on a machine without it.

## Claude Code

|                      |                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Verified against** | 2.1.273 — the hook payload shape was checked against this and the published hooks reference |
| **Supported**        | Any version providing the documented hook events and the plugin CLI                         |
| **Untested**         | Earlier and later versions                                                                  |

The hook payload is owned by Claude Code and documented as changing between
versions, so **every field StateNest reads is optional and every handler works
when it is absent**. An unrecognised payload produces no output rather than an
error. That is a deliberate compatibility strategy, not an accident: a hook that
throws shows the user an error in a tool they did not ask to debug.

The integration uses Claude Code's own plugin CLI (`claude plugin marketplace
add`, `claude plugin install`). It never edits `~/.claude/settings.json`.
`CLAUDE_CONFIG_DIR` is honoured.

**Upgrading StateNest does not upgrade the installed plugin.** `claude plugin
install` copies the plugin into a version-keyed cache, so a new npm version does
not reach it until you run `statenest integrate claude`. The copy that is there
keeps working — its hooks, MCP server and skills were copied together, so it is
old rather than broken. `statenest doctor` reports which version Claude Code is
actually running.

## Other coding agents

**None are integrated.** Claude Code is the only implemented adapter. The core
is agent-independent and does not import it, and the seam another adapter would
use is documented in
[architecture/adapters.md](architecture/adapters.md) — but that is a design
property, not a shipped integration. Do not assume Codex, Cursor, Gemini CLI,
Windsurf or OpenCode work; nothing has been built or tested for them.

## Sync transport

|               |                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Tested**    | Local bare repositories, driven by the real sync path in CI on all three platforms                                  |
| **Supported** | Any git remote your git can already push to — GitHub, GitLab, Bitbucket, self-hosted, or a bare repository on a NAS |
| **Untested**  | Specific hosted providers. Nothing in StateNest is provider-aware                                                   |

Assumptions worth knowing:

- **Your existing git credentials are used.** StateNest stores none and asks for
  none. Whatever your ssh agent or credential helper already does is what
  happens.
- **It never prompts.** `GIT_TERMINAL_PROMPT=0` and askpass stubs are set on
  every invocation, so an unauthenticated remote **fails fast** rather than
  hanging a background process or a session hook.
- **The remote must be private.** It holds project names, notes, server
  addresses and deploy paths. StateNest warns but cannot verify this for you.
- **History stays linear.** Sync rebases onto the remote and never force-pushes.
- **No provider APIs are called.** Only git.

## Shells and terminals

The CLI writes plain text with optional ANSI colour, disabled by `--no-color`
and when output is not a TTY. No shell integration, completions or prompt hooks
are installed. Any shell works; none is tested specifically.

## Storage format

Plain YAML and Markdown. The on-disk schema version is recorded in each record.
Migrations are applied on read, back up before writing, and are covered by
[migration tests](../tests/integration/migration.test.ts). The format may still
change before 1.0 — see [project status](project-status.md).
