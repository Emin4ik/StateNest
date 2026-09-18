/**
 * Every piece of project identity, in one place.
 *
 * These values appear in `package.json`, the plugin manifest, the marketplace
 * manifest, the README, SECURITY.md, the generated JSON Schemas and an error
 * message in the CLI. Scattered, they are guaranteed to drift, and a forgotten
 * example URL in a published artifact is the kind of thing nobody notices until
 * a user reports a 404.
 *
 * `scripts/check-metadata.mjs` verifies that everything else agrees with this
 * file and treats any remaining placeholder as a release blocker.
 * `scripts/sync-metadata.mjs` propagates a change here into every consumer.
 *
 * Settled 2026-09-18. `statenest` was verified free on npm, PyPI, Homebrew,
 * Arch and the AUR, absent from PATH, and unclaimed on GitHub apart from the
 * owner's own repository: docs/research/final-name-selection.md.
 */

/** True only while a name and owner have not been chosen. */
export const METADATA_IS_PLACEHOLDER = false;

/** True only while `PACKAGE_NAME` is known to belong to someone else. */
export const NAME_IS_KNOWN_TAKEN = false;

export const PACKAGE_NAME = 'statenest';
export const CLI_COMMAND = 'statenest';
export const DISPLAY_NAME = 'StateNest';

/**
 * How a user installs this, as printed in `statenest doctor` fixes and error
 * hints.
 *
 * Hardcoding it once meant seven user-facing messages named a package that
 * belonged to someone else. It is derived now, and check-metadata fails if a
 * literal install command reappears in src/.
 */
export const INSTALL_COMMAND = `npm install -g ${PACKAGE_NAME}`;

/** GitHub owner and repository. */
export const REPOSITORY_OWNER = 'Emin4ik';
export const REPOSITORY_NAME = 'StateNest';

export const REPOSITORY_URL = `https://github.com/${REPOSITORY_OWNER}/${REPOSITORY_NAME}`;
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;
export const SECURITY_ADVISORY_URL = `${REPOSITORY_URL}/security/advisories/new`;
export const HOMEPAGE_URL = `${REPOSITORY_URL}#readme`;

/**
 * Namespace for generated JSON Schema `$id` values.
 *
 * Deliberately the repository URL rather than a domain: a domain is one more
 * thing to own, renew and keep serving, and the schemas are useful without one
 * resolving.
 */
export const SCHEMA_ID_BASE = `${REPOSITORY_URL}/blob/main/schemas`;

/** The license, which must match the LICENSE file and package.json. */
export const LICENSE = 'MIT';
