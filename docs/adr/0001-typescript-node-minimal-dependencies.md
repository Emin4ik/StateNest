# ADR 0001: TypeScript on Node, with a deliberately small dependency set

**Status:** accepted · 2026-09-17

## Context

StateNest is a cross-platform CLI that also ships a Claude Code plugin and
an MCP server, and expects outside contributors.

## Decision

TypeScript on Node.js >= 22.12, built with `tsc`. Five runtime dependencies:

| Dependency | Why it earns its place |
| --- | --- |
| `commander` | Argument parsing with subcommands and correct help output |
| `zod` | Schema validation at every persistence boundary |
| `yaml` | Round-trips comments and formatting; `js-yaml` does not |
| `picocolors` | ~2KB; the alternatives are an order of magnitude larger |
| `@modelcontextprotocol/sdk` | The MCP protocol itself |

Written by hand rather than taken as dependencies: the directory walker, the
prompt helpers, atomic writes, table rendering, the git-config parser, the ssh
-config parser, secret detection, and the dashboard HTTP server.

TypeScript is pinned to 5.9 rather than 7.x. 7.x is a compiler rewrite; 5.9 is
what every contributor's editor and CI already runs, and the build is not a
bottleneck at this size.

## Consequences

- `npm install` pulls a small tree, which matters for a tool people install
  globally and audit before trusting.
- We own the correctness of the hand-rolled pieces. Each has direct tests.
- Node's ~42ms process startup is a floor we cannot go below without changing
  runtime. Bun was rejected: requiring a non-default runtime for a tool people
  install once and run constantly is a worse trade than 42ms.
