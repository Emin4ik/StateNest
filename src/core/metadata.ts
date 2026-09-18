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
 * ---------------------------------------------------------------------------
 * THESE ARE PLACEHOLDERS, AND THE PACKAGE NAME IS KNOWN TO BE UNUSABLE.
 * See docs/research/project-name.md. Nothing may be published until they are
 * replaced; the check script refuses a release until then.
 * ---------------------------------------------------------------------------
 */

/** Set to false in the same commit that replaces the values below. */
export const METADATA_IS_PLACEHOLDER = true;

/**
 * Whether `PACKAGE_NAME` is known to be unavailable.
 *
 * Researched 2026-09-18: `project-brain` on npm is an actively maintained
 * product in this same category (v0.30.0, 57 versions, ~914 downloads/week),
 * `getprojectbrain.com` is a paid commercial app using the literal name, and
 * "project brain" has become the generic term competitors use to describe the
 * category. This is not a squat that can be disputed. The full evidence and a
 * ranked set of alternatives are in docs/research/project-name.md.
 */
export const NAME_IS_KNOWN_TAKEN = true;

export const PACKAGE_NAME = 'project-brain';
export const CLI_COMMAND = 'pb';
export const DISPLAY_NAME = 'Project Brain';

/**
 * GitHub owner and repository.
 *
 * Deliberately not a plausible-looking name. A placeholder that reads like a
 * real URL is the one that survives into a release, and it would point users at
 * a namespace belonging to someone else.
 */
export const REPOSITORY_OWNER = 'OWNER-NOT-CHOSEN';
export const REPOSITORY_NAME = 'REPO-NOT-CHOSEN';

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
