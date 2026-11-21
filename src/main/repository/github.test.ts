import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/domain';
import { listChanges, readChange, repositoryPath } from './source';
import { listPullRequests } from './github';
import { gitSource, sourceCommand } from './source-process';

vi.mock('./source-process', async importOriginal => ({
  ...await importOriginal<typeof import('./source-process')>(), sourceCommand: vi.fn(), gitSource: vi.fn(),
}));

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const workspace: Workspace = {
  id: 'remote', name: 'Octo/Project', kind: 'github', source: 'Octo/Project', createdAt: '', lastOpenedAt: null,
};

const gh = vi.mocked(sourceCommand);
const git = vi.mocked(gitSource);
const OK = { status: 0, diagnostic: '', truncated: false };
const PR = { number: 42, title: 'Update module', head: { sha: HEAD }, base: { sha: BASE }, changed_files: 1 };
const FILE = { filename: 'src/module.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' };

function json(value: unknown) {
  return { ...OK, output: Buffer.from(JSON.stringify(value)) };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.resetAllMocks());

describe('GitHub pull requests', () => {
  it('uses fixed read-only GitHub arguments and canonicalizes repository names', async () => {
    gh.mockResolvedValueOnce(json([{ number: 42, title: 'Fix issue' }]));
    expect(await listPullRequests('Octo/Project')).toEqual([{ kind: 'pr', ref: '42', title: 'Fix issue' }]);
    expect(gh).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      'repos/octo/project/pulls?state=all&sort=updated&direction=desc&per_page=25'], expect.objectContaining({ authenticated: true }));
  });

  it('includes complete patches and binds them to the pull request head', async () => {
    gh.mockResolvedValueOnce(json(PR)).mockResolvedValueOnce(json([FILE])).mockResolvedValueOnce(json(PR));
    const snapshot = await readChange('unused', workspace, 'pr', '42');
    expect(snapshot).toEqual({ commit: HEAD, title: 'Update module', partial: false, files: ['src/module.ts'],
      diff: '--- a/src/module.ts\n+++ b/src/module.ts\n@@ -1 +1 @@\n-old\n+new\n' });
  });

  it('marks missing, truncated, excluded and unlisted files partial', async () => {
    const metadata = { ...PR, changed_files: 6 };
    gh.mockResolvedValueOnce(json(metadata)).mockResolvedValueOnce(json([
      FILE,
      { ...FILE, filename: 'binary.png', patch: undefined },
      { ...FILE, filename: 'truncated.js', patch: '@@ -1 +1 @@\n-old' },
      { ...FILE, filename: 'renamed.js', previous_filename: '.env', status: 'renamed' },
      { ...FILE, filename: 'miscount.js', additions: 2 },
    ])).mockResolvedValueOnce(json(metadata));
    const result = await readChange('unused', workspace, 'pr', '42');
    expect(result).toMatchObject({ commit: HEAD, partial: true, files: ['src/module.ts'] });
    expect(result.diff).not.toContain('renamed.js');
  });

  it('reports partial coverage if the GitHub patch output exceeds its byte limit', async () => {
    gh.mockResolvedValueOnce(json(PR)).mockResolvedValueOnce({ ...OK, truncated: true, output: Buffer.alloc(0) });
    await expect(readChange('unused', workspace, 'pr', '42')).resolves.toMatchObject({ commit: HEAD, partial: true, files: [], diff: '' });
  });

  it('rejects a pull request that moves during the read', async () => {
    gh.mockResolvedValueOnce(json(PR)).mockResolvedValueOnce(json([FILE])).mockResolvedValueOnce(json({ ...PR, head: { sha: BASE } }));
    await expect(readChange('unused', workspace, 'pr', '42')).rejects.toMatchObject({ code: 'GITHUB_PULL_REQUEST_MOVED' });
  });
});

describe('GitHub request failures', () => {
  it('reports auth failures without exposing CLI diagnostics', async () => {
    gh.mockResolvedValueOnce({ ...OK, status: 1, diagnostic: 'gh: Bad credentials (HTTP 401) TOKEN=private', output: Buffer.alloc(0) });
    await expect(listPullRequests(workspace.source)).rejects.toMatchObject({
      code: 'GITHUB_AUTH_REQUIRED', message: 'Run gh auth login to read GitHub pull requests.',
    });
  });

  it('keeps local commit options visible when GitHub authentication is unavailable', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'delve-pr-warning-'));
    try {
      git.mockResolvedValueOnce({ ...OK, output: Buffer.from(`${HEAD}\n`) })
        .mockResolvedValueOnce({ ...OK, output: Buffer.from(`${HEAD}\0Local commit\0`) });
      gh.mockResolvedValueOnce({ ...OK, status: 1, diagnostic: 'gh: Bad credentials (HTTP 401)', output: Buffer.alloc(0) });
      await expect(listChanges(repo, workspace)).resolves.toEqual({
        changes: [{ kind: 'commit', ref: HEAD, title: 'Local commit' }],
        warning: 'Run gh auth login to read GitHub pull requests.',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects invalid slugs and pull request references before spawning gh', async () => {
    await expect(listPullRequests('https://github.com/octo/project')).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    await expect(readChange('unused', workspace, 'pr', '42/files')).rejects.toMatchObject({ code: 'INVALID_PULL_REQUEST' });
    expect(gh).not.toHaveBeenCalled();
  });
});

describe('GitHub object cache', () => {
  it('deduplicates a shallow bare clone and fetches only the remote HEAD when reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delve-cache-test-'));
    try {
      git.mockResolvedValue({ ...OK, output: Buffer.alloc(0) });
      const [first, second] = await Promise.all([repositoryPath(workspace, root), repositoryPath(workspace, root)]);
      expect(first).toBe(second);
      expect(git).toHaveBeenCalledTimes(1);
      expect(git.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['clone', '--bare', '--depth', '30',
        'credential.https://github.com.helper=!gh auth git-credential', 'https://github.com/octo/project.git']));
      git.mockResolvedValueOnce({ ...OK, output: Buffer.from('refs/heads/main\n') });
      expect(await repositoryPath(workspace, root)).toBe(first);
      expect(git.mock.calls[2]?.[0]).toEqual(expect.arrayContaining(['fetch', '--no-recurse-submodules', '+HEAD:refs/heads/main']));
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans a failed clone stage and keeps the error actionable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delve-cache-test-'));
    try {
      git.mockResolvedValueOnce({ ...OK, status: 128, diagnostic: 'fatal: could not read Username', output: Buffer.alloc(0) });
      await expect(repositoryPath(workspace, root)).rejects.toMatchObject({ code: 'GITHUB_AUTH_REQUIRED' });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
