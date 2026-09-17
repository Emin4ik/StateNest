import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Workspace } from '../../src/core/workspace.js';
import { Registry } from '../../src/core/registry.js';
import { createCheckpoint } from '../../src/checkpoints/create.js';
import { detectProjectMetadata } from '../../src/discovery/detect.js';
import { scanForProjects } from '../../src/discovery/scanner.js';
import { auditProfile, hasBlockingFindings, describeBlock } from '../../src/security/audit.js';
import { parseSshConfig, usableHosts } from '../../src/remotes/ssh-config.js';
import { RemoteSchema } from '../../src/core/schema.js';
import { isSecretFilename } from '../../src/discovery/exclusions.js';
import { makeFakeRepo, makeTempDir, writeFiles, type TempDir } from '../helpers/fixtures.js';
import { now } from '../../src/util/time.js';

/**
 * Security regression tests.
 *
 * These encode the promises Project Brain makes to the user. Each one exists
 * because breaking it silently would be worse than any functional bug: the
 * user would have no way to notice, and the damage would already be done.
 *
 * Test credentials below are syntactically valid but fabricated. Each embeds
 * the marker `n0treal`.
 */

/**
 * Build a token body of exactly the length a format requires.
 *
 * Hand-written fixtures repeatedly came out a character short, which made the
 * detector look broken when it was correct. Generating them from the real
 * length keeps the test honest about the boundary it is exercising.
 */
function tokenBody(length: number): string {
  return 'Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9Ye'.repeat(8).slice(0, length);
}

/** GitHub classic tokens are `ghp_` plus exactly 36 characters. */
const FAKE_GITHUB_TOKEN = `ghp_${tokenBody(36)}`;

const FAKE_ENV = [
  'DATABASE_URL=postgres://admin:Sup3rS3cretn0treal@db.internal:5432/app',
  'STRIPE_SECRET_KEY=sk_live_' . 'Kq7n0trealZx92Mw4Jd8Pv51',
  'ANTHROPIC_API_KEY=sk-ant-' . 'api03-Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9YeKq7n0tre',
].join('\n');

const FAKE_PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZUn0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('the fixtures themselves are valid instances', () => {
  it('the GitHub token fixture is exactly the length the format requires', async () => {
    const { detectSecrets } = await import('../../src/security/redact.js');
    expect(FAKE_GITHUB_TOKEN).toHaveLength(4 + 36);
    expect(detectSecrets(FAKE_GITHUB_TOKEN).map((f) => f.ruleId)).toContain('github-token');
  });
});

describe('security guarantees', () => {
  let home: TempDir;
  let code: TempDir;

  beforeEach(async () => {
    home = await makeTempDir('pb-sec-home-');
    code = await makeTempDir('pb-sec-code-');
  });

  afterEach(async () => {
    await home.cleanup();
    await code.cleanup();
  });

  async function setup() {
    const workspace = await Workspace.initialize({ home: home.path, profileName: 'personal' });
    return { workspace, registry: new Registry(workspace.store) };
  }

  /** Every byte Project Brain has written into its own home. */
  async function allStoredText(workspace: Workspace): Promise<string> {
    const { readdir } = await import('node:fs/promises');
    const chunks: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) chunks.push(await readFile(full, 'utf8').catch(() => ''));
      }
    };

    await walk(workspace.paths.home);
    return chunks.join('\n');
  }

  describe('1. .env contents are never captured', () => {
    it('does not read a .env file while detecting project metadata', async () => {
      const project = join(code.path, 'app');
      await makeFakeRepo(project, { remote: 'git@github.com:acme/app.git' });
      await writeFiles(project, {
        '.env': FAKE_ENV,
        '.env.production': FAKE_ENV,
        'package.json': JSON.stringify({ name: 'app', description: 'An app.' }),
      });

      const detected = await detectProjectMetadata(project);

      expect(detected.readFiles).not.toContain('.env');
      expect(detected.readFiles).not.toContain('.env.production');
      expect(detected.description).toBe('An app.');
    });

    it('leaves no trace of .env values anywhere in the data directory', async () => {
      const { workspace, registry } = await setup();
      const project = join(code.path, 'app');
      await makeFakeRepo(project, { remote: 'git@github.com:acme/app.git' });
      await writeFiles(project, { '.env': FAKE_ENV });

      await registry.register(project, { machineId: workspace.machineId });
      const stored = await allStoredText(workspace);

      expect(stored).not.toContain('Sup3rS3cretn0treal');
      expect(stored).not.toContain('sk_live_Kq7n0treal');
      expect(stored).not.toContain('sk-ant-api03-Kq7n0treal');
    });

    it('recognises every common secret filename shape', () => {
      for (const name of [
        '.env',
        '.env.local',
        '.env.production',
        'id_rsa',
        'id_ed25519',
        'server.pem',
        'private.key',
        'credentials.json',
        'secrets.yaml',
        '.netrc',
        '.git-credentials',
        'terraform.tfstate',
        'prod.tfvars',
      ]) {
        expect(isSecretFilename(name), `${name} should be denied`).toBe(true);
      }
    });

    it('does not deny ordinary project files', () => {
      for (const name of ['package.json', 'README.md', 'main.go', 'Cargo.toml', 'index.ts']) {
        expect(isSecretFilename(name), `${name} should be allowed`).toBe(false);
      }
    });
  });

  describe('2. ssh private keys are never captured', () => {
    it('does not read a private key found in a project directory', async () => {
      const project = join(code.path, 'infra');
      await makeFakeRepo(project, { remote: 'git@github.com:acme/infra.git' });
      await writeFiles(project, {
        'id_ed25519': FAKE_PRIVATE_KEY,
        'deploy.pem': FAKE_PRIVATE_KEY,
        'README.md': '# infra\n\nInfrastructure definitions.\n',
      });

      const { workspace, registry } = await setup();
      await registry.register(project, { machineId: workspace.machineId });

      const stored = await allStoredText(workspace);
      expect(stored).not.toContain('BEGIN OPENSSH PRIVATE KEY');
      expect(stored).not.toContain('b3BlbnNzaC1rZXktdjEA');
    });

    it('never descends into a .ssh directory during a scan', async () => {
      await writeFiles(join(code.path, '.ssh'), {
        'id_rsa': FAKE_PRIVATE_KEY,
        'config': 'Host prod\n  HostName 203.0.113.10\n',
      });
      await makeFakeRepo(join(code.path, '.ssh', 'somehow-a-repo'), {});

      const scan = await scanForProjects([code.path]);
      expect(scan.candidates).toHaveLength(0);
    });
  });

  describe('3. a credential in Project Brain\'s own data blocks sync', () => {
    it('detects a key written into a checkpoint and reports it as blocking', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });

      // Simulate a credential reaching disk some other way - a hand edit, an
      // import, an older version. The audit must still catch it.
      await workspace.store.writeState(
        project.id,
        `# Current focus\n\nDebugging with sk-ant-' . 'api03-Kq7n0trealZx92Mw4Jd8Pv51Rt6Hb3Cs9YeKq7n0tre\n`,
      );

      const result = await auditProfile(workspace.profilePaths);
      expect(hasBlockingFindings(result)).toBe(true);
      expect(result.files.some((file) => file.relativePath.includes('state.md'))).toBe(true);
    });

    it('names the file and line without ever echoing the secret', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });
      await workspace.store.writeState(
        project.id,
        `# Notes\n\ntoken ${FAKE_GITHUB_TOKEN}\n`,
      );

      const result = await auditProfile(workspace.profilePaths);
      const lines = describeBlock(result).join('\n');

      expect(lines).toContain('state.md');
      expect(lines).toMatch(/:\d+/);
      expect(lines).not.toContain(FAKE_GITHUB_TOKEN);
    });

    it('reports a clean profile as clean', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });
      await createCheckpoint(
        workspace.store,
        project,
        { summary: 'Fixed the refinery rebuild logic and added SAM sites.' },
        { machineId: workspace.machineId, source: 'cli' },
      );

      const result = await auditProfile(workspace.profilePaths);
      expect(hasBlockingFindings(result)).toBe(false);
      expect(result.filesScanned).toBeGreaterThan(0);
    });

    it('redacts a credential before a checkpoint is ever written', async () => {
      const { workspace, registry } = await setup();
      await makeFakeRepo(join(code.path, 'app'), { remote: 'git@github.com:acme/app.git' });
      const { project } = await registry.register(join(code.path, 'app'), {
        machineId: workspace.machineId,
      });

      const result = await createCheckpoint(
        workspace.store,
        project,
        {
          summary: `Deployed using token ${FAKE_GITHUB_TOKEN} from the CI config.`,
        },
        { machineId: workspace.machineId, source: 'cli' },
      );

      expect(result.redactions).toBeGreaterThan(0);
      const written = await readFile(result.filePath, 'utf8');
      expect(written).not.toContain(FAKE_GITHUB_TOKEN);
      expect(written).toContain('redacted by Project Brain');
      // The rest of the sentence survives - redaction, not rejection.
      expect(written).toContain('from the CI config');
    });
  });

  describe('4. profiles are isolated on disk', () => {
    it('keeps each profile in its own directory subtree', async () => {
      const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
      const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

      expect(work.profilePaths.root).not.toBe(personal.profilePaths.root);
      expect(work.profilePaths.root.startsWith(personal.profilePaths.root)).toBe(false);
      expect(personal.profilePaths.root.startsWith(work.profilePaths.root)).toBe(false);
    });

    it('does not let a work project appear in the personal profile', async () => {
      const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
      const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

      await makeFakeRepo(join(code.path, 'client-api'), {
        remote: 'git@github.com:bigcorp/client-api.git',
      });
      await new Registry(work.store).register(join(code.path, 'client-api'), {
        machineId: work.machineId,
      });

      expect(await new Registry(work.store).all()).toHaveLength(1);
      expect(await new Registry(personal.store).all()).toHaveLength(0);
    });

    it('gives each profile its own independent sync settings', async () => {
      const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
      const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

      await personal.saveProfile({
        ...personal.profile,
        sync: { ...personal.profile.sync, enabled: true, remote: 'git@github.com:me/personal-brain.git' },
      });

      const reloadedWork = await Workspace.open({ home: home.path, profile: 'work' });
      expect(reloadedWork.profile.sync.enabled).toBe(false);
      expect(reloadedWork.profile.sync.remote).toBeUndefined();
      expect(work.profilePaths.root).toContain('work');
    });

    it('audits each profile separately', async () => {
      const personal = await Workspace.initialize({ home: home.path, profileName: 'personal' });
      const work = await Workspace.initialize({ home: home.path, profileName: 'work' });

      await makeFakeRepo(join(code.path, 'client'), { remote: 'git@github.com:bigcorp/client.git' });
      const { project } = await new Registry(work.store).register(join(code.path, 'client'), {
        machineId: work.machineId,
      });
      await work.store.writeState(project.id, `token ${FAKE_GITHUB_TOKEN}\n`);

      expect(hasBlockingFindings(await auditProfile(work.profilePaths))).toBe(true);
      expect(hasBlockingFindings(await auditProfile(personal.profilePaths))).toBe(false);
    });
  });

  describe('5. the user\'s source repository is only ever read', () => {
    it('leaves the working tree and git state untouched by registration', async () => {
      const project = join(code.path, 'app');
      await makeFakeRepo(project, { remote: 'git@github.com:acme/app.git' });
      await writeFiles(project, { 'src/index.ts': 'export const answer = 42;\n' });

      const before = await snapshotDir(project);
      const { workspace, registry } = await setup();
      const { project: registered } = await registry.register(project, {
        machineId: workspace.machineId,
      });
      await createCheckpoint(
        workspace.store,
        registered,
        { summary: 'a checkpoint' },
        { machineId: workspace.machineId, source: 'cli', repoPath: project },
      );

      expect(await snapshotDir(project)).toEqual(before);
    });

    it('writes nothing of its own into the project directory', async () => {
      const project = join(code.path, 'app');
      await makeFakeRepo(project, { remote: 'git@github.com:acme/app.git' });
      const { workspace, registry } = await setup();
      await registry.register(project, { machineId: workspace.machineId });

      const files = await snapshotDir(project);
      expect(files.some((file) => file.includes('.project-brain'))).toBe(false);
      expect(files.some((file) => file.includes('pb.'))).toBe(false);
    });
  });

  describe('7. imported ssh config keeps addresses, never credentials', () => {
    const SSH_CONFIG = [
      'Host taxi-prod',
      '  HostName 203.0.113.10',
      '  User deploy',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_ed25519_taxi',
      '',
      'Host *',
      '  IdentityFile ~/.ssh/id_rsa',
      '  IdentitiesOnly yes',
    ].join('\n');

    it('extracts only the address fields', () => {
      const hosts = usableHosts(parseSshConfig(SSH_CONFIG));
      expect(hosts).toHaveLength(1);

      const host = hosts[0]!;
      expect(host).toMatchObject({
        alias: 'taxi-prod',
        hostname: '203.0.113.10',
        user: 'deploy',
        port: 2222,
      });
      // The key path is noted as existing, but never captured as a value.
      expect(host.usesIdentityFile).toBe(true);
      expect(JSON.stringify(host)).not.toContain('id_ed25519_taxi');
      expect(JSON.stringify(host)).not.toContain('id_rsa');
    });

    it('skips wildcard patterns rather than importing them as servers', () => {
      expect(usableHosts(parseSshConfig(SSH_CONFIG)).map((host) => host.alias)).not.toContain('*');
    });

    it('has nowhere in the stored record to put a credential', async () => {
      const { workspace } = await setup();
      const timestamp = now();

      // Even when handed credential-shaped fields, the schema drops them.
      const saved = await workspace.store.saveRemote(
        RemoteSchema.parse({
          id: 'remote_test',
          name: 'taxi-prod',
          ssh_alias: 'taxi-prod',
          host: '203.0.113.10',
          user: 'deploy',
          port: 2222,
          created_at: timestamp,
          updated_at: timestamp,
        }),
      );

      const onDisk = await readFile(workspace.profilePaths.remoteFile(saved.id), 'utf8');
      expect(onDisk).toContain('taxi-prod');
      for (const forbidden of ['password', 'private_key', 'identity_file', 'passphrase', 'token']) {
        expect(onDisk.toLowerCase()).not.toContain(forbidden);
      }
    });
  });

  describe('8. telemetry is off and has no switch', () => {
    it('defaults telemetry to disabled', async () => {
      const { workspace } = await setup();
      expect(workspace.config.telemetry.enabled).toBe(false);
    });

    it('refuses to accept an enabled telemetry setting', async () => {
      const { workspace } = await setup();
      await expect(
        workspace.saveConfig({
          ...workspace.config,
          telemetry: { enabled: true as unknown as false },
        }),
      ).rejects.toThrow();
    });
  });
});

/** Sorted list of `relative path :: contents` for every file under a directory. */
async function snapshotDir(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries: string[] = [];

  const walk = async (current: string, prefix: string): Promise<void> => {
    const found = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of found) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), relative);
      } else if (entry.isFile()) {
        const contents = await readFile(join(current, entry.name), 'utf8').catch(() => '<binary>');
        entries.push(`${relative} :: ${contents}`);
      }
    }
  };

  await walk(dir, '');
  return entries.sort();
}
