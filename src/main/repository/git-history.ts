import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryNode } from '../../shared/explorer';
import { DomainError } from '../../shared/errors';
import { changeTitle, gitReader, nulRecords, type GitReader } from './git-reader';
import { OBJECT_ID, safeBranch, safeAuthor } from './source-policy';
import { completedOutput, type CommandResult } from './source-process';

const COMMIT_BATCH = 32;
const MAX_BRANCHES = 256;
const MAX_PARENT_REPAIRS = 4;
const LOG = ['log', '--no-notes', '--no-show-signature', '--no-color', '--encoding=UTF-8', '-z'];
const LOG_RECORDS = [...LOG, '--format=%H%x00%P%x00%an%x00%aI%x00%s'];

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
  const result = await reader.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD'], 1024);
  if (!result.truncated && result.status === 1) return null;
  const head = completedOutput(result, 'Could not read HEAD.').toString('utf8').trim();
  assert.ok(OBJECT_ID.test(head));
  assert.equal(head, head.toLowerCase());
  return head;
}

export async function gitHistoryNode(reader: GitReader, head: string): Promise<HistoryNode> {
  assert.ok(OBJECT_ID.test(head));
  const { labels } = await branchTips(reader);
  const result = await reader.run([...LOG_RECORDS, '--max-count=1', head, '--'], 1024 * 1024);
  if (!result.truncated) completedOutput(result, 'Could not read the Git commit metadata.');
  const [node] = commitNodes(nulRecords(result.output), labels);
  if (!node) throw new DomainError('SOURCE_LIMIT', 'The Git commit metadata exceeded the read limit.');
  assert.equal(node.head, head);
  return node;
}

interface BrokenParent {
  commit: string;
  missing: string;
  parents: string[];
}

interface BrokenBoundary {
  missing: Set<string>;
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

async function brokenParent(reader: GitReader, tips: string[]): Promise<BrokenParent | null> {
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  // A plain walk reports the child of a missing parent even when the ordered walk fails during setup.
  const traversal = await reader.run(['log', '--no-notes', '--no-show-signature', '--format=', ...tips, '--'], 256 * 1024);
  const missing = unreadableObject(traversal.diagnostic);
  if (!missing) return null;
  const commit = /Failed to traverse parents of commit ([a-f0-9]+)\b/i.exec(traversal.diagnostic)?.[1]?.toLowerCase();
  if (!commit || !OBJECT_ID.test(commit)) return null;
  const result = await reader.run(['cat-file', 'commit', commit], 2 * 1024 * 1024);
  if (result.status !== 0) return null;
  const content = result.output.toString('utf8');
  const end = content.indexOf('\n\n');
  if (end < 0) return null;
  const headers = content.slice(0, end);
  const parents = [...headers.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1] ?? '');
  if (!parents.every(parent => OBJECT_ID.test(parent)) || !parents.includes(missing)) return null;
  return { commit, missing, parents };
}

function graftLine([commit, { missing, parents }]: [string, BrokenBoundary]): string {
  assert.ok(OBJECT_ID.test(commit) && parents.every(parent => OBJECT_ID.test(parent)));
  assert.ok(missing.size > 0 && [...missing].every(parent => parents.includes(parent)));
  return [commit, ...parents.filter(parent => !missing.has(parent))].join(' ');
}

async function withBoundaries<T>(reader: GitReader, boundaries: Map<string, BrokenBoundary>, action: (reader: GitReader) => Promise<T>): Promise<T> {
  if (boundaries.size === 0) return action(reader);
  const directory = await mkdtemp(join(tmpdir(), 'delve-history-'));
  try {
    const graftFile = join(directory, 'grafts');
    await writeFile(graftFile, [...boundaries].map(graftLine).join('\n') + '\n');
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

async function readableTips(reader: GitReader, tips: string[]) {
  assert.ok(tips.length > 0 && tips.length <= MAX_BRANCHES + 1);
  assert.ok(tips.every(tip => OBJECT_ID.test(tip)));
  const pending = [tips];
  const readable = new Set<string>();
  while (pending.length > 0) {
    const batch = pending.pop()!;
    const log = await reader.run([...LOG, '--no-walk=unsorted', '--ignore-missing', '--format=%H', ...batch, '--'], 256 * 1024);
    if (log.truncated || log.status !== 0) {
      // Git can abort on corrupt object storage even with --ignore-missing.
      if (batch.length > 1) {
        const middle = Math.floor(batch.length / 2);
        pending.push(batch.slice(0, middle), batch.slice(middle));
      }
      continue;
    }
    const { output } = log;
    assert.ok(output.length === 0 || output.at(-1) === 0);
    const records = nulRecords(output);
    assert.ok(records.length <= batch.length && records.every(tip => OBJECT_ID.test(tip)));
    for (const tip of records) readable.add(tip);
  }
  return { tips: tips.filter(tip => readable.has(tip)), skipped: tips.filter(tip => !readable.has(tip)) };
}

function addBrokenBoundary(boundaries: Map<string, BrokenBoundary>, { commit, parents, missing }: BrokenParent): boolean {
  const current = boundaries.get(commit);
  if (!current) {
    boundaries.set(commit, { parents, missing: new Set([missing]) });
    return true;
  }
  assert.deepEqual(current.parents, parents);
  assert.ok(parents.includes(missing));
  if (current.missing.has(missing)) return false;
  current.missing.add(missing);
  return true;
}

async function walkHistory(reader: GitReader, tips: string[], skip: number, boundaries: Map<string, BrokenBoundary>): Promise<CommandResult> {
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  assert.ok(Number.isSafeInteger(skip) && skip >= 0);
  // Ancestry takes precedence when authored dates are out of order.
  const args = [...LOG_RECORDS, '--author-date-order', `--skip=${skip}`, `--max-count=${COMMIT_BATCH + 1}`, ...tips, '--'];
  const run = () => withBoundaries(reader, boundaries, git => git.run(args, 2 * 1024 * 1024));
  let log = await run();
  let readable = log.output;
  for (let attempt = 0; attempt < MAX_PARENT_REPAIRS && !log.truncated && log.status !== 0; attempt++) {
    if (!unreadableObject(log.diagnostic)) break;
    const parent = await withBoundaries(reader, boundaries, git => brokenParent(git, tips));
    if (!parent || !addBrokenBoundary(boundaries, parent)) break;
    log = await run();
    if (!log.truncated && log.status !== 0 && log.output.length < readable.length) continue;
    readable = log.output;
  }
  return { ...log, output: readable };
}

function gapWarning(boundaries: Map<string, BrokenBoundary>, gaps: HistoryNode[]): string {
  const boundary = boundaries.get(gaps[0]!.ref);
  assert.ok(boundary);
  const missing = boundary.parents.find(parent => boundary.missing.has(parent));
  assert.ok(missing);
  return unreadableWarning(missing);
}

async function readGitHistoryBatch(reader: GitReader, tips: string[], labels: Map<string, string[]>, skip: number,
  boundaries: Map<string, BrokenBoundary>): Promise<GitHistoryBatch> {
  const log = await walkHistory(reader, tips, skip, boundaries);
  const history = commitNodes(nulRecords(log.output), labels);
  const nodes = history.slice(0, COMMIT_BATCH);
  const gaps = boundaries.size ? nodes.filter(node => boundaries.has(node.ref)) : [];
  if (gaps.length > 0) {
    const restored = nodes.map(node => (boundaries.has(node.ref) ? { ...node, parents: boundaries.get(node.ref)!.parents } : node));
    return { nodes: restored, next: log.truncated || history.length > COMMIT_BATCH ? skip + nodes.length : null, warning: gapWarning(boundaries, gaps) };
  }
  if (!log.truncated && log.status !== 0) {
    const missing = unreadableObject(log.diagnostic);
    return { nodes, next: history.length > COMMIT_BATCH ? skip + nodes.length : null,
      warning: missing ? unreadableWarning(missing) : 'Git could not read the rest of the history. Run git fsck to check the repository.' };
  }
  if (log.truncated && nodes.length === 0) {
    const id = await withBoundaries(reader, boundaries, git => unreadableCommit(git, tips, skip));
    return { nodes, next: null, warning: `Git commit ${id} exceeds the metadata read limit. Reduce its commit metadata to view older history.` };
  }
  const more = log.truncated || history.length > COMMIT_BATCH;
  return { nodes, next: more ? skip + nodes.length : null };
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
  const readable = await readableTips(reader, tips);
  const [firstSkipped] = readable.skipped;
  if (firstSkipped) {
    warnings.push(unreadableWarning(firstSkipped));
    if (readable.skipped.length > 1) warnings.push(`Skipped ${readable.skipped.length} unreadable Git tips.`);
  }
  if (readable.tips.length === 0) return result;
  const shallow = await reader.run(['rev-parse', '--is-shallow-repository'], 1024);
  const isShallow = completedOutput(shallow, 'Could not check Git history depth.').toString('utf8').trim();
  assert.ok(isShallow === 'true' || isShallow === 'false');
  if (isShallow === 'true') warnings.push('Git history is limited to this shallow snapshot. Run git fetch --unshallow to see older commits.');
  const boundaries = new Map<string, BrokenBoundary>();
  return { ...result, read: skip => readGitHistoryBatch(reader, readable.tips, labels, skip, boundaries) };
}
