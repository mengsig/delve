import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DomainError } from '../../shared/errors';
import { openDatabase, type Db } from '../db/connection';
import { addWorkspace } from '../db/workspaces';
import { ProviderRunner } from '../providers/runner';
import { cachedGithubRepository, githubRepository } from './github-cache';
import { RepositoryLearning } from './service';

vi.mock('./github-cache', async original => ({
  ...await original<typeof import('./github-cache')>(), cachedGithubRepository: vi.fn(), githubRepository: vi.fn(),
}));

let root: string;
let upstream: string;
let cache: string;
let workspaceId: string;
let db: Db;
let learning: RepositoryLearning;

function commit(value: number) {
  const data = (text: string) => 'data ' + Buffer.byteLength(text) + '\n' + text + '\n';
  const parent = value > 1 ? 'from refs/heads/main^0\n' : '';
  const record = 'commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> ' + (1000000000 + value)
    + ' +0000\n' + data('Revision ' + value) + parent + 'M 100644 inline value.ts\n' + data('export const value = ' + value + ';\n') + '\ndone\n';
  execFileSync('git', ['-C', upstream, 'fast-import', '--quiet'], { input: record });
  return execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'delve-refresh-'));
  upstream = join(root, 'upstream.git');
  cache = join(root, 'snapshot.git');
  execFileSync('git', ['init', '--bare', '--quiet', '--template=', '--initial-branch=main', upstream]);
  commit(1);
  execFileSync('git', ['clone', '--bare', '--quiet', '--template=', upstream, cache]);
  vi.mocked(cachedGithubRepository).mockResolvedValue(cache);
  vi.mocked(githubRepository).mockImplementation(async () => {
    execFileSync('git', ['-C', cache, 'fetch', '--quiet', '--update-head-ok', upstream, '+HEAD:refs/heads/main']);
    return cache;
  });
  db = openDatabase(':memory:');
  workspaceId = addWorkspace(db, { kind: 'github', owner: 'octo', repo: 'dispatch' }).id;
  learning = new RepositoryLearning(db, root, new ProviderRunner({ resolveProvider: async () => { throw new Error('Unexpected generation'); } }));
});

afterEach(async () => {
  await learning.close();
  db.close();
  vi.resetAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('reads a newly pushed linked commit and prepares its approved source after one refresh per cache miss', async () => {
  const detailRef = commit(2);
  const detail = { workspaceId, kind: 'commit' as const, ref: detailRef };
  expect(await learning.detail(detail)).toMatchObject({ node: { head: detailRef, title: 'Revision 2' } });
  expect(githubRepository).toHaveBeenCalledTimes(1);
  await learning.detail(detail);
  expect(githubRepository).toHaveBeenCalledTimes(1);
  const next = commit(3);
  const preview = await learning.preview({ workspaceId, selection: { kind: 'commit', ref: next }, depth: 'high', provider: 'codex' });
  expect(preview).toMatchObject({ commit: next, files: ['value.ts'] });
  expect(preview.prompt).toContain('+export const value = 3;');
  expect(githubRepository).toHaveBeenCalledTimes(2);
  await expect(learning.detail({ ...detail, ref: 'f'.repeat(40) })).rejects.toThrow('unavailable');
  expect(githubRepository).toHaveBeenCalledTimes(3);
});

it('picks up new default-branch commits on explicit refresh and keeps cached history after a failed fetch', async () => {
  const latest = commit(2);
  const request = { workspaceId, cursor: 0, kind: 'commit' as const };
  const initial = await learning.history(request);
  expect(initial.nodes.map(node => node.title)).toEqual(['Revision 1']);
  expect(githubRepository).not.toHaveBeenCalled();
  const refreshed = await learning.history({ ...request, refreshSnapshot: true });
  expect(refreshed.nodes[0]?.ref).toBe(latest);
  expect(refreshed.warning).toBeNull();
  expect(githubRepository).toHaveBeenCalledTimes(1);
  vi.mocked(githubRepository).mockRejectedValueOnce(new DomainError('GITHUB_FETCH_FAILED', 'Snapshot fetch failed.'));
  const offline = await learning.history({ ...request, refreshSnapshot: true });
  expect(offline.nodes).toEqual(refreshed.nodes);
  expect(offline.warning).toContain('Snapshot fetch failed. Showing the last local snapshot.');
});
