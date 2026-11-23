import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { listChanges, readChange, readChangeDetail, repositorySnapshotPath, repositoryPath } from './source';
import { listPullRequests } from './github';
import { openRepositoryHistory } from './history';
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
const PR = { body: 'Keep the new module in sync.', number: 42, title: 'Update module', head: { sha: HEAD }, base: { sha: BASE }, changed_files: 1 };
const PULL = { ...PR, created_at: '2024-01-02T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', state: 'closed',
  merged_at: '2024-01-03T00:00:00Z', closed_at: '2024-01-03T00:00:00Z', user: { login: 'octocat' },
  head: { ...PR.head, ref: 'topic' }, base: { ...PR.base, ref: 'main' }, additions: 8, deletions: 2 };
const FILE = { filename: 'src/module.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' };

function jsonText(value: string) { return { ...OK, output: Buffer.from(value) }; }

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
    expect(snapshot).toEqual({ commit: HEAD, base: BASE, description: PR.body, repository: 'octo/project', title: 'Update module', partial: false, files: ['src/module.ts'],
      diff: '--- a/src/module.ts\n+++ b/src/module.ts\n@@ -1 +1 @@\n-old\n+new\n' });
  });

  it('lists pull requests for a local GitHub origin without forwarding its URL to gh', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'delve-pr-origin-'));
    try {
      git.mockResolvedValueOnce(jsonText(HEAD + '\n')).mockResolvedValueOnce(jsonText(HEAD + '\0Commit\0'))
        .mockResolvedValueOnce(jsonText('git@github.com:Octo/Project.git\n'));
      gh.mockResolvedValueOnce(json([{ number: 42, title: 'Local origin PR' }]));
      const result = await listChanges(repo, { ...workspace, kind: 'git', source: repo });
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0]?.kind).toBe('pr');
      expect(gh.mock.calls[0]?.[1].at(-1)).toContain('repos/octo/project/pulls?');
    } finally { await rm(repo, { recursive: true, force: true }); }
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

describe('GitHub explorer', () => {
  it('shows GitHub login guidance once when both history sources need the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delve-history-login-'));
    try {
      git.mockResolvedValueOnce({ ...OK, status: 1, diagnostic: 'gh: not found', output: Buffer.alloc(0) });
      gh.mockRejectedValueOnce(new DomainError('GITHUB_CLI_REQUIRED', 'Install GitHub CLI and run gh auth login.'));
      const history = await openRepositoryHistory(workspace, root,
        { workspaceId: workspace.id, cursor: 0, refreshSnapshot: true }, []);
      const page = await history.advance(() => 1);
      expect(page.pullStatus).toBe('unavailable');
      expect(page.warning).toBe('Install GitHub CLI and run gh auth login to read this repository.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads later pull request pages and uses created dates and a head link', async () => {
    gh.mockResolvedValueOnce(json(Array.from({ length: 25 }, (_, i) => ({ ...PULL, number: i + 1 }))))
      .mockResolvedValueOnce(json([PULL]));
    const history = await openRepositoryHistory(workspace, '/cache', { workspaceId: workspace.id, kind: 'pr', cursor: 0, search: '#42' }, []);
    expect(await history.advance(() => 1)).toMatchObject({ nodes: [], next: 1, warning: null, pullStatus: 'available' });
    expect(gh).toHaveBeenCalledTimes(1);
    const second = await history.advance(() => 2);
    expect(second).toMatchObject({ next: null, warning: null, pullStatus: 'available' });
    expect(second.nodes.at(-1)).toMatchObject({ ref: '42', author: 'octocat', date: PULL.created_at, head: HEAD,
      parents: [HEAD], branches: ['main', 'topic'], baseBranch: 'main', headBranch: 'topic', state: 'merged' });
    expect(gh.mock.calls[1]?.[1].at(-1)).toContain('sort=created&direction=desc&per_page=25&page=2');
  });

  it('distinguishes auth failures from empty pulls and skips GitHub reads for commit-only history', async () => {
    const request = { workspaceId: workspace.id, kind: 'pr' as const, cursor: 0 };
    gh.mockResolvedValueOnce({ ...OK, status: 1, diagnostic: 'gh: Bad credentials (HTTP 401)', output: Buffer.alloc(0) });
    gh.mockResolvedValueOnce(json([]));
    const denied = await openRepositoryHistory(workspace, '/cache', request, []);
    expect(await denied.advance(() => 1)).toMatchObject({ nodes: [], next: null, pullStatus: 'unavailable',
      warning: 'Run gh auth login to read GitHub pull requests.' });
    const empty = await openRepositoryHistory(workspace, '/cache', request, []);
    expect(await empty.advance(() => 1)).toMatchObject({ nodes: [], next: null, warning: null, pullStatus: 'empty' });

    const repo = await mkdtemp(join(tmpdir(), 'delve-history-origin-'));
    try {
      await mkdir(join(repo, '.git'));
      git.mockResolvedValueOnce(jsonText('git@github.com:Octo/Project.git\n'))
        .mockResolvedValueOnce(jsonText(`${HEAD}\tmain\t\n`))
        .mockResolvedValueOnce(jsonText(HEAD + '\n'))
        .mockResolvedValueOnce(jsonText(HEAD + '\0'))
        .mockResolvedValueOnce(jsonText('false\n'))
        .mockResolvedValueOnce(jsonText([HEAD, '', 'Octocat', '2024-01-01T00:00:00Z', 'Commit', ''].join('\0')));
      const commits = await openRepositoryHistory({ ...workspace, source: repo, kind: 'git' }, '/cache',
        { ...request, kind: 'commit' }, []);
      expect(await commits.advance(() => 1)).toMatchObject({ nodes: [{ ref: HEAD }], next: null, pullStatus: 'unchecked' });
      expect(git.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining(['--skip=0', '--max-count=33', HEAD]));
      expect(gh).toHaveBeenCalledTimes(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

});

describe('GitHub explorer source and detail', () => {
  it('initializes a missing object store for an accepted commit link and reuses it offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delve-linked-commit-'));
    try {
      git.mockResolvedValueOnce(jsonText(''));
      const path = await repositorySnapshotPath(workspace, root);
      expect(git.mock.calls[0]?.[0]).toContain('clone');
      expect(await repositorySnapshotPath(workspace, root)).toBe(path);
      expect(git).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the existing local snapshot without fetching for commit-only GitHub history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delve-history-github-cache-'));
    try {
      git.mockResolvedValueOnce(jsonText(''));
      await repositoryPath(workspace, root);
      git.mockClear();
      git.mockResolvedValueOnce(jsonText(`${HEAD}\tmain\t\n`))
        .mockResolvedValueOnce(jsonText(HEAD + '\n'))
        .mockResolvedValueOnce(jsonText(HEAD + '\0'))
        .mockResolvedValueOnce(jsonText('true\n'))
        .mockResolvedValueOnce(jsonText([HEAD, '', 'Octocat', '2024-01-01T00:00:00Z', 'Commit', ''].join('\0')));
      const history = await openRepositoryHistory(workspace, root, { workspaceId: workspace.id, cursor: 0, kind: 'commit' }, []);
      expect(await history.advance(() => 1)).toMatchObject({
        nodes: [{ ref: HEAD }], next: null, pullStatus: 'unchecked', warning: expect.stringContaining('shallow snapshot'),
      });
      expect(git.mock.calls.map(([args]) => args[3])).toEqual(['for-each-ref', 'rev-parse', 'log', 'rev-parse', 'log']);
      expect(git.mock.calls[2]?.[0]).toContain('--no-walk=unsorted');
      expect(gh).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps GitHub totals and dates when available patches are incomplete', async () => {
    gh.mockResolvedValueOnce(json({ ...PULL, changed_files: 3 }))
      .mockResolvedValueOnce(json([FILE, { ...FILE, filename: 'photo.png', patch: null }]))
      .mockResolvedValueOnce(json({ ...PULL, changed_files: 3 }));
    const detail = await readChangeDetail(null, workspace, 'pr', '42');
    expect(detail).toMatchObject({ base: BASE, node: { state: 'merged' }, mergedAt: PULL.merged_at, closedAt: PULL.closed_at,
      fileCount: 3, additions: 8, deletions: 2, partial: true });
    expect(detail.statsCoverage).toBeUndefined();
    expect(detail.files).toEqual([
      { path: FILE.filename, patch: expect.stringContaining('@@ -1 +1 @@') }, { path: 'photo.png', patch: null },
    ]);
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
