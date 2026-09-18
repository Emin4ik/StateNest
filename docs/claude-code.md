# Claude Code integration

```bash
statenest integrate claude
```

This uses Claude Code's own plugin CLI. It **never edits your
`~/.claude/settings.json`** — Claude Code owns hook, MCP and enablement
registration, and it has commands for all of it. Removing the integration is
exact, and nothing you configured yourself is touched.

To do it by hand:

```bash
claude plugin marketplace add "$(npm root -g)/statenest"
claude plugin install statenest@statenest
```

Verify with `statenest integrate status` or `statenest doctor`.

## What you get

### A brief at session start

Open Claude Code inside a registered project and it already knows where you
left off:

```
# StateNest

Project: world-war-rts
Branch: phase-7
Last activity: 3d ago

## Recently completed
- unlimited match duration
- pause/resume for AI matches

## Open blockers
- AI fails to rebuild a destroyed refinery

## Next
- fix refinery rebuild behaviour
```

About 500 characters, capped at 4,000. Deeper history is available through the
MCP tools when the model actually needs it, rather than being paid for on every
session.

In an **unregistered** directory nothing is injected. That is deliberate:
interrupting a session to ask about registration is exactly the nagging this
tool is supposed to remove. Run `statenest add .` when you want it.

### Skills

| Skill | For |
| --- | --- |
| `/statenest:resume` | Pick a project back up |
| `/statenest:checkpoint` | Record what this session accomplished |
| `/statenest:where` | Find a project's copies and servers |
| `/statenest:recent` | What you have been working on |
| `/statenest:projects` | List or filter projects |
| `/statenest:status` | Where everything stands |
| `/statenest:doctor` | Diagnose StateNest itself |

### MCP tools

Claude uses these on its own when you ask things like "what was I doing
yesterday?" or "which server runs this?".

`projectbrain_current_project`, `_list_projects`, `_get_resume_context`,
`_list_recent`, `_where`, `_search`, `_checkpoint`, `_add_decision`,
`_add_task`, `_update_state`.

The write tools record **memory** and nothing else. There is no tool that runs
a shell command or connects to a server — registering a VPS in StateNest
deliberately gives a model no way to reach it.

## What happens automatically

| Event | What StateNest does | Cost |
| --- | --- | --- |
| **SessionStart** | Injects the brief | ~116ms, no model |
| **Stop** | Counts the turn in a local file. Runs async, cannot block. | negligible |
| **PreCompact** | Stashes branch, commit and dirtiness | no model |
| **PostCompact** | Writes a real checkpoint from the summary Claude Code already generated | **free** |
| **SessionEnd** | Writes a metadata checkpoint, if the session did anything | no model |

**StateNest never spawns a model.** Every rich checkpoint reuses work that
has already been done and paid for. There is no API key and no bill.

`PostCompact` is the most valuable of these: Claude Code hands the hook a
model-written summary of the conversation at no extra cost, at precisely the
moment a long session is about to forget what it did. It is condensed, run
through the secret scanner, and written as one checkpoint.

## Noise control

A checkpoint after every tool call produces memory nobody can read. Automatic
checkpoints require both a minimum gap (30 minutes by default) and that
something actually changed — a new commit, a different branch, a changed
working tree. A session where nothing moved produces no file.

```yaml
# ~/.statenest/config.yaml
checkpoint:
  mode: manual-smart      # metadata | smart | manual-smart
  min_interval_minutes: 30
```

## Performance

Measured on an M-series laptop:

| | |
| --- | --- |
| SessionStart, end to end | **p50 116ms** (including ~42ms Node startup) |
| Injected context | ~525 characters |

For comparison, measured SessionStart latency across all plugins on the same
machine was p50 686ms (n=93). Two decisions pay for this: the hook spawns no
git process, and the plugin entry points are bundled so Node resolves nothing.

## Troubleshooting

**No brief appears.** It only appears in a *registered* project. Check with
`statenest add .`, then start a new session — the brief is injected at session start,
not mid-session.

**`statenest doctor` says "Plugin build: compiled output missing".** The plugin was
installed from a source checkout that has not been built. Run `npm run build`
there, or install the published package.

**Hooks do not fire at all.** Confirm the plugin is enabled with
`claude plugin list`, and that the folder is trusted — Claude Code holds back
hooks in an untrusted folder.

**Something is wrong and you want it gone.**

```bash
statenest integrate remove claude
```

Your data is untouched.
