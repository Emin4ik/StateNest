# Publishing StateNest to npm

Researched against the official npm documentation on **2026-09-18**. npm changed
its authentication model substantially through late 2025, so anything you
remember from before then is probably wrong.

The short version:

- **The first publish must be done by a human, from a laptop.** Trusted
  publishing cannot be configured for a package that does not exist yet.
- **Every release after that runs from GitHub Actions with no token at all**,
  authenticated by OIDC, with provenance generated automatically.

---

## What changed in npm, and why it matters here

| Change | Effect on us |
| --- | --- |
| Classic tokens were **permanently revoked on 2025-12-09** | There is no long-lived publish token to create, so none can leak |
| `npm login` now issues a **short session** (2 hours, later extended) instead of a long-lived token | The bootstrap publish leaves nothing behind |
| **2FA is enforced for publishing** during those sessions | The maintainer needs 2FA on their npm account |
| Granular access tokens with write scope: **7-day default, 90-day maximum** | Only a fallback, and it expires by itself |
| OIDC **trusted publishing is generally available** | This is the target state |

Sources: [npm trusted publishing GA](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/),
[classic tokens revoked](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/),
[trusted publishers](https://docs.npmjs.com/trusted-publishers/),
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[provenance](https://docs.npmjs.com/generating-provenance-statements/).

---

## The bootstrap problem

`statenest` does not exist on the registry. Two mechanisms that would otherwise
be ideal both refuse to help:

> **Trusted publishing** — "The package you're configuring must already exist on
> the npm registry." Under Prerequisites: "Package must exist."
> — [`npm trust` documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

> **Staged publishing** — "The package **already exists** on the npm registry —
> you cannot stage a brand-new package."
> — [staged publishing documentation](https://docs.npmjs.com/staged-publishing/)

So the first version has to be published some other way, and only afterwards can
the automated path be configured. This is npm's model, not a gap in our setup.

### What we do about it

**One interactive publish, by the maintainer, with 2FA. No token is created.**

```bash
npm login          # opens a browser, 2FA, short-lived session
npm whoami         # confirm the right account
npm publish --access public
```

`npm login` issues a session that expires by itself, and 2FA is enforced on the
publish. Nothing durable is created, nothing has to be stored, and nothing has to
be revoked afterwards.

This publish will **not** carry provenance. Provenance requires OIDC from a
cloud-hosted CI runner, which by definition cannot be the bootstrap. Version
0.1.0 will therefore be the only StateNest release without a provenance
attestation, and that is expected rather than a defect.

### Fallback, if an interactive publish is impossible

Create a **granular access token** scoped to write only this package, publish
once, then revoke it immediately. Write-scoped tokens now expire in 7 days by
default and 90 days at most, so even a forgotten one dies on its own.

Prefer the interactive path. A token is a credential that can be copied; a
browser session is not.

---

## Target state: every release after the first

```
git tag v0.1.1  ──▶  GitHub Actions  ──▶  release:check  ──▶  npm  ──▶  provenance
```

Implemented in [.github/workflows/release.yml](../../.github/workflows/release.yml).
No secret is stored in the repository, because there is no secret: the workflow
authenticates with a GitHub OIDC token minted for that run.

Requirements, all satisfied by the workflow:

| Requirement | How it is met |
| --- | --- |
| npm CLI **11.5.1+** and Node **22.14.0+** | `node-version: '24'`, plus an explicit npm version assertion that fails loudly |
| `id-token: write` | Granted on the release job only, nowhere else in the repository |
| GitHub-hosted runner | `runs-on: ubuntu-latest`. Self-hosted runners are not supported by npm |
| `repository` field in `package.json` matching where it publishes from, **case-sensitively** | `git+https://github.com/Emin4ik/StateNest.git`, verified by `npm run check:metadata` |
| Workflow filename registered with npm | `release.yml` |
| Environment (optional) | `release`, which also gives a manual approval gate |

Provenance is automatic under trusted publishing — "you don't need to add the
`--provenance` flag" — but the workflow passes it anyway, because the provenance
documentation asks for it explicitly and being explicit costs nothing.

---

## Configuring the trusted publisher (after 0.1.0 exists)

Either through the website:

1. npmjs.com → the `statenest` package → **Settings** → **Trusted Publisher**
2. Choose **GitHub Actions**
3. Organization or user: `Emin4ik`
4. Repository: `StateNest`
5. Workflow filename: `release.yml` — *filename only, not a path*
6. Environment: `release` (must match the workflow exactly, or be left blank)

Or from the CLI, which does the same thing:

```bash
npm trust github --workflow release.yml --environment release
npm trust list
```

Then, under the package's publishing access settings, select
**"Require two-factor authentication and disallow tokens"**. Once trusted
publishing works, no token should be able to publish this package at all.

---

## Verifying provenance afterwards

Do not assume the workflow produced an attestation — check.

```bash
# The npm page for the package shows a "Provenance" panel naming the
# repository, the workflow and the commit it was built from.
open https://www.npmjs.com/package/statenest

# From a clean install, verify signatures and attestations:
mkdir /tmp/statenest-verify && cd /tmp/statenest-verify
npm init -y >/dev/null
npm install statenest
npm audit signatures
```

`npm audit signatures` reports verified registry signatures and verified
attestations. A published-with-provenance package shows a verified attestation;
0.1.0, published by hand, will show a signature but no attestation.

---

## What is deliberately not done

- **No long-lived publish token.** Classic tokens no longer exist, and a
  granular one is only a fallback for a single bootstrap publish.
- **No publishing from `main` pushes.** Releases are tag-driven or manually
  dispatched, never a side effect of merging.
- **No second, weaker validation path.** The workflow runs
  `npm run release:check`, the same gate used locally and in CI.
