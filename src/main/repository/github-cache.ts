import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DomainError } from '../../shared/errors';
import { MAX_BLOB_BYTES } from './source-policy';
import { completedOutput, gitSource, type CommandResult } from './source-process';

const SNAPSHOT_ARGS = ['--no-tags', '--depth', '30', `--filter=blob:limit=${MAX_BLOB_BYTES + 1}`];
const GITHUB_TRANSPORT = [
  '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
  '-c', 'credential.https://github.com.helper=!gh auth git-credential',
  '-c', 'http.followRedirects=false', '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=10',
  '-c', 'fetch.recurseSubmodules=false', '-c', 'fetch.writeCommitGraph=false',
  '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
];

const refreshes = new Map<string, Promise<string>>();

export function githubSlug(source: string): string {
  const match = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/([A-Za-z0-9._-]{1,100})$/.exec(source);
  if (!match || match[1] === '.' || match[1] === '..') {
    throw new DomainError('INVALID_WORKSPACE', 'Choose a GitHub repository in owner/name form.');
  }
  return source.toLowerCase();
}

function requireGitHubFetch(result: CommandResult): void {
  if (!result.truncated && result.status === 0) return;
  if (/\bgh: (?:not found|command not found)\b/i.test(result.diagnostic)) {
    throw new DomainError('GITHUB_CLI_REQUIRED', 'Install GitHub CLI and run gh auth login to read this repository.');
  }
  if (/returned error: (?:401|403)\b|authentication failed|could not read (?:username|password)|invalid username or token/i.test(result.diagnostic)) {
    throw new DomainError('GITHUB_AUTH_REQUIRED', 'Run gh auth login and make sure the account can read this repository.');
  }
  if (/repository not found/i.test(result.diagnostic)) {
    throw new DomainError('GITHUB_REPOSITORY_UNAVAILABLE', 'That GitHub repository was not found or the current GitHub account cannot access it.');
  }
  throw new DomainError('GITHUB_FETCH_FAILED', 'Could not download the GitHub repository snapshot. Check your connection and repository access.');
}

async function cachedDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  });
  if (info === null) return false;
  if (!info.isDirectory()) throw new DomainError('GITHUB_CACHE_FAILED', 'The repository cache entry is invalid.');
  return true;
}

async function refreshRepository(cacheRoot: string, destination: string, slug: string): Promise<string> {
  const url = `https://github.com/${slug}.git`;
  assert.ok(isAbsolute(cacheRoot) && isAbsolute(destination));
  assert.equal(githubSlug(slug), slug);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const options = { authenticated: true, cwd: cacheRoot, timeoutMs: 45_000, maxBytes: 128 * 1024 };
  if (await cachedDirectory(destination)) {
    const gitDir = ['--bare', `--git-dir=${destination}`];
    const head = await gitSource([...gitDir, 'symbolic-ref', '--quiet', 'HEAD'], { cwd: cacheRoot, maxBytes: 4096 });
    const branch = completedOutput(head, 'Could not identify the cached repository branch.').toString('utf8').trimEnd();
    if (!/^refs\/heads\/[^:\s]+$/.test(branch)) throw new DomainError('GITHUB_CACHE_FAILED', 'The cached repository branch is invalid.');
    requireGitHubFetch(await gitSource([...GITHUB_TRANSPORT, ...gitDir, 'fetch',
      '--no-auto-maintenance', '--no-recurse-submodules', ...SNAPSHOT_ARGS,
      '--update-head-ok', '--', url, `+HEAD:${branch}`], options));
    return destination;
  }

  const staging = await mkdtemp(join(cacheRoot, 'clone-'));
  try {
    requireGitHubFetch(await gitSource([...GITHUB_TRANSPORT, 'clone', '--bare', '--template=', '--single-branch',
      ...SNAPSHOT_ARGS, '--', url, staging], options));
    await rename(staging, destination).catch(async (cause: NodeJS.ErrnoException) => {
      const collision = cause.code === 'EEXIST' || cause.code === 'ENOTEMPTY';
      if (!collision || !await cachedDirectory(destination)) throw cause;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return destination;
}

export async function githubRepository(cacheRoot: string, source: string): Promise<string> {
  if (!isAbsolute(cacheRoot)) throw new DomainError('GITHUB_CACHE_FAILED', 'The repository cache needs an absolute path.');
  const slug = githubSlug(source);
  const key = createHash('sha256').update(slug).digest('hex');
  const destination = join(cacheRoot, `${key}.git`);
  const running = refreshes.get(destination);
  if (running) return running;
  const refresh = refreshRepository(cacheRoot, destination, slug);
  refreshes.set(destination, refresh);
  try {
    return await refresh;
  } finally {
    refreshes.delete(destination);
  }
}
