# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/Emin4ik/StateNest/security/advisories/new),
not in a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps enormously. **Never include a real credential** — if a report needs one,
describe its shape instead.

You can expect an acknowledgement within 3 working days and an assessment
within 10. We will credit you in the advisory unless you prefer otherwise.

## What counts as a vulnerability here

StateNest reads a developer's home directory and writes a file tree that
may be synced to a git repository. The things that matter most:

**High severity**

- Any path by which a credential, key, `.env` value or token reaches a file
  StateNest writes
- Any path by which data from one profile reaches another profile's directory
  or sync remote
- Any write to a user's source repository — StateNest observes repositories
  and must never modify them
- Sync proceeding despite the secret scanner finding a credential
- The dashboard binding to anything other than a loopback address by default

**Also in scope**

- A secret pattern that the scanner should detect but does not
- Command injection through a path, branch name, remote URL or ssh alias
- Path traversal through a project id, profile name or remote id
- A hook that can hang or crash the host coding agent

**Not vulnerabilities**

- The secret scanner failing to detect a credential format it does not know
  about. Detection is a safety net with documented limits, not a guarantee —
  see `docs/security-model.md`. We still want the report; it is a bug, not an
  advisory.
- StateNest reading files inside a directory you explicitly asked it to
  scan.
- Anything requiring an attacker to already have write access to your home
  directory.

## Supported versions

Until 1.0.0, only the latest released minor version receives security fixes.
