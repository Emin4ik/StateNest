# Project status

**v0.2.0. Early-stage, and actively dogfooded** across real projects and machines
every day. That is where the bugs come from and how they get found — v0.1.2 and
v0.2.0 both exist because daily use turned up something wrong.

This page is deliberately not a roadmap. It says what works now, what does not,
and what evidence exists for the claims.

---

## Stable and current

Each row links to the tests that cover it. These run in CI on every commit,
across macOS, Linux and Windows.

| Capability                                                                                                                                     | Evidence                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects register themselves** when an agent session opens in a git repository with a hosted remote — and ineligible directories are refused | [zero-touch](../tests/integration/zero-touch.test.ts)                                                                                                                                    |
| **One repository is one project**, across paths and machines, by normalised git remote                                                         | [multi-machine](../tests/integration/multi-machine.test.ts), [torture-identity](../tests/integration/torture-identity.test.ts), [ADR 0002](adr/0002-project-identity-from-git-remote.md) |
| **Context is restored** at session start, within a measured latency budget                                                                     | [zero-touch](../tests/integration/zero-touch.test.ts), [lifecycle](../tests/integration/lifecycle.test.ts)                                                                               |
| **Checkpoints are captured** from compaction and at session end, without running a model                                                       | [lifecycle](../tests/integration/lifecycle.test.ts)                                                                                                                                      |
| **Sync happens on its own**, coalesced, one at a time per profile                                                                              | [zero-touch](../tests/integration/zero-touch.test.ts)                                                                                                                                    |
| **A successful sync leaves its repository clean**                                                                                              | [sync-profile-metadata](../tests/integration/sync-profile-metadata.test.ts)                                                                                                              |
| **Offline work continues** and catches up when the network returns                                                                             | [zero-touch](../tests/integration/zero-touch.test.ts), [torture-sync](../tests/integration/torture-sync.test.ts)                                                                         |
| **Conflicts preserve both sides** and leave local data usable; repair resolves from either side                                                | [multi-machine](../tests/integration/multi-machine.test.ts), [zero-touch](../tests/integration/zero-touch.test.ts)                                                                       |
| **Credentials block a push**, and the value is never persisted                                                                                 | [security](../tests/integration/security.test.ts), [torture-security](../tests/integration/torture-security.test.ts)                                                                     |
| **Source repositories are never written to**                                                                                                   | [zero-touch](../tests/integration/zero-touch.test.ts), [sync](../tests/integration/sync.test.ts)                                                                                         |
| **Profiles cannot leak into each other**                                                                                                       | [isolation](../tests/integration/isolation.test.ts), [ADR 0003](adr/0003-profiles-as-syncable-directories.md)                                                                            |
| **Upgrades preserve data**, with migrations applied on read                                                                                    | [migration](../tests/integration/migration.test.ts)                                                                                                                                      |
| **Concurrent sessions and writes** do not corrupt state                                                                                        | [torture-concurrency](../tests/integration/torture-concurrency.test.ts)                                                                                                                  |
| **The published package installs and runs** on all three platforms                                                                             | [packaging](../tests/integration/packaging.test.ts)                                                                                                                                      |

The v0.1.2 upgrade path was additionally verified by installing the real
`statenest@0.1.2` from npm, creating data with it, and upgrading in place.

---

## Known limitations

Stated plainly, because they are the parts most likely to disappoint someone who
assumed otherwise.

**A short session that never compacted gets metadata, not meaning.** Branch,
commit and the fact that work happened — but not what it was for. Claude Code's
supported hook data contains no per-turn content, and producing a summary
without it would mean reading your raw transcript or running a second model.
StateNest does neither. Run `/statenest:checkpoint` when a short session
mattered.

**Repositories without a hosted git remote are not registered automatically.**
Identity is derived from the remote; a repository with none — or one pointing at
a local path — would get an id that cannot mean the same thing on two machines.
`statenest add .` registers it, because then you have said so.

**There is no always-running daemon.** Sync happens when StateNest or Claude
Code is active. A machine you never open never syncs, and a machine left running
with nothing open does not sync in the background.

**Genuine conflicts require a human choice.** When two machines change the same
record, StateNest keeps both and asks. `statenest sync repair` offers keep-mine
or keep-theirs per record; there is no "merge both", because no current record
type can be safely combined without inventing a resolution you did not ask for.

**Nothing is scanned automatically.** Only the repository the agent was opened
in is considered — not its parent, siblings or your home directory.
`statenest scan` registers things in bulk when you ask.

**Claude Code is the only integration.** The core is agent-independent and the
adapter seam is documented, but no other adapter exists.

**Upgrading StateNest does not upgrade the installed Claude plugin.** Claude
Code copies it into a version-keyed cache. Run `statenest integrate claude` after
upgrading; `statenest doctor` reports the mismatch.

**Search is lexical.** It finds words you actually wrote, not synonyms. There is
no embedding index and no vector database ([ADR 0007](adr/0007-lexical-search-not-embeddings.md)).

**Cross-profile aggregation is read-only and dashboard-only.** `projects`,
`recent` and `status` deliberately work one profile at a time.

**Secret detection is a safety net with documented limits.** It matches known
credential shapes; a format it does not know will not be caught. See the
[security model](security-model.md).

---

## Stability expectations before 1.0

- **Workflows and interfaces may change.** v0.2.0 already changed the default
  workflow substantially, and renamed the MCP tools.
- **The on-disk format may change.** Migrations are provided, applied on read,
  and back up before they write.
- **Correctness and data-safety bugs are fixed first** and released quickly.
- **No adoption or maturity claims.** This is a young project used seriously by
  the people writing it, and that is all.

Please [report issues](https://github.com/Emin4ik/StateNest/issues) — especially
anything touching data loss, sync correctness or privacy.
