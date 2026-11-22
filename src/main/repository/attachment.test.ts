import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepoRequest } from '../../shared/repository';
import { openDatabase, type Db } from '../db/connection';
import { addWorkspace, listWorkspaces } from '../db/workspaces';
import { upsertConcept } from '../db/concepts';
import { recordEvidence } from '../db/evidence';
import { ProviderRunner } from '../providers/runner';
import { makeShimDir, makeTempDir, setupRunner } from '../providers/test-helpers';
import { RepositoryLearning } from './service';
import { listFiles, readFiles, repositoryPath } from './source';

vi.mock('./source', () => ({ listFiles: vi.fn(), readFiles: vi.fn(), repositoryPath: vi.fn() }));
const commit = 'f'.repeat(40);
let db: Db;
let learning: RepositoryLearning;
const runner = new ProviderRunner({ resolveProvider: async () => { throw new Error('Unexpected provider call'); } });

beforeEach(() => {
  db = openDatabase(':memory:');
  learning = new RepositoryLearning(db, '/cache', runner);
  vi.mocked(listFiles).mockResolvedValue({ commit, partial: false, files: [{ path: 'main.rs', bytes: 12 }] });
  vi.mocked(readFiles).mockResolvedValue([{ path: 'main.rs', text: 'fn main() {}' }]);
  vi.mocked(repositoryPath).mockResolvedValue('/objects');
});
afterEach(async () => { await learning.close(); db.close(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

it('prepares the exact request from a pinned snapshot before attaching a workspace or running the provider', async () => {
  const staged = await learning.stage({ kind: 'github', owner: 'example', repo: 'test' });
  const request: RepoRequest = { workspaceId: staged.workspace.id, selection: { kind: 'baseline', paths: ['main.rs'], commit },
    depth: 'medium', provider: 'codex' };
  const preview = await learning.preview(request);
  expect(preview.prompt).toContain('fn main() {}');
  expect(preview.files).toEqual(['main.rs']);
  expect(preview.bytes).toBe(Buffer.byteLength(preview.prompt));
  expect(repositoryPath).toHaveBeenCalledTimes(1);
  expect(listWorkspaces(db).workspaces).toHaveLength(0);
  await expect(learning.generate(preview.token, randomUUID())).rejects.toMatchObject({ code: 'UNCONFIRMED_REPO' });
  expect(learning.attach(preview.token).id).toBe(staged.workspace.id);
  expect(listWorkspaces(db).activeId).toBe(staged.workspace.id);
  expect(() => learning.attach(preview.token)).toThrow(/Refresh/);
  expect(listWorkspaces(db).workspaces).toHaveLength(1);
});

it('rejects unlisted paths and stale approval tokens without creating a workspace', async () => {
  const staged = await learning.stage({ kind: 'git', path: '/repo' });
  await expect(learning.preview({ workspaceId: staged.workspace.id, provider: 'claude', depth: 'high',
    selection: { kind: 'baseline', commit, paths: ['other.txt'] } })).rejects.toMatchObject({ code: 'INVALID_SLICE' });
  expect(readFiles).not.toHaveBeenCalled();
  expect(() => learning.attach(randomUUID())).toThrow(/Refresh/);
  expect(listWorkspaces(db).activeId).toBeNull();
});

it('includes global verified depths before a repository is attached', async () => {
  const prior = addWorkspace(db, { kind: 'git', path: '/prior' });
  const tcp = upsertConcept(db, { key: 'tcp', title: 'TCP', portable: true, workspaceId: prior.id });
  recordEvidence(db, { conceptId: tcp.id, workspaceId: prior.id, depth: 'medium', status: 'demonstrated',
    source: 'check', masteryVerified: true });
  const staged = await learning.stage({ kind: 'git', path: '/other' });
  const request: Omit<RepoRequest, 'depth'> = { workspaceId: staged.workspace.id, provider: 'codex',
    selection: { kind: 'baseline', paths: ['main.rs'], commit } };
  const preview = await learning.preview({ ...request, depth: 'medium' });
  const topUp = await learning.preview({ ...request, depth: 'low' });
  expect(preview.prompt).toContain('worker-lease-transport requiring tcp');
  expect(preview.prompt).toContain('"key":"tcp","title":"TCP","demonstratedDepth":"medium","known":true');
  expect(topUp.prompt).toContain('"key":"tcp","title":"TCP","demonstratedDepth":"medium","known":false');
});

it('uses the Codex config model for repository generation and reports account rejection', async () => {
  const home = await makeTempDir('repo-config');
  const record = join(home, 'request.json');
  await writeFile(join(home, 'config.toml'), 'model = "gpt-test"\n');
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('DELVE_CODEX_MODEL', undefined);
  const { runner: fakeRunner } = await setupRunner(await makeShimDir(), {
    FAKE_PROVIDER_MODE: 'model-rejected', FAKE_PROVIDER_RECORD: record,
  });
  await learning.close();
  learning = new RepositoryLearning(db, '/cache', fakeRunner);
  const staged = await learning.stage({ kind: 'github', owner: 'example', repo: 'test' });
  const preview = await learning.preview({ workspaceId: staged.workspace.id, provider: 'codex', depth: 'medium',
    selection: { kind: 'baseline', commit, paths: ['main.rs'] } });
  expect(preview).toMatchObject({ model: 'gpt-test', modelSource: 'codex-config' });
  learning.attach(preview.token);
  await expect(learning.generate(preview.token, randomUUID())).rejects.toMatchObject({
    code: 'PROVIDER_MODEL', message: expect.stringContaining('update the model in Codex config'),
  });
  const call = JSON.parse(await readFile(record, 'utf8')) as { argv: string[] };
  expect(call.argv.slice(call.argv.indexOf('--model'), call.argv.indexOf('--model') + 2)).toEqual(['--model', 'gpt-test']);
});

it.each(['codex', 'claude'] as const)('leaves the %s CLI default unpinned', async provider => {
  const home = await makeTempDir('repo-default');
  const record = join(home, 'request.json');
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('DELVE_CODEX_MODEL', undefined);
  vi.stubEnv('DELVE_CLAUDE_MODEL', undefined);
  const { runner: fakeRunner } = await setupRunner(await makeShimDir(), {
    FAKE_PROVIDER_MODE: 'model-rejected', FAKE_PROVIDER_RECORD: record,
  });
  await learning.close();
  learning = new RepositoryLearning(db, '/cache', fakeRunner);
  const staged = await learning.stage({ kind: 'github', owner: 'example', repo: 'test' });
  const preview = await learning.preview({ workspaceId: staged.workspace.id, provider, depth: 'medium',
    selection: { kind: 'baseline', commit, paths: ['main.rs'] } });
  expect(preview).toMatchObject({ model: null, modelSource: 'default' });
  learning.attach(preview.token);
  await expect(learning.generate(preview.token, randomUUID())).rejects.toMatchObject({ code: 'PROVIDER_MODEL' });
  const call = JSON.parse(await readFile(record, 'utf8')) as { argv: string[] };
  expect(call.argv).not.toContain('--model');
});
