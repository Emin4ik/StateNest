/**
 * Directories a scan never descends into.
 *
 * The list is aggressive on purpose. A single unpruned `node_modules` can hold
 * more directory entries than the rest of a developer's home combined, and
 * nothing inside a dependency cache is ever a project the user is working on.
 *
 * Users can extend this through `discovery.exclude` in config.yaml; nothing
 * here can be removed, because descending into these would make a scan
 * unusably slow rather than merely incomplete.
 */
export const ALWAYS_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  // Dependency trees and package caches
  'node_modules',
  'bower_components',
  'vendor',
  '.pnpm-store',
  '.yarn',
  '.bundle',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.nuget',
  '.cpan',
  '.gem',
  'Pods',
  'Carthage',

  // Virtual environments
  '.venv',
  'venv',
  'env',
  'virtualenv',
  '.tox',
  '.conda',
  'site-packages',

  // Build output
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.parcel-cache',
  '.turbo',
  '.angular',
  'DerivedData',
  'Library',
  'Temp',

  // Tool caches and state
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.terraform',
  '.serverless',
  '.vagrant',
  '.docker',
  '.ollama',
  '__pycache__',
  '.ipynb_checkpoints',
  '.sass-cache',
  'coverage',
  '.nyc_output',

  // Git internals. A `.git` directory is detected as a marker, never entered.
  '.git',
  '.hg',
  '.svn',
  '.bzr',

  // Editor and OS metadata
  '.idea',
  '.vscode-server',
  '.Trash',
  '.trash',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.DocumentRevisions-V100',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.PreviousSystemInformation',

  // Package manager and runtime homes that are not user projects
  '.npm',
  '.nvm',
  '.deno',
  '.bun',
  '.local',
  '.asdf',
  '.rbenv',
  '.pyenv',
  '.sdkman',
  '.nix-profile',

  // Project Brain's own data
  '.project-brain',
]);

/**
 * Absolute paths that are never scanned even if a user names them as a root.
 *
 * These are either system trees with nothing of the user's in them, or -
 * in the case of the cloud-sync and mail directories - places where a
 * recursive walk triggers on-demand downloads of gigabytes of files.
 */
export const SYSTEM_PATH_PREFIXES: readonly string[] = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/System',
  '/private/var/vm',
  '/Volumes/Recovery',
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
  'C:/$Recycle.Bin',
];

/** Home-relative directories skipped by default when scanning a whole home dir. */
export const HOME_RELATIVE_SKIPS: readonly string[] = [
  'Library',
  'Applications',
  'Music',
  'Movies',
  'Pictures',
  'AppData',
  'OneDrive',
  'Dropbox',
  'Google Drive',
  'iCloud Drive (Archive)',
  'Creative Cloud Files',
];

/**
 * Files that identify a directory as the root of a project even when it is not
 * a git repository. Ordered by how confidently each implies a project type.
 */
export const PROJECT_MARKERS: ReadonlyArray<{ file: string; type: string }> = [
  { file: 'package.json', type: 'node' },
  { file: 'deno.json', type: 'node' },
  { file: 'pyproject.toml', type: 'python' },
  { file: 'setup.py', type: 'python' },
  { file: 'requirements.txt', type: 'python' },
  { file: 'Pipfile', type: 'python' },
  { file: 'go.mod', type: 'go' },
  { file: 'Cargo.toml', type: 'rust' },
  { file: 'pom.xml', type: 'java' },
  { file: 'build.gradle', type: 'java' },
  { file: 'build.gradle.kts', type: 'java' },
  { file: 'Gemfile', type: 'ruby' },
  { file: 'composer.json', type: 'php' },
  { file: 'Package.swift', type: 'swift' },
  { file: 'CMakeLists.txt', type: 'cpp' },
  { file: 'Makefile', type: 'cpp' },
  { file: 'docker-compose.yml', type: 'docker' },
  { file: 'docker-compose.yaml', type: 'docker' },
  { file: 'Dockerfile', type: 'docker' },
  { file: 'main.tf', type: 'terraform' },
  { file: 'ProjectSettings', type: 'unity' },
];

/**
 * Filenames whose *contents* are never read by Project Brain.
 *
 * The scanner reads a small number of files to work out what a project is
 * (package.json, README titles). This list is the hard boundary on that: a
 * matching name is skipped before it is opened, not filtered afterwards.
 */
export const SECRET_FILENAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..*/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^.*\.keystore$/i,
  /^.*\.jks$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^.*\.ppk$/i,
  /^credentials.*/i,
  /^secrets?.*/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.dockercfg$/i,
  /^\.git-credentials$/i,
  /^service-account.*\.json$/i,
  /^.*\.kdbx$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
  /^.*\.asc$/i,
  /^.*\.gpg$/i,
  /^terraform\.tfstate.*/i,
  /^.*\.tfvars$/i,
];

/**
 * True when a file must never be opened by Project Brain.
 *
 * Filename matching alone is not sufficient protection - the output scanner in
 * src/security handles the rest - but it is the cheapest layer and it stops
 * the obvious cases before any read happens.
 */
export function isSecretFilename(name: string): boolean {
  return SECRET_FILENAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function isAlwaysExcludedDir(name: string): boolean {
  return ALWAYS_EXCLUDED_DIRS.has(name);
}
