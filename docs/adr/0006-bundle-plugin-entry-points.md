# ADR 0006: Bundle the plugin entry points

**Status:** accepted · 2026-09-17

## Context

Claude Code runs a plugin's hook and MCP commands directly from
`${CLAUDE_PLUGIN_ROOT}`.

Installing the plugin the way a real user gets it — and running a real Claude
Code session against it — produced:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'
    imported from .../dist/integrations/claude/protocol.js
```

There is **no `node_modules` at the plugin root**, and Claude Code does not
create one for a plugin loaded in place. Plugins get at most
`npm ci --ignore-scripts`, and only when a lockfile is present in the cached
copy — which an in-place plugin does not use.

Nothing in typecheck, unit tests, integration tests, or running the hook from
the development tree could have caught this: the development tree has
`node_modules` beside the code.

## Decision

Bundle the two entry points Claude Code executes into `dist-plugin/` with
esbuild, resolving nothing at runtime:

- `dist-plugin/hook.js`
- `dist-plugin/server.js`

Code splitting is kept on, so the hook's lazy `import()` calls stay genuinely
lazy — inlining everything into one file would parse and evaluate zod and yaml
on every session start, for handlers that do not run.

The **CLI is not bundled**. It is installed through npm where dependencies are
guaranteed, and unbundled stack traces point at real source files.

## Consequences

- The plugin works regardless of how it was obtained, including from a bare
  directory with no install step.
- SessionStart latency improved from p50 **211ms to 116ms**, and p90 from 209ms
  to 124ms — bundling removed module-resolution work as well as the failure.
- `dist-plugin/` is a build artifact, gitignored and produced by `npm run build`.
- `pb doctor` checks for the bundled entry points specifically, so a checkout
  that was never built reports *"Plugin build: compiled output missing"* with
  the command to fix it, rather than installing a plugin that silently does
  nothing.
