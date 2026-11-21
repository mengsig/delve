import assert from 'node:assert/strict';
import { z } from 'zod';
import { DomainError } from '../../shared/errors';
import { githubSlug } from './github-cache';
import { changeTitle, type ChangeSnapshot, type GitChange } from './git-reader';
import { isSourcePath, MAX_DIFF_BYTES, MAX_DIFF_FILES, MAX_PATCH_BYTES, OBJECT_ID, sourceText } from './source-policy';
import { sourceCommand } from './source-process';

const prNumber = z.number().int().positive().max(9_999_999_999);
const prSummary = z.object({ number: prNumber, title: z.string() });
const gitId = z.object({ sha: z.string().regex(OBJECT_ID) });
const prMetadata = prSummary.extend({
  base: gitId, head: gitId, changed_files: z.number().int().nonnegative(),
});
const prFile = z.object({
  filename: z.string(), previous_filename: z.string().nullish(), status: z.string(),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), patch: z.string().nullish(),
});
const PATCH_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed']);

function githubError(diagnostic: string): DomainError {
  if (/HTTP 401|gh auth login|authentication required|bad credentials/i.test(diagnostic)) {
    return new DomainError('GITHUB_AUTH_REQUIRED', 'Run gh auth login to read GitHub pull requests.');
  }
  if (/rate limit/i.test(diagnostic)) return new DomainError('GITHUB_RATE_LIMIT', 'GitHub temporarily limited pull request reads.');
  if (/HTTP 403|HTTP 404/i.test(diagnostic)) {
    return new DomainError('GITHUB_ACCESS_DENIED', 'The pull request or repository is unavailable to the current GitHub account.');
  }
  return new DomainError('GITHUB_READ_FAILED', 'Could not read pull requests from GitHub.');
}

async function githubApi<T>(endpoint: string, schema: z.ZodType<T>): Promise<T> {
  assert.ok(endpoint.startsWith('repos/'));
  assert.ok(/^[A-Za-z0-9._/?=&-]+$/.test(endpoint));
  const result = await sourceCommand('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
    authenticated: true, timeoutMs: 12_000, maxBytes: 2 * 1024 * 1024,
  });
  if (result.truncated) throw new DomainError('SOURCE_LIMIT', 'GitHub pull request output exceeded the read limit.');
  if (result.status !== 0) throw githubError(result.diagnostic);
  let json: unknown;
  try {
    json = JSON.parse(result.output.toString('utf8'));
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new DomainError('GITHUB_READ_FAILED', 'GitHub returned an invalid response.');
    throw cause;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new DomainError('GITHUB_READ_FAILED', 'GitHub returned unexpected pull request data.');
  return parsed.data;
}

export async function listPullRequests(source: string): Promise<GitChange[]> {
  const slug = githubSlug(source);
  const pulls = await githubApi(`repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=25`, z.array(prSummary).max(25));
  return pulls.map(({ number, title }) => ({ kind: 'pr', ref: String(number), title: changeTitle(title) }));
}

function completeHunks(patch: string, expectedAdded: number, expectedRemoved: number): boolean {
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('@@ ')) {
      const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!header || oldRemaining !== 0 || newRemaining !== 0) return false;
      oldRemaining = Number(header[1] ?? 1);
      newRemaining = Number(header[2] ?? 1);
      hunks++;
      continue;
    }
    if (hunks === 0) return false;
    if (line === '\\ No newline at end of file') continue;
    if (line[0] === ' ') {
      oldRemaining--;
      newRemaining--;
    } else if (line[0] === '+') {
      newRemaining--;
      added++;
    } else if (line[0] === '-') {
      oldRemaining--;
      removed++;
    } else {
      return false;
    }
    if (oldRemaining < 0 || newRemaining < 0) return false;
  }
  return hunks > 0 && oldRemaining === 0 && newRemaining === 0 && added === expectedAdded && removed === expectedRemoved;
}

function pullPatch(file: z.infer<typeof prFile>): string | null {
  const { filename, previous_filename: previous, patch, status } = file;
  if (!isSourcePath(filename) || (previous != null && !isSourcePath(previous)) || !patch) return null;
  if (!PATCH_STATUSES.has(status) || ((status === 'renamed' || status === 'copied') && !previous)) return null;
  const oldPath = status === 'added' ? '/dev/null' : `a/${previous ?? filename}`;
  const newPath = status === 'removed' ? '/dev/null' : `b/${filename}`;
  const text = `--- ${oldPath}\n+++ ${newPath}\n${patch.replace(/\n$/, '')}\n`;
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES || sourceText(Buffer.from(text)) === null) return null;
  return completeHunks(patch, file.additions, file.deletions) ? text : null;
}

export async function readPullRequest(source: string, ref: string): Promise<ChangeSnapshot> {
  const slug = githubSlug(source);
  if (!/^[1-9][0-9]{0,9}$/.test(ref)) throw new DomainError('INVALID_PULL_REQUEST', 'Choose a positive GitHub pull request number.');
  const endpoint = `repos/${slug}/pulls/${ref}`;
  const before = await githubApi(endpoint, prMetadata);
  assert.equal(before.number, Number(ref));
  const result: ChangeSnapshot = { commit: before.head.sha, title: changeTitle(before.title), diff: '', partial: false, files: [] };
  let files: z.infer<typeof prFile>[];
  try {
    files = await githubApi(`${endpoint}/files?per_page=${MAX_DIFF_FILES}`, z.array(prFile).max(MAX_DIFF_FILES));
  } catch (cause) {
    if (cause instanceof DomainError && cause.code === 'SOURCE_LIMIT') return { ...result, partial: true };
    throw cause;
  }
  const after = await githubApi(endpoint, prMetadata);
  if (before.number !== after.number || before.head.sha !== after.head.sha || before.base.sha !== after.base.sha
    || before.changed_files !== after.changed_files) {
    throw new DomainError('GITHUB_PULL_REQUEST_MOVED', 'The pull request changed during the read. Refresh and try again.');
  }
  result.partial = files.length !== before.changed_files;
  const names = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (names.has(file.filename)) {
      result.partial = true;
      continue;
    }
    names.add(file.filename);
    const patch = pullPatch(file);
    const patchBytes = patch ? Buffer.byteLength(patch) : 0;
    if (!patch || bytes + patchBytes > MAX_DIFF_BYTES) {
      result.partial = true;
      continue;
    }
    result.files.push(file.filename);
    result.diff += patch;
    bytes += patchBytes;
  }
  assert.ok(bytes <= MAX_DIFF_BYTES);
  assert.ok(result.files.length <= MAX_DIFF_FILES);
  return result;
}
