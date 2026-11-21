import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepoRequest } from '../../shared/repository';
import { openDatabase, type Db } from '../db/connection';
import { listWorkspaces } from '../db/workspaces';
import { ProviderRunner } from '../providers/runner';
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
afterEach(async () => { await learning.close(); db.close(); vi.resetAllMocks(); });

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
