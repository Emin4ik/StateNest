---
name: doctor
description: Diagnose StateNest itself when it seems not to be working — no context appearing at session start, checkpoints not saving, a project not being recognised. Use when the user reports StateNest misbehaving.
---

# Diagnose StateNest

1. Run `statenest doctor` with the Bash tool and show the user the result.
   Every failing check prints the exact command that fixes it.

2. If the user's current project is not being recognised, call
   `projectbrain_current_project` and check what it reports:
   - "No registered project" with a git repository present → they need `statenest add .`
   - No git repository → confirm which directory they expect to be the project

3. If `statenest` is not on the PATH at all, StateNest is not installed globally.
   The fix is `npm install -g statenest`, then `statenest init`.

## Things worth knowing

- The session-start brief only appears in a **registered** project. In an
  unregistered directory, staying silent is deliberate, not a bug.
- Changes to what a session recorded appear at the *next* session start.
- If `statenest doctor` reports "Plugin build: compiled output missing", the plugin was
  installed from a source checkout that has not been built. `npm run build` in
  that checkout fixes it.

Report what the checks actually said. Do not guess at causes beyond them.
