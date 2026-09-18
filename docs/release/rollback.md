# When a release goes wrong

## The one rule

**Never try to replace a published version.** Do not unpublish and republish
`0.1.0`. Do not delete a version to "fix" it.

npm forbids reusing a version number, and for good reason: someone's lockfile
already pins `statenest@0.1.0` to a specific tarball hash. Replacing it breaks
their build in a way they cannot diagnose, and unpublishing breaks it outright.
`npm unpublish` is also only permitted within 72 hours and only when nothing
depends on the package — so it is both harmful and usually unavailable.

The fix is always the same shape: **deprecate, fix, bump, publish.**

---

## A bad release

```bash
# 1. Tell everyone who installs it. The message is shown on every install
#    and on the npm page, so make it useful.
npm deprecate statenest@0.1.0 \
  "Broken on Windows: paths with spaces fail to scan. Fixed in 0.1.1."

# 2. Fix it on main, with a regression test. This is not optional - a bad
#    release that ships again is worse than the first one.

# 3. Bump the version deliberately. Patch for a fix, minor for behaviour.
npm version patch --no-git-tag-version   # 0.1.0 -> 0.1.1
git add package.json package-lock.json
git commit -m "Release 0.1.1"
git push origin main

# 4. Tag it. The release workflow does the rest.
git tag -a v0.1.1 -m "StateNest v0.1.1"
git push origin v0.1.1
```

The workflow refuses to publish if the tag and `package.json` disagree, and
refuses if the version already exists. Neither of those checks can be skipped.

### Deprecating a whole range

```bash
npm deprecate statenest@"<0.1.3" "Data-loss bug in sync. Upgrade to 0.1.3."
```

### Undoing a deprecation

```bash
npm deprecate statenest@0.1.0 ""
```

---

## A security vulnerability

Same shape, different urgency and a different order — fix before you announce.

1. **Do not open a public issue.** Use
   [GitHub Security Advisories](https://github.com/Emin4ik/StateNest/security/advisories/new),
   which is private. Private vulnerability reporting is enabled on the
   repository.
2. **Draft the advisory first.** GitHub lets you work on a fix in a private fork
   attached to the advisory, so the patch is not visible before release.
3. **Fix, bump, publish** as above. Patch release unless the fix itself is
   breaking.
4. **Deprecate the affected versions**, pointing at the fixed one:
   ```bash
   npm deprecate statenest@"<0.1.4" "Security fix, see GHSA-xxxx. Upgrade to 0.1.4."
   ```
5. **Publish the advisory.** GitHub will request a CVE if you ask it to, and the
   advisory then feeds `npm audit` and Dependabot, which is how most people will
   find out.
6. **Only unpublish if a credential leaked into the tarball.** That is the one
   case where the content itself is the problem rather than its behaviour — and
   even then, treat the credential as compromised and rotate it, because the
   tarball has already been mirrored.

### If a publish credential is compromised

There is no long-lived publish token to steal — releases authenticate with a
short-lived OIDC token minted per workflow run. If the npm *account* is
compromised:

1. Change the npm password and re-enrol 2FA.
2. `npm token list` and revoke anything unexpected.
3. Check the package's trusted publisher configuration still names only
   `Emin4ik/StateNest` and `release.yml` — an attacker with account access could
   add their own repository.
4. Review the package's version history for anything you did not publish.

---

## What not to do

| Tempting | Why not |
| --- | --- |
| `npm unpublish statenest@0.1.0` and republish | Breaks every lockfile pinning that version. Only allowed within 72 hours anyway |
| Move the `v0.1.0` tag to a new commit | The published tarball does not move with it. The tag now lies about what was released |
| Publish `0.1.0-fixed` | Not a valid semver ordering — a prerelease sorts *below* `0.1.0`. Use `0.1.1` |
| Quietly bump and publish without deprecating | People already on the bad version never find out |
| Delete the GitHub Release | The npm tarball is what people install; removing the notes only hides the explanation |
