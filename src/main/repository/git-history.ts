import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryNode } from '../../shared/explorer';
import { DomainError } from '../../shared/errors';
import { changeTitle, gitReader, nulRecords, type GitReader } from './git-reader';
import { OBJECT_ID, safeBranch, safeAuthor } from './source-policy';
import { completedOutput } from './source-process';

const COMMIT_BATCH = 32;
const MAX_BRANCHES = 256;
const LOG = ['log', '--no-notes', '--no-show-signature', '--no-color', '--encoding=UTF-8',
  '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%s'];

function commitNodes(records: string[], labels: Map<string, string[]>): HistoryNode[] {
  const nodes: HistoryNode[] = [];
  for (let i = 0; i + 4 < records.length; i += 5) {
    const [ref, parentIds, author, date, title] = records.slice(i, i + 5) as [string, string, string, string, string];
    const parents = parentIds ? parentIds.split(' ') : [];
    assert.ok(OBJECT_ID.test(ref));
    assert.ok(parents.every(parent => OBJECT_ID.test(parent)));
    nodes.push({ kind: 'commit', ref, head: ref, title: changeTitle(title), author: safeAuthor(author),
      date: Number.isFinite(Date.parse(date)) ? date : '', parents, branches: labels.get(ref) ?? [] });
  }
  return nodes;
}

async function branchTips(reader: GitReader) {
  const result = await reader.run(['for-each-ref', `--count=${MAX_BRANCHES + 1}`,
    '--format=%(objectname)%09%(refname:lstrip=2)%09%(symref)', 'refs/heads', 'refs/remotes'], 512 * 1024);
  const lines = completedOutput(result, 'Could not read Git branches.').toString('utf8').split('\n').filter(Boolean);
  const branches = new Map<string, Set<string>>();
  const labels = new Map<string, string[]>();
  for (const line of lines.slice(0, MAX_BRANCHES)) {
    const [id, branch, symref, ...rest] = line.split('\t');
    assert.ok(id && OBJECT_ID.test(id));
    assert.ok(branch && symref !== undefined && rest.length === 0);
    if (symref || !safeBranch(branch)) continue;
    const tips = branches.get(branch) ?? new Set<string>();
    if (tips.has(id)) continue;
    tips.add(id);
    branches.set(branch, tips);
    labels.set(id, [...(labels.get(id) ?? []), branch]);
  }
  return { branches, labels, limited: lines.length > MAX_BRANCHES };
}

async function headTip(reader: GitReader): Promise<string | null> {
  const result = await reader.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], 1024);
  if (!result.truncated && result.status === 1) return null;
  const head = completedOutput(result, 'Could not read HEAD.').toString('utf8').trim();
  assert.ok(OBJECT_ID.test(head));
  assert.equal(head, head.toLowerCase());
  return head;
}

export async function gitHistoryNode(reader: GitReader, head: string): Promise<HistoryNode> {
  assert.ok(OBJECT_ID.test(head));
  const { labels } = await branchTips(reader);
  const result = await reader.run([...LOG, '--max-count=1', head, '--'], 1024 * 1024);
  if (!result.truncated) completedOutput(result, 'Could not read the Git commit metadata.');
  const [node] = commitNodes(nulRecords(result.output), labels);
  if (!node) throw new DomainError('SOURCE_LIMIT', 'The Git commit metadata exceeded the read limit.');
  assert.equal(node.head, head);
  return node;
}

interface BrokenBoundary {
  commit: string;
  missing: string;
  parents: string[];
}

interface GitHistoryBatch {
  nodes: HistoryNode[];
  next: number | null;
  warning?: string;
}

async function unreadableCommit(reader: GitReader, tips: string[], skip: number): Promise<string> {
  assert.ok(Number.isSafeInteger(skip) && skip >= 0);
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  const result = await reader.run(['log', '--no-notes', '--no-show-signature', '--no-color',
    '--author-date-order', `--skip=${skip}`, '--max-count=1', '--format=%H', ...tips, '--'], 1024);
  const id = completedOutput(result, 'Could not identify the unreadable Git commit.').toString('utf8').trim();
  assert.ok(OBJECT_ID.test(id), 'truncated history must identify a commit at the same offset');
  return id;
}

function unreadableObject(diagnostic: string): string | undefined {
  const id = /(?:could not read|could not parse|cannot read commit object|bad object) ([a-f0-9]+)\b/i.exec(diagnostic)?.[1]?.toLowerCase();
  return id && OBJECT_ID.test(id) ? id : undefined;
}

async function brokenBoundary(reader: GitReader, tips: string[], missing: string): Promise<BrokenBoundary | null> {
  assert.ok(OBJECT_ID.test(missing));
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  // A plain walk reports the child of a missing parent even when the ordered walk fails during setup.
  const traversal = await reader.run(['log', '--no-notes', '--no-show-signature', '--format=', ...tips, '--'], 256 * 1024);
  if (unreadableObject(traversal.diagnostic) !== missing) return null;
  const commit = /Failed to traverse parents of commit ([a-f0-9]+)\b/i.exec(traversal.diagnostic)?.[1]?.toLowerCase();
  if (!commit || !OBJECT_ID.test(commit)) return null;
  const result = await reader.run(['cat-file', 'commit', commit], 2 * 1024 * 1024);
  if (result.status !== 0) return null;
  const content = result.output.toString('utf8');
  const end = content.indexOf('\n\n');
  if (end < 0) return null;
  const headers = content.slice(0, end);
  const parents = [...headers.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1] ?? '');
  assert.ok(parents.every(parent => OBJECT_ID.test(parent)));
  if (!parents.includes(missing)) return null;
  return { commit, missing, parents };
}

async function withBoundary<T>(reader: GitReader, boundary: BrokenBoundary, action: (reader: GitReader) => Promise<T>): Promise<T> {
  assert.ok(OBJECT_ID.test(boundary.commit));
  assert.ok(boundary.parents.includes(boundary.missing) && boundary.parents.every(parent => OBJECT_ID.test(parent)));
  const availableParents = boundary.parents.filter(parent => parent !== boundary.missing);
  const directory = await mkdtemp(join(tmpdir(), 'delve-history-'));
  try {
    const graftFile = join(directory, 'grafts');
    await writeFile(graftFile, [boundary.commit, ...availableParents].join(' ') + '\n');
    return await action({ run: (args, maxBytes) => reader.run(['-c', 'advice.graftFileDeprecated=false', ...args], maxBytes, graftFile) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface GitHistorySource {
  branches: string[];
  warnings: string[];
  read: ((skip: number) => Promise<GitHistoryBatch>) | null;
}

function unreadableWarning(id: string) {
  return `Git commit ${id} is missing or damaged. Run git fsck to check the repository. You may need to restore the commit from a healthy copy.`;
}

async function readGitHistoryBatch(reader: GitReader, tips: string[], labels: Map<string, string[]>, skip: number, boundary?: BrokenBoundary): Promise<GitHistoryBatch> {
  assert.ok(Number.isSafeInteger(skip) && skip >= 0);
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  // Ancestry takes precedence when authored dates are out of order.
  const args = [...LOG, '--author-date-order', `--skip=${skip}`, `--max-count=${COMMIT_BATCH + 1}`, ...tips, '--'];
  const log = await reader.run(args, 2 * 1024 * 1024);
  const history = commitNodes(nulRecords(log.output), labels);
  const nodes = history.slice(0, COMMIT_BATCH);
  if (!log.truncated && log.status !== 0) {
    const missing = unreadableObject(log.diagnostic);
    const broken = missing && !boundary ? await brokenBoundary(reader, tips, missing) : null;
    if (broken) return withBoundary(reader, broken, repaired => readGitHistoryBatch(repaired, tips, labels, skip, broken));
    return { nodes, next: history.length > COMMIT_BATCH ? skip + nodes.length : null,
      warning: unreadableWarningOrGeneric(missing) };
  }
  const boundaryIndex = boundary ? nodes.findIndex(node => node.ref === boundary.commit) : -1;
  if (boundary && boundaryIndex >= 0) {
    const node = nodes[boundaryIndex];
    assert.ok(node);
    node.parents = boundary.parents;
    return { nodes: nodes.slice(0, boundaryIndex + 1), next: null,
      warning: unreadableWarning(boundary.missing) };
  }
  if (log.truncated && nodes.length === 0) {
    const id = await unreadableCommit(reader, tips, skip);
    return { nodes, next: null, warning: `Git commit ${id} exceeds the metadata read limit. Reduce its commit metadata to view older history.` };
  }
  const more = log.truncated || history.length > COMMIT_BATCH;
  return { nodes, next: more ? skip + nodes.length : null };
}

function unreadableWarningOrGeneric(id: string | undefined): string {
  return id ? unreadableWarning(id) : 'Git could not read the rest of the history. Run git fsck to check the repository.';
}

export async function openGitHistory(path: string, branch?: string, commits = true): Promise<GitHistorySource> {
  const reader = await gitReader(path);
  const { branches, labels, limited } = await branchTips(reader);
  const warnings = limited ? ['The Git branch list exceeded the read limit.'] : [];
  const result = { branches: [...branches.keys()], warnings, read: null };
  if (!commits) return result;
  const tips = branch ? [...(branches.get(branch) ?? branches.get('origin/' + branch) ?? [])]
    : [...new Set([...branches.values()].flatMap(ids => [...ids]))];
  if (!branch) {
    const head = await headTip(reader);
    if (head && !tips.includes(head)) tips.push(head);
  }
  if (tips.length === 0) return result;
  const shallow = await reader.run(['rev-parse', '--is-shallow-repository'], 1024);
  const isShallow = completedOutput(shallow, 'Could not check Git history depth.').toString('utf8').trim();
  assert.ok(isShallow === 'true' || isShallow === 'false');
  if (isShallow === 'true') warnings.push('Git history is limited to this shallow snapshot. Run git fetch --unshallow to see older commits.');
  return { ...result, read: skip => readGitHistoryBatch(reader, tips, labels, skip) };
}
