# Data schemas

JSON Schema for every record Project Brain writes, generated from the same
definitions the code validates against — so they cannot drift.

Schema version: **1**

Point your editor at these to get completion and validation when hand-editing
files under `~/.project-brain`. Every record type is a *loose* object: fields
written by a newer version of Project Brain are preserved rather than stripped,
so an older machine syncing the same data cannot silently drop them.

- `project.schema.json`
- `checkpoint.schema.json`
- `machine.schema.json`
- `remote.schema.json`
- `decision.schema.json`
- `tasks.schema.json`
- `profile.schema.json`
- `config.schema.json`

Regenerate with `npm run schemas` (requires `npm run build` first).
