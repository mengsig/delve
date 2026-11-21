import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ChangeDetail, HistoryNode } from '../../shared/explorer';
import { DomainError } from '../../shared/errors';
import { githubSlug } from './github-cache';
import { changeTitle, withoutChangePatches, type ChangePatch, type ChangeSnapshot, type GitChange } from './git-reader';
import { isSourcePath, MAX_DIFF_BYTES, MAX_DIFF_FILES, MAX_PATCH_BYTES, OBJECT_ID, safeAuthor, safeBranch, sourceText } from './source-policy';
import { sourceCommand } from './source-process';

const prNumber = z.number().int().positive().max(9_999_999_999);
const prSummary = z.object({ number: prNumber, title: z.string() });
const gitId = z.object({ sha: z.string().regex(OBJECT_ID) });
const prMetadata = prSummary.extend({
  body: z.string().nullish(), base: gitId, head: gitId, changed_files: z.number().int().nonnegative(),
});
const prBranch = gitId.extend({ ref: z.string() });
const historyPull = prSummary.extend({
  created_at: z.iso.datetime(), state: z.enum(['open', 'closed']), merged_at: z.iso.datetime().nullable(),
  user: z.object({ login: z.string() }).nullable(), base: prBranch, head: prBranch,
});
const detailPull = prMetadata.extend(historyPull.shape).extend({
  closed_at: z.iso.datetime().nullable(), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
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

function pullNode(pull: z.infer<typeof historyPull>): HistoryNode {
  const { head, base, user, created_at: date, number, title, state, merged_at: mergedAt } = pull;
  assert.ok(OBJECT_ID.test(head.sha) && OBJECT_ID.test(base.sha));
  assert.ok(Number.isFinite(Date.parse(date)));
  const baseBranch = safeBranch(base.ref) ? base.ref : undefined;
  const headBranch = safeBranch(head.ref) ? head.ref : undefined;
  const branches = [...new Set([baseBranch, headBranch].filter(branch => branch !== undefined))];
  return { kind: 'pr', ref: String(number), title: changeTitle(title), author: safeAuthor(user?.login ?? ''),
    date, head: head.sha, parents: [head.sha], branches, baseBranch, headBranch, state: mergedAt ? 'merged' : state };
}

export async function readPullHistoryPage(source: string, page: number) {
  const slug = githubSlug(source);
  assert.ok(Number.isSafeInteger(page) && page > 0);
  const perPage = 25;
  const endpoint = `repos/${slug}/pulls?state=all&sort=created&direction=desc&per_page=${perPage}&page=${page}`;
  const pulls = await githubApi(endpoint, z.array(historyPull).max(perPage));
  assert.ok(pulls.length <= perPage);
  return { nodes: pulls.map(pullNode), next: pulls.length === perPage ? page + 1 : null };
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

async function readPullFiles<T extends z.infer<typeof prMetadata>>(source: string, ref: string, schema: z.ZodType<T>) {
  const slug = githubSlug(source);
  if (!/^[1-9][0-9]{0,9}$/.test(ref)) throw new DomainError('INVALID_PULL_REQUEST', 'Choose a positive GitHub pull request number.');
  const endpoint = `repos/${slug}/pulls/${ref}`;
  const before = await githubApi(endpoint, schema);
  if (before.number !== Number(ref)) throw new DomainError('GITHUB_READ_FAILED', 'GitHub returned the wrong pull request.');
  const description = before.body && sourceText(Buffer.from(before.body))?.trim().slice(0, 4000);
  let files: z.infer<typeof prFile>[];
  try {
    files = await githubApi(`${endpoint}/files?per_page=${MAX_DIFF_FILES}`, z.array(prFile).max(MAX_DIFF_FILES));
  } catch (cause) {
    if (!(cause instanceof DomainError)) throw cause;
    return { metadata: before, description: description || undefined, files: [], partial: true,
      coverageNote: 'Pull request metadata only. ' + cause.message };
  }
  const after = await githubApi(endpoint, schema);
  if (before.number !== after.number || before.head.sha !== after.head.sha || before.base.sha !== after.base.sha
    || before.changed_files !== after.changed_files) {
    throw new DomainError('GITHUB_PULL_REQUEST_MOVED', 'The pull request changed during the read. Refresh and try again.');
  }
  assert.equal(before.number, Number(ref));
  assert.ok(OBJECT_ID.test(before.head.sha) && OBJECT_ID.test(before.base.sha));
  return { metadata: before, description: description || undefined, ...collectPullPatches(files, before.changed_files) };
}

function collectPullPatches(files: z.infer<typeof prFile>[], total: number) {
  let partial = files.length !== total;
  const patches = new Map<string, string | null>();
  let bytes = 0;
  for (const file of files) {
    if (patches.has(file.filename) || !isSourcePath(file.filename)) {
      partial = true;
      continue;
    }
    const patch = pullPatch(file);
    const patchBytes = patch ? Buffer.byteLength(patch) : 0;
    const readable = patch !== null && bytes + patchBytes <= MAX_DIFF_BYTES;
    if (readable) bytes += patchBytes;
    else partial = true;
    patches.set(file.filename, readable ? patch : null);
  }
  assert.ok(bytes <= MAX_DIFF_BYTES);
  assert.ok(patches.size <= MAX_DIFF_FILES);
  return { partial, files: [...patches].map(([path, patch]) => ({ path, patch })), coverageNote: undefined };
}

export async function readPullRequest(source: string, ref: string): Promise<ChangeSnapshot> {
  return withoutChangePatches(await readPullRequestWithPatches(source, ref));
}

export async function readPullRequestWithPatches(source: string, ref: string): Promise<ChangeSnapshot & { patches: ChangePatch[] }> {
  const { metadata, description, files, partial, coverageNote } = await readPullFiles(source, ref, prMetadata);
  const patches = files.flatMap(file => file.patch === null ? [] : [{ path: file.path, patch: file.patch }]);
  assert.ok(patches.length <= files.length);
  assert.equal(String(metadata.number), ref);
  return { commit: metadata.head.sha, base: metadata.base.sha, title: changeTitle(metadata.title), description,
    files: patches.map(file => file.path), diff: patches.map(file => file.patch).join(''), patches, partial,
    ...(coverageNote ? { coverageNote } : {}) };
}

export async function readPullDetail(source: string, ref: string): Promise<ChangeDetail> {
  const { metadata, description, files, partial, coverageNote } = await readPullFiles(source, ref, detailPull);
  const node = pullNode(metadata);
  assert.equal(node.ref, ref);
  assert.ok(files.length <= MAX_DIFF_FILES);
  return { node, base: metadata.base.sha, description, files, partial,
    fileCount: metadata.changed_files, additions: metadata.additions, deletions: metadata.deletions,
    coverageNote: coverageNote ?? (partial ? 'Some file patches are unavailable. Totals are from GitHub.' : undefined),
    mergedAt: metadata.merged_at ?? undefined, closedAt: metadata.closed_at ?? undefined };
}
