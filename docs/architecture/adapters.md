# Writing an adapter

Claude Code is the first adapter, not the architecture. Core does not import
it, and anything the Claude adapter uses is a plain function the CLI and MCP
server call too.

## The seam

An adapter lives in `src/integrations/<agent>/` and needs three things from
core:

```ts
// 1. Which project is this?
const { project, repo, repoRoot } = await registry.identify(cwd, workspace.machineId);

// 2. What should the agent know?
const brief = await buildResumeBrief(workspace.store, project, {
  machineId: workspace.machineId,
  checkpointLimit: 3,
});
const context = renderSessionContext(brief, { machineName });

// 3. Record what happened.
await createCheckpoint(workspace.store, project, { summary, completed, next }, {
  machineId: workspace.machineId,
  source: 'claude-code',
  repo,
});
```

None of these take an agent-specific type. An adapter's job is translating
between its host's protocol and these calls.

## Rules for anything running inside someone else's tool

The Claude adapter follows all of these, and they were learned the hard way.

**Never fail loudly.** StateNest breaking must not look like the host tool
breaking. The hook always exits 0; errors go to the StateNest log, never to
stderr, because stderr from a hook is shown to the user as an error in a tool
they did not ask to debug.

**Always have a deadline.** Find out what the host's real budget is, not what
it documents. Claude Code kills a plugin's SessionEnd hook at ~1.5 seconds and
a plugin's own timeout field cannot raise it.

**Find out what the host gives you for free.** Claude Code hands `PostCompact`
a model-written summary at no cost. Discovering that turned the cheapest
possible integration into the best checkpoints the tool produces.

**Never spawn a model.** Reuse work the agent has already done. A memory tool
that runs up an API bill in the background is not one people keep installed.

**Assume no dependencies at runtime.** Bundle your entry points. A plugin root
may have no `node_modules`, and the host may not create one. See
[ADR 0006](../adr/0006-bundle-plugin-entry-points.md).

**Verify in the deployed shape.** Install into an isolated host configuration
and run it. The development tree has `node_modules` beside the code; a real
install does not, and that gap hides bugs no in-tree test can reach.

## Registering write tools

If your host has a tool protocol, expose the same read-mostly surface the MCP
server does. The write tools record memory — a checkpoint, a decision, a task,
a focus line.

Do **not** add a tool that executes commands or connects to a registered
server. StateNest stores the address of a user's production VPS; that must
not become a way for a model to reach it.
