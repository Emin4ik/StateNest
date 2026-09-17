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
