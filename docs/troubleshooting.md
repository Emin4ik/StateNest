# Troubleshooting

Start here:

```bash
statenest doctor
```

Every failing check prints the command that fixes it. If a check fails without
telling you what to do, that is a bug — please report it.

## "StateNest could not identify this project"

StateNest matches a directory to a project by its git remote first, then by
a path it has seen before.

```bash
statenest add .          # register the current directory
statenest projects       # is it registered under a different name?
```

A repository with **no remote** is identified by its path on this machine. If
you moved it, re-run `statenest scan` to pick up the new location.

## "X matches more than one project"

Deliberate. StateNest will not guess between `payment-api`, `internal-api`
and `old-api`. Use a longer term, or the project id from `statenest projects --json`.

## A project appears twice

Almost always two clones whose remotes normalise differently. Check:

```bash
statenest show project-one --json | grep identity
statenest show project-two --json | grep identity
```

If the identities differ but should not, that is a normalization bug worth
reporting with both remote URLs. Meanwhile, `statenest remove` the duplicate — its
checkpoints are kept unless you pass `--with-history`.

## `statenest scan` is slow or finds nothing

```bash
statenest scan ~/Projects --dry-run    # see what it would register
statenest scan ~/Projects --depth 4    # shallower, much faster
```

Scanning an entire home directory takes around two seconds. If it takes far
longer, you likely have a cloud-sync folder (Dropbox, OneDrive, iCloud) inside
a scan root — walking those triggers on-demand downloads. Name a narrower root.

Projects without a git repository are skipped by default. Use
`--include-non-git` if you want them.

## Sync says it is blocked by secrets

Working as intended. Something in your StateNest data looks like a
credential, and nothing was sent.

```bash
statenest privacy audit
```

The output names the file and line, with the value masked. Remove it, **rotate
it** — it has been written to disk — and sync again.

## Sync reports a conflict

Two machines changed the same record. Nothing was lost.

```bash
cd ~/.statenest/profiles/personal
git status                    # the conflicted files
# edit them to keep what you want
git rebase --continue
statenest sync
```

Checkpoints are immutable, one file each, so they never conflict. A conflict
means a mutable record — `project.yaml` or `state.md` — was edited in two
places.

## A file could not be parsed

```
warning ~/.statenest/.../project.yaml could not be read (invalid YAML)
```

StateNest reports it and keeps going with everything else. It never deletes
a file it could not read. Open it and fix the YAML; `statenest doctor` lists every
affected file.

## Uninstalling

```bash
statenest integrate remove claude     # remove the Claude Code plugin
npm uninstall -g statenest # remove the CLI
```

Your data stays at `~/.statenest`. Delete that directory yourself if you
want it gone — StateNest will not remove your memory on your behalf.

## Reporting a bug

Include the output of `statenest doctor`, your OS, and `statenest --version`. Please do not
paste real credentials or server addresses.
