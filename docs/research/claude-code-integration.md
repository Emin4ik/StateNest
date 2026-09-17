# Claude Code integration: what we verified

Researched 2026-09-17 against the official documentation and Claude Code
**v2.1.273** installed locally. Findings marked *observed* were measured on a
real installation, not read in a document.

This file records only what **changes the implementation**. It is not a mirror
of the Claude Code docs; read those for anything not decided here.

> The documentation moved during this research. `docs.claude.com/en/docs/claude-code/*`
> now 301-redirects to `code.claude.com/docs/en/*`, and appending `.md` to a
> docs URL returns raw markdown — far better for reading exact schemas.

---

## 1. Hard constraints

These are limits, not preferences. Each one invalidates an otherwise-reasonable
design, so each is enforced in code and named here so it is not rediscovered.

| Constraint | Value | Where it is enforced |
| --- | --- | --- |
| A plugin's `SessionEnd` hook is killed at **~1.5s**, and the plugin's own `timeout` field **cannot raise it** | 1.5s | `DEADLINES['session-end'] = 1200` in `src/integrations/claude/hook.ts` |
| Every hook output string is truncated at **10,000 characters** | 10,000 | `HOOK_OUTPUT_LIMIT` in `src/integrations/claude/protocol.ts` |
| `SessionStart` delays the model's first response roughly 1:1 | — | Session brief capped at 4,000 chars; no git process is spawned on this path |
| Session-lifecycle hooks **cannot invoke an LLM** — `prompt` and `agent` hook types are unsupported on SessionStart/SessionEnd/PreCompact | — | Default checkpoint mode is `manual-smart`; see ADR 0005 |
| `${CLAUDE_PLUGIN_ROOT}` is **not** in the environment of commands Claude runs through the Bash tool | — | Skills use MCP tools, never a path-relative script |
| `${CLAUDE_PLUGIN_ROOT}` changes on every plugin update | — | No state is ever written there; data lives in `~/.project-brain` |
| A plugin gets **no dependency install** when loaded in place | — | Entry points are bundled; see ADR 0006 |

**Measured SessionStart hook latency across all plugins on the test machine**
(n=93 across 275 transcripts): min 241ms, p50 **686ms**, max 5133ms. Project
Brain's own hook measures p50 **116ms** end-to-end including Node startup.

---

## 2. Plugin layout

Verified against the docs and against installed plugins on disk.

```
project-brain/
  .claude-plugin/
    plugin.json          <- the ONLY file that goes in here
    marketplace.json     <- present because this repo is also its own marketplace
  hooks/hooks.json
  skills/<name>/SKILL.md
  .mcp.json
  dist-plugin/           <- bundled entry points the hooks and MCP server run
```

- `plugin.json` is **optional**; if present, `name` is the only required field.
- Everything except `plugin.json` lives at the **plugin root**, never inside
  `.claude-plugin/`. This is the single most common plugin mistake.
- `name` must be kebab-case and becomes the namespace: our skills are invoked
  as `/project-brain:resume`.
- If a marketplace entry lists the plugin under a different name, **the
  marketplace entry name wins** for `enabledPlugins` and `/plugin`.
- Setting `version` **pins** the plugin: users only get updates when it is bumped.
- A top-level `bin/` directory is **rejected** for plugins distributed through
  claude.ai organization settings. We ship no `bin/` in the plugin.

### Hooks file shape

`hooks/hooks.json` has an outer wrapper. It is not a bare event map:

```json
{ "hooks": { "SessionStart": [ { "matcher": "...", "hooks": [ ... ] } ] } }
```

### MCP server

`.mcp.json` at the plugin root. The `mcpServers` wrapper key is optional — a
flat map also loads — but we use the documented wrapper form.

Our server is registered as `plugin:project-brain:brain`, and its tools appear
to the model as `mcp__plugin_project-brain_brain__projectbrain_*`.

### Exec form vs shell form

A hook with an `args` array is spawned **directly, with no shell**. Without
`args`, the command string goes through `sh -c` (or PowerShell on Windows).

We always use exec form. It removes a whole class of quoting bugs on paths
containing spaces, which `${CLAUDE_PLUGIN_ROOT}` frequently does.

---

## 3. Hook events we use, and why

There are 33 hook events. We use five.

### `SessionStart` — matcher `startup|clear|compact`

Injects the project brief.

- `source` has five values: `startup`, `resume`, `clear`, `compact`, `fork`.
- We deliberately **do not** match `resume` or `fork`: those continue an
  existing conversation that already contains the brief, so re-injecting would
  spend context to say something twice.
- Matching `compact` is the **documented way to re-inject context after
  compaction** — `PostCompact` cannot do it.
- Context must be returned as:

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }
```

  `additionalContext` at the top level is accepted and **silently ignored** —
  a failure that looks exactly like "the plugin does nothing".
- SessionStart **cannot block startup**. Exit code 2 shows stderr to the user
  only; the session proceeds regardless.
- Only `command` and `mcp_tool` handler types are supported here, and
  `mcp_tool` hooks are skipped at launch (there is no MCP client yet).

### `Stop` — `async: true`

Counts turns into a machine-local session record. Stop fires constantly, so it
must never write a checkpoint.

`async: true` means it cannot block the session and its timeout is not
enforced. Its output is discarded, which is fine — it has none.

Use the `last_assistant_message` field rather than reading `transcript_path`;
the docs warn the transcript is not guaranteed to contain the final message at
Stop time.

### `PreCompact`

Stashes deterministic git state into the session record. Writes **no**
checkpoint — see `PostCompact`.

`trigger` is `manual` or `auto`. `custom_instructions` is readable but cannot
be rewritten.

### `PostCompact` — the most valuable event for this tool

Receives `compact_summary`: a model-written summary of the conversation,
**already generated, at no additional cost**.

This is the only place Project Brain gets a high-quality narrative checkpoint
without asking the user to write one or spending money on an API call — and it
arrives at exactly the moment the session is about to forget the work. We
condense it, run it through the secret scanner, and write one checkpoint that
combines it with the git state `PreCompact` stashed.

### `SessionEnd`

Final checkpoint, if the session did anything. Hard budget ~1.5s.

`reason` is one of `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.
Its JSON output is discarded, so it returns nothing.

A SessionEnd hook *can* outlive the session by detaching (`nohup ... & disown`),
but we do not: detaching is shell-form only, unportable to Windows, and our
checkpoint comfortably fits the budget.

---

## 4. Things we checked and deliberately did not use

| Mechanism | Why not |
| --- | --- |
| `claude -p` for session summaries | Measured **~$0.03 minimum** per call in a plugin-heavy environment, and `--resume` re-sends the whole conversation (the docs' own example shows >$1). `PostCompact` gives us a summary free. |
| `Stop` hook returning `decision: block` | The only way to make the live model summarise on demand, but it hijacks the user's turn. Claude Code force-ends after 8 consecutive blocks. Far too intrusive for a memory tool. |
| Parsing `~/.claude/projects/**/*.jsonl` transcripts | Format is explicitly undocumented and "changes between versions". Also directly against our own no-raw-transcripts rule. |
| `Setup` hook as an install hook | Fires only on `--init-only`, `-p --init` or `-p --maintenance` — never on install or normal startup. |
| Editing `~/.claude/settings.json` to register hooks | Unnecessary: `claude plugin install` manages enablement, hooks and MCP registration. Not touching it makes uninstall exact. |
| `suppressOutput` | Documented as accepted but with no effect. |
| Skill frontmatter `tools:` and `version:` | `tools:` is a *subagent* field and a no-op in a skill; `version:` is not a documented skill field and breaks claude.ai packaging. Both appear in published plugins anyway. |

---

## 5. Installation

`claude plugin install` accepts **only** a marketplace plugin name — not a
directory and not a git URL. So installation is always two steps:

```
claude plugin marketplace add <source>
claude plugin install project-brain@project-brain
```

**Load-in-place (verified empirically):** a marketplace added from a *local
directory* whose plugin `source` is a relative path loads the plugin **in
place**. `${CLAUDE_PLUGIN_ROOT}` points at the source directory, and edits take
effect at the next session start with no reinstall and no version bump.

A copy does appear under `~/.claude/plugins/cache/...` and is recorded as
`installPath`, but that copy is stale bookkeeping and is **not** what Claude
Code loads. Editing it has no effect.

This is what `pb integrate claude` relies on: the installed npm package
directory is both the marketplace and the plugin.

---

## 6. Skills

Custom commands were merged into skills. `.claude/commands/deploy.md` and
`.claude/skills/deploy/SKILL.md` both produce `/deploy` and behave identically.
New plugins should use `skills/`.

- In Claude Code, **all** frontmatter fields are optional; `description` is what
  makes a skill discoverable.
- Plugin skills take their name from frontmatter `name` or the directory, and
  are namespaced `/plugin-name:skill-name`.
- Plugin skills are both user-invocable and model-invocable by default.
- The portable Agent Skills standard allows only six fields: `name`,
  `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Using
  a Claude-Code-only field (`argument-hint`, say) is a **hard error** when
  packaging for claude.ai or the Skills API.

We use `name`, `description` and `argument-hint`. That keeps the skills useful
in Claude Code while limiting portability breakage to one field.

Size guidance: keep `SKILL.md` under 500 lines; metadata (~100 tokens) is
always loaded, so the description is the part that must earn its place.

---

## 7. Open questions

Recorded honestly rather than guessed at.

- `permission_mode` is listed as a common field but was **absent** from observed
  SessionStart and SessionEnd payloads. Code uses presence checks, never
  assumes it.
- There is no published machine-readable JSON Schema for hook output. We emit
  only documented fields.
- The concatenation order of `additionalContext` from multiple plugins is
  unspecified. Our brief is self-contained and does not depend on position.
- Whether `claude --bare` suppresses plugin hooks as well as settings-file hooks
  is implied but not itemised.
