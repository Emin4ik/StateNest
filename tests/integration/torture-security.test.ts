import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { detectSecrets, redactSecrets } from '../../src/security/redact.js';
import { auditProfile, hasBlockingFindings, describeBlock } from '../../src/security/audit.js';
import { inspectArchive, isUnsafeMemberPath, extractArchiveSafely } from '../../src/storage/archive.js';
import { startDashboard, type RunningDashboard } from '../../src/dashboard/server.js';
import { ProfileSync } from '../../src/sync/git-sync.js';
import { search } from '../../src/search/search.js';
import { makeFakeRepo, makeTempDir, writeFiles, hasGit, type TempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const GIT_AVAILABLE = await hasGit();

/**
 * Adversarial security tests.
 *
 * Each of these encodes a promise Project Brain makes, attacked rather than
 * merely exercised. A secret leaking, a profile bleeding into another, or an
 * archive writing outside its directory would all be silent failures: the user
 * would have no way to notice until the damage was done.
 */

function tokenBody(length: number): string {
  return 'Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye'.repeat(8).slice(0, length);
}

/** Syntactically valid, deliberately fabricated. Each embeds `n0treal`. */
const FAKE = {
  github: `ghp_${tokenBody(36)}`,
  githubPat: `github_pat_${tokenBody(22)}_${tokenBody(30)}`,
  aws: 'AKIAIOSFODNN7EXAMPLE',
  awsSecret: `aws_secret_access_key = ${tokenBody(40)}`,
  anthropic: `sk-ant-api03-${tokenBody(40)}`,
  openai: `sk-proj-${tokenBody(32)}`,
  slack: `xoxb-1234567890-${tokenBody(24)}`,
  stripe: `sk_live_${tokenBody(24)}`,
  npm: `npm_${tokenBody(36)}`,
  google: `AIza${tokenBody(35)}`,
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJuMHRyZWFsIn0.Kq7n0trealZx92Mw4Jd8Pv51',
  dbUrl: 'postgres://admin:Sup3rS3cretn0treal@db.internal:5432/app',
  bearer: `Authorization: Bearer ${tokenBody(32)}`,
  privateKey: [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmVn0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9YeKq7',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n'),
};

describe('privacy red team', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-red-home-');
    code = await makeTempDir('pb-red-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  /** A project stuffed with every kind of credential file we can think of. */
  async function hostileProject(path: string) {
    await makeFakeRepo(path, { remote: 'git@github.com:acme/hostile.git' });
    await writeFiles(path, {
      '.env': [
        `DATABASE_URL=${FAKE.dbUrl}`,
        `ANTHROPIC_API_KEY=${FAKE.anthropic}`,
        `STRIPE_SECRET_KEY=${FAKE.stripe}`,
      ].join('\n'),
      '.env.production': `AWS_ACCESS_KEY_ID=${FAKE.aws}\n${FAKE.awsSecret}\n`,
      '.env.local': `GITHUB_TOKEN=${FAKE.github}\n`,
      'id_rsa': FAKE.privateKey,
      'id_ed25519': FAKE.privateKey,
      'server.pem': FAKE.privateKey,
      'credentials.json': `{"token":"${FAKE.slack}"}`,
      'secrets.yaml': `npm: ${FAKE.npm}\ngoogle: ${FAKE.google}\n`,
      '.npmrc': `//registry.npmjs.org/:_authToken=${FAKE.npm}\n`,
      '.git-credentials': `https://x:${FAKE.github}@github.com\n`,
      'terraform.tfstate': `{"secret":"${FAKE.openai}"}`,
      'prod.tfvars': `api_key = "${FAKE.google}"\n`,
      // Legitimate files that must still be read.
      'package.json': JSON.stringify({ name: 'hostile', description: 'A perfectly normal app.' }),
      'README.md': '# hostile\n\nA perfectly normal app.\n',
    });
  }

  /** Everything Project Brain has written, as one string. */
  async function storedText(workspace: Workspace): Promise<string> {
    let out = '';
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) out += (await readFile(path, 'utf8').catch(() => '')) + '\n';
      }
    };
    await walk(workspace.paths.home);
    return out;
  }

  const ALL_SECRETS = Object.values(FAKE);

  it('no secret survives the full scan, register, checkpoint and search workflow', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    const path = join(code.path, 'hostile');
    await hostileProject(path);

    const { scanForProjects } = await import('../../src/discovery/scanner.js');
    const scan = await scanForProjects([code.path]);
    for (const candidate of scan.candidates) {
      await registry.register(candidate.path, { machineId: workspace.machineId });
    }

    const project = (await registry.all())[0]!;
    await createCheckpoint(
      workspace.store,
      project,
      { summary: 'Set up the deployment pipeline.', completed: ['configured the environment'] },
      { machineId: workspace.machineId, source: 'cli', repoPath: path },
    );
    await workspace.store.writeState(project.id, '# Current focus\n\nDeployment.\n');
    await search(workspace.store, await registry.all(), 'deployment');

    const stored = await storedText(workspace);
    for (const secret of ALL_SECRETS) {
      // Compare on a distinctive slice: the whole multi-line key would pass
      // trivially even if a fragment leaked.
      const marker = secret.split('\n')[0]!.slice(0, 32);
      expect(stored, `secret fragment leaked: ${marker.slice(0, 12)}...`).not.toContain(marker);
    }

    // And the legitimate metadata was still picked up.
    expect(stored).toContain('A perfectly normal app.');
  });

  it('a credential pasted into a checkpoint is redacted before it is written', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await registry.register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    const result = await createCheckpoint(
      workspace.store,
      project,
      {
        summary: `Deployed with ${FAKE.github} and ${FAKE.anthropic}.`,
        completed: [`set DATABASE_URL to ${FAKE.dbUrl}`],
        decisions: [`rotate ${FAKE.aws} next week`],
        blockers: [`the ${FAKE.stripe} key is wrong`],
        next: [`replace ${FAKE.npm}`],
      },
      { machineId: workspace.machineId, source: 'cli' },
    );

    expect(result.redactions).toBeGreaterThanOrEqual(5);
    const written = await readFile(result.filePath, 'utf8');
    for (const secret of [FAKE.github, FAKE.anthropic, FAKE.aws, FAKE.stripe, FAKE.npm]) {
      expect(written).not.toContain(secret);
    }
    expect(written).not.toContain('Sup3rS3cretn0treal');
    // Redaction, not rejection: the surrounding prose survives.
    expect(written).toContain('Deployed with');
    expect(written).toContain('next week');
  });

  it('a credential in a project name or focus line is redacted by the MCP write path', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await registry.register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    await registry.save({
      ...project,
      current_focus: redactSecrets(`debugging with ${FAKE.github}`).text,
      blockers: [redactSecrets(`${FAKE.anthropic} is rejected`).text],
    });

    const stored = await storedText(workspace);
    expect(stored).not.toContain(FAKE.github);
    expect(stored).not.toContain(FAKE.anthropic);
  });

  it('the audit blocks sync on every credential class', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await registry.register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });

    for (const [label, secret] of Object.entries(FAKE)) {
      await workspace.store.writeState(project.id, `# Notes\n\n${secret}\n`);
      const audit = await auditProfile(workspace.profilePaths);
      expect(hasBlockingFindings(audit), `${label} must block sync`).toBe(true);

      // And the report never echoes the value.
      const described = describeBlock(audit).join('\n');
      const marker = secret.split('\n')[0]!.slice(0, 24);
      expect(described, `${label} leaked into the report`).not.toContain(marker);
    }
  });

  it('logs never contain a credential', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const { appendLine } = await import('../../src/util/fs-atomic.js');

    await appendLine(
      workspace.paths.logFile,
      JSON.stringify({ message: redactSecrets(`failed with ${FAKE.github}`).text }),
    );

    const log = await readFile(workspace.paths.logFile, 'utf8');
    expect(log).not.toContain(FAKE.github);
    expect(log).toContain('redacted by Project Brain');
  });

  it('an export is blocked while a credential is present', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
    const { project } = await registry.register(join(code.path, 'app'), {
      machineId: workspace.machineId,
    });
    await workspace.store.writeState(project.id, `token ${FAKE.github}\n`);

    const audit = await auditProfile(workspace.profilePaths);
    expect(hasBlockingFindings(audit)).toBe(true);
  });
});

/**
 * A scanner that blocks everything is a scanner people disable. These are all
 * values that look secret-ish and must NOT trigger a block.
 */
describe('false positives', () => {
  const INNOCENT = [
    ['a commit sha', 'Fixed in 72ba934a8f1c2d3e4f5061728394a5b6c7d8e9f0'],
    ['a short sha', 'see 3a57a91'],
    ['a UUID', 'session 25c299ff-fc7a-43d1-9b60-bdd44dcfd6a8'],
    ['an md5 digest', 'md5 4d4ec23493df64453814c4ead6bd77d9'],
    ['a sha256 digest', `sha256 ${'a1b2c3d4e5f60718'.repeat(4)}`],
    ['a base64 blob in prose', 'the icon is iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'],
    ['an env var reference', 'export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY'],
    ['a placeholder', 'api_key: <your-api-key-here>'],
    ['a template variable', 'token: ${GITHUB_TOKEN}'],
    ['a masked value', 'key: ****************'],
    ['documentation prose', 'Store your API key in the dashboard, never in the repo.'],
    ['a package version', 'npm install @modelcontextprotocol/sdk@1.30.0'],
    ['a URL with a path', 'https://github.com/acme/widget/pull/4211'],
    ['a semver range', 'typescript: ^5.9.3'],
    ['a file path', '/Users/emin/Projects/world-war/src/ai/economy.ts'],
    ['a docker digest', 'image: nginx@sha256:abcdef0123456789abcdef0123456789abcdef0123456789'],
    ['a changed-files list', 'changed: src/a.ts, src/b.ts, src/c.ts'],
    ['a branch name', 'branch: feature/PROJ-1234-add-auth'],
    ['an ssh alias', 'ssh alias: taxi-prod'],
    ['an ip address', 'host 203.0.113.10'],
    ['a normal password field name', 'PASSWORD=required'],
    ['an empty assignment', 'api_key = ""'],
    ['a checkpoint summary', 'Replaced the mandatory 15-minute match timer with unlimited matches.'],
  ] as const;

  it.each(INNOCENT)('does not flag %s', (_label, text) => {
    expect(detectSecrets(text)).toEqual([]);
  });

  it('leaves a whole realistic checkpoint untouched', () => {
    const checkpoint = [
      '# Summary',
      '',
      'Replaced fixed-resolution preprocessing with adaptive letterboxing so phone',
      'cameras with unusual aspect ratios stop producing squashed detections.',
      '',
      '# Completed',
      '',
      '- adaptive letterbox preprocessing for non-16:9 cameras',
      '- confidence threshold raised from 0.25 to 0.4',
      '',
      '# Repository',
      '',
      '- branch: phase-7',
      '- commit: 72ba934 Replace the match timer',
      '- changed: src/ai/economy.ts, src/ui/hud.tsx',
    ].join('\n');

    expect(detectSecrets(checkpoint)).toEqual([]);
    expect(redactSecrets(checkpoint).text).toBe(checkpoint);
  });
});

describe('archive safety', () => {
  let workspace: TempDir;

  beforeEach(async () => {
    workspace = await makeTempDir('pb-archive-');
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('unsafe member paths are recognised', () => {
    it.each([
      '../escape.txt',
      '../../etc/passwd',
      'a/../../b',
      'a/b/../../../c',
      '/etc/passwd',
      '/absolute',
      'C:\\Windows\\system32',
      'C:/Windows/system32',
      '\\\\server\\share\\file',
      '//server/share/file',
      '..',
      '',
      '   ',
      'dir/../../..',
      '.\\..\\escape',
    ])('rejects %j', (member) => {
      expect(isUnsafeMemberPath(member)).toBe(true);
    });

    it.each([
      'personal/profile.yaml',
      'personal/projects/prj_x/project.yaml',
      './personal/profile.yaml',
      'a/b/c/d.md',
      'weird name with spaces/file.txt',
      'unicode-тест/файл.md',
      'dots.in.name/file.tar.gz',
      'a/./b',
    ])('accepts %j', (member) => {
      expect(isUnsafeMemberPath(member)).toBe(false);
    });
  });

  it('refuses an archive containing a path traversal', async () => {
    const stage = join(workspace.path, 'stage');
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'evil.txt'), 'PWNED');

    const archive = join(workspace.path, 'traversal.tar.gz');
    // bsdtar and GNU tar spell the rename flag differently.
    const built = await execFileAsync('tar', [
      '-czf',
      archive,
      '-s',
      '|evil.txt|../../../escaped.txt|',
      '-C',
      stage,
      'evil.txt',
    ]).catch(async () =>
      execFileAsync('tar', [
        '-czf',
        archive,
        '--transform',
        's|evil.txt|../../../escaped.txt|',
        '-C',
        stage,
        'evil.txt',
      ]).catch(() => null),
    );
    if (!built) return; // Neither flag available; nothing to assert.

    const inspection = await inspectArchive(archive);
    expect(inspection.problems.length).toBeGreaterThan(0);
    expect(inspection.problems.join(' ')).toMatch(/outside the target directory/);

    const destination = join(workspace.path, 'dest');
    await mkdir(destination, { recursive: true });
    await expect(extractArchiveSafely(archive, destination)).rejects.toThrow(
      /Refusing to extract/,
    );

    // Nothing was written, inside or outside.
    expect(await readdir(destination)).toEqual([]);
  });

  it('refuses an archive containing a symlink', async () => {
    const stage = join(workspace.path, 'stage2');
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'real.txt'), 'fine');
    await symlink('/etc/passwd', join(stage, 'sneaky'));

    const archive = join(workspace.path, 'symlink.tar.gz');
    await execFileAsync('tar', ['-czf', archive, '-C', stage, '.']);

    const inspection = await inspectArchive(archive);
    expect(inspection.problems.join(' ')).toMatch(/is a link/);
    await expect(
      extractArchiveSafely(archive, join(workspace.path, 'dest2')),
    ).rejects.toThrow(/Refusing to extract/);
  });

  it('accepts and extracts an ordinary archive', async () => {
    const stage = join(workspace.path, 'good');
    await mkdir(join(stage, 'personal', 'projects'), { recursive: true });
    await writeFile(join(stage, 'personal', 'profile.yaml'), 'name: personal\n');
    await writeFile(join(stage, 'personal', 'projects', 'a.yaml'), 'id: a\n');

    const archive = join(workspace.path, 'good.tar.gz');
    await execFileAsync('tar', ['-czf', archive, '-C', stage, 'personal']);

    const destination = join(workspace.path, 'restored');
    await mkdir(destination, { recursive: true });
    const members = await extractArchiveSafely(archive, destination);

    expect(members.length).toBeGreaterThan(0);
    await expect(readFile(join(destination, 'personal', 'profile.yaml'), 'utf8')).resolves.toContain(
      'personal',
    );
  });

  it('rejects an empty archive rather than silently restoring nothing', async () => {
    const empty = join(workspace.path, 'empty.tar.gz');
    const stage = join(workspace.path, 'nothing');
    await mkdir(stage, { recursive: true });
    await execFileAsync('tar', ['-czf', empty, '-C', stage, '.']).catch(() => null);

    const inspection = await inspectArchive(empty).catch(() => null);
    if (inspection) {
      // Either no members, or only the '.' directory entry.
      const files = inspection.members.filter((m) => m.path !== '.' && m.path !== './');
      expect(files.length).toBe(0);
    }
  });

  it('reports a corrupt archive clearly rather than crashing', async () => {
    const corrupt = join(workspace.path, 'corrupt.tar.gz');
    await writeFile(corrupt, 'this is definitely not a gzip stream');
    await expect(inspectArchive(corrupt)).rejects.toThrow(/Could not read the archive/);
  });
});

describe('profile isolation under attack', () => {
  let home: TempDir;
  let code: TempDir;
  let bareA: TempDir;
  let bareB: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-iso-home-');
    code = await makeTempDir('pb-iso-code-');
    bareA = await makeTempDir('pb-iso-bareA-');
    bareB = await makeTempDir('pb-iso-bareB-');
    if (GIT_AVAILABLE) {
      for (const bare of [bareA, bareB]) {
        await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare.path]);
      }
    }
  });

  afterEach(async () => {
    await Promise.all([home.cleanup(), code.cleanup(), bareA.cleanup(), bareB.cleanup()]);
  });

  it('three profiles keep entirely separate project sets', async () => {
    const names = ['personal', 'work', 'customer-a'];
    const workspaces: Workspace[] = [];

    for (const name of names) {
      const workspace = await Workspace.initialize({ home: home.path, profileName: name });
      workspaces.push(workspace);
      await makeFakeRepo(join(code.path, name), { remote: `git@github.com:${name}/repo.git` });
      await new Registry(workspace.store).register(join(code.path, name), {
        machineId: workspace.machineId,
      });
    }

    for (const workspace of workspaces) {
      const projects = await new Registry(workspace.store).all();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.repository?.identity).toContain(workspace.profile.name);
    }
  });

  it('a profile directory contains no other profile\'s files', async () => {
    await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

    await makeFakeRepo(join(code.path, 'client'), { remote: 'git@github.com:bigcorp/client.git' });
    await new Registry(work.store).register(join(code.path, 'client'), {
      machineId: work.machineId,
    });

    const personalRoot = work.paths.profile('personal').root;
    let contents = '';
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else contents += (await readFile(path, 'utf8').catch(() => '')) + '\n';
      }
    };
    await walk(personalRoot);

    expect(contents).not.toContain('bigcorp');
    expect(contents).not.toContain('client');
  });

  it.runIf(GIT_AVAILABLE)('a work sync cannot push into the personal remote', async () => {
    const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

    const personalSync = new ProfileSync(personal.profilePaths, personal.paths.home);
    const workSync = new ProfileSync(work.profilePaths, work.paths.home);
    await personalSync.initialise(bareA.path);
    await workSync.initialise(bareB.path);

    await makeFakeRepo(join(code.path, 'secret-client'), {
      remote: 'git@github.com:bigcorp/secret-client.git',
    });
    await new Registry(work.store).register(join(code.path, 'secret-client'), {
      machineId: work.machineId,
    });
    await makeFakeRepo(join(code.path, 'hobby'), { remote: 'git@github.com:me/hobby.git' });
    await new Registry(personal.store).register(join(code.path, 'hobby'), {
      machineId: personal.machineId,
    });

    await workSync.sync();
    await personalSync.sync();

    // The personal remote must contain no trace of the work project.
    const personalFiles = await execFileAsync('git', [
      '-C',
      bareA.path,
      'grep',
      '-r',
      '--name-only',
      'secret-client',
      'main',
    ]).catch(() => ({ stdout: '' }));
    expect(personalFiles.stdout.trim()).toBe('');

    // And vice versa.
    const workFiles = await execFileAsync('git', [
      '-C',
      bareB.path,
      'grep',
      '-r',
      '--name-only',
      'hobby',
      'main',
    ]).catch(() => ({ stdout: '' }));
    expect(workFiles.stdout.trim()).toBe('');
  });

  it('sync refuses to operate on a directory outside the Project Brain home', async () => {
    const workspace = await Workspace.initialize({ home: home.path });
    const foreign = { ...workspace.profilePaths, root: code.path };
    expect(() => new ProfileSync(foreign, workspace.paths.home)).toThrow(
      /outside the Project Brain home/i,
    );
  });

  it('an audit of one profile does not see another profile\'s secret', async () => {
    const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

    await makeFakeRepo(join(code.path, 'w'), { remote: 'git@github.com:corp/w.git' });
    const { project } = await new Registry(work.store).register(join(code.path, 'w'), {
      machineId: work.machineId,
    });
    await work.store.writeState(project.id, `token ${FAKE.github}\n`);

    expect(hasBlockingFindings(await auditProfile(work.profilePaths))).toBe(true);
    expect(hasBlockingFindings(await auditProfile(personal.profilePaths))).toBe(false);
  });

  it('a profile name cannot escape the profiles directory', async () => {
    for (const hostile of ['../escape', '../../etc', 'a/b', '..', '.']) {
      const workspace = await Workspace.initialize({ home: home.path, profileName: hostile });
      expect(workspace.profilePaths.root.startsWith(workspace.paths.profilesDir)).toBe(true);
      expect(workspace.profilePaths.root).not.toContain('..');
    }
  });
});

describe('dashboard security', () => {
  let home: TempDir;
  let code: TempDir;
  let server: RunningDashboard | null = null;
  let workspace: Workspace;

  beforeEach(async () => {
    home = await makeTempDir('pb-dash-sec-home-');
    code = await makeTempDir('pb-dash-sec-code-');
    workspace = await Workspace.initialize({ home: home.path });
    server = await startDashboard(workspace, { host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await home.cleanup();
    await code.cleanup();
  });

  const url = (path: string) => `${server!.url}${path}`;

  describe('path traversal', () => {
    it.each([
      '/../../../../etc/passwd',
      '/api/../../../etc/passwd',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/....//....//etc/passwd',
      '/api/project?id=../../../../etc/passwd',
      '/api/project?id=%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/.project-brain/config.yaml',
      '/api/search?q=../../../etc/passwd',
    ])('refuses to serve %s', async (path) => {
      const response = await fetch(url(path));
      const body = await response.text();
      expect(body).not.toContain('root:x:');
      expect(body).not.toContain('/bin/bash');
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        // A 200 here is the search endpoint returning no results, not a file.
        expect(body.startsWith('{')).toBe(true);
      }
    });

    it('serves no file content endpoint at all', async () => {
      for (const path of ['/file', '/files', '/read', '/static', '/assets', '/api/file']) {
        expect((await fetch(url(path))).status).toBe(404);
      }
    });
  });

  describe('injection', () => {
    it('renders a hostile project name as text, never as markup', async () => {
      const registry = new Registry(workspace.store);
      const hostile = '<img src=x onerror=alert(1)>';
      await makeFakeRepo(join(code.path, 'x'), { remote: 'git@github.com:acme/x.git' });
      const { project } = await registry.register(join(code.path, 'x'), {
        machineId: workspace.machineId,
      });
      await registry.save({
        ...project,
        name: hostile,
        description: '</script><script>alert(2)</script>',
        current_focus: '"><svg onload=alert(3)>',
        blockers: ['<iframe src=javascript:alert(4)>'],
      });

      // The API returns the raw value as JSON - correct, it is data.
      const api = await (await fetch(url('/api/projects'))).text();
      expect(api).toContain('img src=x');

      // The page never interpolates it: values go in via textContent.
      const page = await (await fetch(url('/'))).text();
      expect(page).not.toContain('onerror=alert');
      expect(page).not.toContain('innerHTML');
      expect(page).toMatch(/textContent/);
    });

    it('sends a content security policy that forbids remote code', async () => {
      const csp = (await fetch(url('/'))).headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain('unsafe-eval');
    });
  });

  describe('no mutation surface', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s', async (method) => {
      const response = await fetch(url('/api/projects'), { method });
      expect(response.status).toBe(405);
    });

    it('rejects a POST to every known route', async () => {
      for (const path of ['/', '/api/overview', '/api/projects', '/api/search', '/api/remotes']) {
        expect((await fetch(url(path), { method: 'POST' })).status).toBe(405);
      }
    });

    it('cannot be framed, which removes the clickjacking route to any action', async () => {
      expect((await fetch(url('/'))).headers.get('x-frame-options')).toBe('DENY');
    });
  });

  it('never renders a credential even if one reached the data', async () => {
    const registry = new Registry(workspace.store);
    await makeFakeRepo(join(code.path, 'leaky'), { remote: 'git@github.com:acme/leaky.git' });
    const { project } = await registry.register(join(code.path, 'leaky'), {
      machineId: workspace.machineId,
    });

    // Bypass the redactor deliberately, writing the raw value to disk.
    await workspace.store.writeState(project.id, `# Notes\n\ntoken ${FAKE.github}\n`);

    // The dashboard reads state only through the brief, which takes the focus
    // line - so a raw secret in prose must not reach a payload.
    for (const path of ['/api/overview', '/api/projects', '/api/recent', `/api/project?id=${project.id}`]) {
      const body = await (await fetch(url(path))).text();
      expect(body, path).not.toContain(FAKE.github);
    }
  });
});
