# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, the on-disk data format may change between minor versions.
Migrations are provided and are never destructive: see `docs/data-model.md`.

## [Unreleased]

### Added

- Project registry with git-remote-derived identity that is stable across machines
- Filesystem scanning with aggressive pruning, symlink-cycle detection and
  worktree/submodule awareness
- Append-only checkpoints, one immutable file each
- Decisions, tasks and per-project state
- Local lexical search across projects, checkpoints, decisions, tasks and servers
- Machines and remote environments, with `~/.ssh/config` import by explicit selection
- Profiles as independently syncable directories, isolating work from personal
- Secret detection and redaction on everything written, plus `pb privacy audit`
- Claude Code plugin: SessionStart brief, Stop tracking, PreCompact/PostCompact
  checkpointing, SessionEnd checkpointing, seven skills and ten MCP tools
- `pb doctor`, with an actionable fix for every failing check
- Optional sync of one profile to a private git repository, with a blocking
  secret audit before any commit and non-destructive conflict handling
- Local read-only dashboard, loopback-only by default
- `pb export` / `pb import` backups, excluding machine-local state
- `pb uninstall`, which keeps your data unless you explicitly say otherwise
- Published JSON Schemas for every stored record

### Fixed

- A directory reached through a symlink (macOS `/tmp` -> `/private/tmp`) was
  registered as a second location on the same machine, so `pb resume` showed a
  project as if it existed on two computers
- `.mcp.json` was missing from the published package, so an npm install
  produced a plugin with working hooks and skills but no MCP tools
- A TOML manifest's `[project]` table was parsed past its own boundary because
  the pattern used `\Z`, a Perl anchor with no JavaScript equivalent
- A password embedded in an scp-style git remote could reach the derived
  project identity
