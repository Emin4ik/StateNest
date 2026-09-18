# Release checklist

Work top to bottom. Anything that fails stops the release — there is no step
here whose failure is acceptable.

Background reading, once: [npm-publishing.md](npm-publishing.md) explains why
the first release is done by hand and every one after it is not.

---

## Before release

- [ ] **Clean tree.** `git status --porcelain` prints nothing.
- [ ] **On `main`, synced.** `git rev-parse HEAD` equals `git rev-parse origin/main`.
- [ ] **Release gate passes.** `npm run release:check` exits 0. This is the
      authoritative check — typecheck, lint, control bytes, build, the full test
      suite, schema drift, the packaged-artifact verification and the metadata
      gate.
- [ ] **CI is green on this exact commit.** Not on an earlier one.
      ```bash
      gh run list --limit 1 --json headSha,conclusion,url
      ```
      All ten jobs: Ubuntu / macOS / Windows × Node 22.12 and 24, three Package
      jobs, and the Release gate.
- [ ] **Version is correct and deliberate.** `package.json` `version` is what
      you mean to publish. Never let the workflow choose it.
- [ ] **CHANGELOG has an entry for this version**, and it is not still marked
      unreleased.
- [ ] **Release notes drafted.** For 0.1.0, [v0.1.0.md](v0.1.0.md).
- [ ] **Tarball inspected.**
      ```bash
      npm pack --dry-run --json --ignore-scripts
      ```
      Confirm: no `tests/`, no `src/`, no `.map`, no dev config, no logs, no
      local StateNest data, no credentials, no absolute paths from your machine.
- [ ] **The name is still available** (first release only).
      ```bash
      npm view statenest    # E404 means free
      ```

## Publish

### First release only — the bootstrap

Trusted publishing cannot be configured for a package that does not exist, so
0.1.0 is published by hand. This happens exactly once.

- [ ] **npm account exists and has 2FA enabled.** 2FA is enforced for publishing.
- [ ] **Log in.** `npm login` — opens a browser, issues a short-lived session.
      No token is created and nothing needs to be stored or revoked afterwards.
- [ ] **Confirm the account.** `npm whoami`
- [ ] **Publish.**
      ```bash
      npm publish --access public
      ```
      This version will carry no provenance attestation. That is expected:
      provenance requires OIDC from a CI runner, which the bootstrap cannot be.

### Every release after the first

- [ ] **Trusted publisher configured** (see below — one-time setup).
- [ ] **Tag it.** The tag must be `v` + the exact `package.json` version.
      ```bash
      git tag -a v0.1.1 -m "StateNest v0.1.1"
      git push origin v0.1.1
      ```
- [ ] **Approve the `release` environment** if you have added required reviewers.
- [ ] **Watch the run.** The workflow refuses a tag/version mismatch, refuses a
      version that already exists, runs the full release gate, and only then
      publishes.

### One-time: configure trusted publishing (immediately after 0.1.0 exists)

- [ ] npmjs.com → `statenest` → **Settings** → **Trusted Publisher** →
      **GitHub Actions**, with:
      - Organization or user: `Emin4ik`
      - Repository: `StateNest`
      - Workflow filename: `release.yml` *(filename only, no path)*
      - Environment: `release` *(must match the workflow, or be left blank)*

      Or equivalently: `npm trust github --workflow release.yml --environment release`
- [ ] **Lock out tokens.** In the package's publishing access settings, select
      **"Require two-factor authentication and disallow tokens"**. After this,
      only the trusted publisher can publish.
- [ ] `npm trust list` shows the configuration you expect and nothing else.

## GitHub

- [ ] **Create the release.** Attach the notes; do not paste the whole CHANGELOG.
      ```bash
      gh release create v0.1.0 \
        --repo Emin4ik/StateNest \
        --title "StateNest v0.1.0" \
        --notes-file docs/release/v0.1.0.md
      ```
- [ ] **Check the release page** renders and its links resolve.

## After release

- [ ] **It is really on the registry.**
      ```bash
      npm view statenest
      npm view statenest version
      npm view statenest dist-tags
      ```
- [ ] **Install from the real registry**, not from a local tarball, into a
      throwaway prefix:
      ```bash
      PREFIX="$(mktemp -d)"
      npm install -g --prefix "$PREFIX" statenest
      export PATH="$PREFIX/bin:$PATH"
      ```
- [ ] **Smoke test the installed binary.**
      ```bash
      statenest --version          # must print the version you just published
      statenest --help
      HOME="$(mktemp -d)" statenest init --yes
      HOME="$(mktemp -d)" statenest doctor
      ```
- [ ] **Exercise a real project**, in a throwaway home:
      ```bash
      SANDBOX="$(mktemp -d)"; export HOME="$SANDBOX"
      mkdir -p "$SANDBOX/code/demo" && cd "$SANDBOX/code/demo"
      git init -q && git remote add origin git@github.com:acme/demo.git
      echo '# demo' > README.md && git add -A
      git -c user.email=t@e.invalid -c user.name=T commit -qm init
      statenest init --yes
      statenest scan "$SANDBOX/code"
      statenest projects
      statenest checkpoint -m "First checkpoint from the published package."
      statenest resume demo
      ```
- [ ] **Verify provenance** (every release after 0.1.0).
      ```bash
      mkdir /tmp/verify && cd /tmp/verify && npm init -y >/dev/null
      npm install statenest
      npm audit signatures        # expect a verified attestation
      ```
      Also open the npm page and confirm the **Provenance** panel names
      `Emin4ik/StateNest`, `release.yml` and the commit you released.
      Do not assume the workflow produced one — look.
- [ ] **Switch the README to the npm install path** (first release only).
      ```bash
      npm run readme:published            # shows what it would change
      npm run readme:published -- --write
      git commit -am "README: install from npm" && git push
      ```
      The script refuses to run until the package is actually on the registry.
- [ ] **Watch for the first issues.** Most first-release problems are install
      and platform problems, and they arrive within a day.

---

## Repository settings

Reviewed 2026-09-18. Current state: public, default branch `main`, issues
enabled, private vulnerability reporting enabled, wiki and project boards
disabled, default workflow permissions read-only.

**Branch protection is deliberately not enabled yet.** It is the right thing for
`main` eventually, but turning it on carelessly on a solo repository means you
can no longer push to your own default branch, which is a bad surprise to
discover mid-release. When you want it, this is a configuration that protects
against broken code without making solo work painful:

```bash
gh api -X PUT repos/Emin4ik/StateNest/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=ubuntu-latest / node 22.12' \
  -f 'required_status_checks[contexts][]=windows-latest / node 22.12' \
  -f 'required_status_checks[contexts][]=macos-latest / node 22.12' \
  -f 'required_status_checks[contexts][]=Release gate' \
  -F 'enforce_admins=false' \
  -F 'required_pull_request_reviews=null' \
  -F 'restrictions=null' \
  -F 'allow_force_pushes=false' \
  -F 'allow_deletions=false'
```

What that does and does not do:

- **Requires CI to pass** before anything lands on `main`, which is the point.
- **`enforce_admins=false`** so you are not locked out of your own repository.
- **`required_pull_request_reviews=null`** so a solo maintainer is not blocked
  waiting for a reviewer who does not exist.
- **Blocks force pushes and deletion of `main`**, which are the two
  irreversible ones.

Verify it did what you expect, and that you can still work:

```bash
gh api repos/Emin4ik/StateNest/branches/main/protection | jq '{checks: .required_status_checks.contexts, admins: .enforce_admins.enabled}'
```

To remove it: `gh api -X DELETE repos/Emin4ik/StateNest/branches/main/protection`.

---

## If it goes wrong

[rollback.md](rollback.md). The short version: never replace a published
version — deprecate, fix, bump, publish.
