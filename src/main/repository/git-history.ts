import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryNode } from '../../shared/explorer';
import { DomainError } from '../../shared/errors';
import { changeTitle, gitReader, nulRecords, type GitReader } from './git-reader';
import { OBJECT_ID, safeBranch, safeAuthor, sourceText } from './source-policy';
import { completedOutput, type CommandResult } from './source-process';

const COMMIT_BATCH = 32;
const MAX_BRANCHES = 256;
const MAX_PARENT_REPAIRS = 4;
const LOG = ['log', '--no-notes', '--no-show-signature', '--no-color', '--encoding=UTF-8', '-z'];
const LOG_RECORDS = [...LOG, '--format=%H%x00%P%x00%an%x00%aI%x00%s'];
const TIP_LOG = [...LOG, '--no-walk=unsorted', '--format=%H'];

type ObjectFailure = { object: string; child?: string };
type HistoryRead =
  | { kind: 'complete'; output: Buffer }
  | { kind: 'object'; output: Buffer; failure: ObjectFailure };

function historyReadFailed(result: CommandResult): never {
  const message = result.truncated ? 'Git history output exceeded the read limit.' : 'Could not read Git history.';
  const printable = result.diagnostic.replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' ? '\n' : ' ');
  const sanitized = sourceText(Buffer.from(printable));
  if (!sanitized) throw new DomainError('SOURCE_READ_FAILED', message);
  const lines = sanitized.split('\n').map(line => line.trim()).filter(Boolean);
  const detail = lines.join(' ');
  const fatal = detail.length > 1024 ? lines.filter(line => line.startsWith('fatal:')).join(' ') : '';
  const summary = (fatal || detail).slice(0, 1024);
  throw new DomainError('SOURCE_READ_FAILED', summary ? message + ' ' + summary : message);
}

function parseObjectFailure(fatal: string, preceding: string): ObjectFailure | undefined {
  const direct = /^(?:bad object|could not read|could not parse|cannot read commit object|failed to read object) ([a-f0-9]+)$/i.exec(fatal)?.[1]
    ?? /^(?:loose|packed) object ([a-f0-9]+) \(stored in .+\) is corrupt$/i.exec(fatal)?.[1];
  if (direct && OBJECT_ID.test(direct)) return { object: direct };

  const child = /^Failed to traverse parents of commit ([a-f0-9]+)$/.exec(fatal)?.[1];
  if (fatal !== 'revision walk setup failed' && !(child && OBJECT_ID.test(child))) return;
  const object = /^error: (?:Could not read|bogus commit object) ([a-f0-9]+)$/.exec(preceding)?.[1];
  if (object && OBJECT_ID.test(object)) return { object, child };
}

function classifyHistory(result: CommandResult): HistoryRead {
  assert.ok(Number.isInteger(result.status));
  assert.ok(Buffer.isBuffer(result.output));
  if (result.truncated) historyReadFailed(result);
  const lines = result.diagnostic.split(/\r?\n/);
  const fatals = lines.filter(line => line.startsWith('fatal:'));
  if (result.status === 0 && fatals.length === 0) return { kind: 'complete', output: result.output };
  const [fatal] = fatals;
  if (fatals.length !== 1 || !fatal) historyReadFailed(result);
  const failure = parseObjectFailure(fatal.slice('fatal:'.length).trim(), lines[lines.indexOf(fatal) - 1] ?? '');
  if (!failure) historyReadFailed(result);
  return { kind: 'object', output: result.output, failure };
}

function completeHistoryOutput(result: CommandResult): Buffer {
  const read = classifyHistory(result);
  if (read.kind !== 'complete') historyReadFailed(result);
  return read.output;
}

async function verifyUnreadable(reader: GitReader, object: string, original: CommandResult): Promise<void> {
  assert.ok(OBJECT_ID.test(object));
  assert.ok(!original.truncated);
  // A no-walk read checks the commit itself. Existence alone misses corrupt and malformed objects.
  const probe = await reader.run(['rev-list', '--no-walk=unsorted', '--max-count=1', object, '--'], 4096);
  const read = classifyHistory(probe);
  if (read.kind === 'object' && read.failure.object === object) return;
  if (read.kind === 'object') historyReadFailed(probe);
  historyReadFailed(original);
}

async function readHistoryOutput(reader: GitReader, result: CommandResult): Promise<HistoryRead> {
  const read = classifyHistory(result);
  if (read.kind === 'object') await verifyUnreadable(reader, read.failure.object, result);
  return read;
}

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
  const lines = completeHistoryOutput(result).toString('utf8').split('\n').filter(Boolean);
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
  if (!result.truncated && result.status === 1 && !result.diagnostic && !result.output.length) return null;
  const head = completeHistoryOutput(result).toString('utf8').trim();
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

async function brokenParent(reader: GitReader, tips: string[]): Promise<BrokenParent | null> {
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  // A plain walk reports the child of a missing parent even when the ordered walk fails during setup.
  const traversal = await reader.run([...LOG, '--format=', ...tips, '--'], 256 * 1024);
  const read = await readHistoryOutput(reader, traversal);
  if (read.kind !== 'object' || !read.failure.child) return null;
  const { object: missing, child: commit } = read.failure;
  const result = await reader.run(['cat-file', 'commit', commit], 2 * 1024 * 1024);
  const content = completeHistoryOutput(result).toString('utf8');
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
  const pending = new Set(tips);
  while (pending.size > 0) {
    const log = await reader.run([...TIP_LOG, '--ignore-missing', ...pending, '--'], 256 * 1024);
    const read = await readHistoryOutput(reader, log);
    if (read.kind === 'object') {
      if (!pending.delete(read.failure.object)) historyReadFailed(log);
      continue;
    }
    const { output } = read;
    assert.ok(output.length === 0 || output.at(-1) === 0);
    const records = nulRecords(output);
    assert.ok(records.length <= pending.size && records.every(tip => OBJECT_ID.test(tip)));
    const readable = new Set(records);
    for (const tip of pending) {
      if (!readable.has(tip)) await verifyUnreadable(reader, tip, log);
    }
    return { tips: tips.filter(tip => pending.has(tip) && readable.has(tip)), skipped: tips.filter(tip => !readable.has(tip)) };
  }
  return { tips: [], skipped: tips };
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

async function walkHistory(reader: GitReader, tips: string[], skip: number, boundaries: Map<string, BrokenBoundary>): Promise<HistoryRead> {
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  assert.ok(Number.isSafeInteger(skip) && skip >= 0);
  // Ancestry takes precedence when authored dates are out of order.
  const args = [...LOG_RECORDS, '--author-date-order', `--skip=${skip}`, `--max-count=${COMMIT_BATCH + 1}`, ...tips, '--'];
  const run = () => withBoundaries(reader, boundaries, async git => readHistoryOutput(git, await git.run(args, 2 * 1024 * 1024)));
  let log = await run();
  for (let attempt = 0; attempt < MAX_PARENT_REPAIRS && log.kind === 'object'; attempt++) {
    const parent = await withBoundaries(reader, boundaries, git => brokenParent(git, tips));
    if (!parent || !addBrokenBoundary(boundaries, parent)) break;
    log = await run();
  }
  return log;
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
  const restored = gaps.length ? nodes.map(node => {
    const boundary = boundaries.get(node.ref);
    return boundary ? { ...node, parents: boundary.parents } : node;
  }) : nodes;
  const warning = log.kind === 'object' ? unreadableWarning(log.failure.object) : gaps.length ? gapWarning(boundaries, gaps) : undefined;
  return { nodes: restored, next: history.length > COMMIT_BATCH ? skip + nodes.length : null, warning };
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
  const isShallow = completeHistoryOutput(shallow).toString('utf8').trim();
  assert.ok(isShallow === 'true' || isShallow === 'false');
  if (isShallow === 'true') warnings.push('Git history is limited to this shallow snapshot. Run git fetch --unshallow to see older commits.');
  const boundaries = new Map<string, BrokenBoundary>();
  return { ...result, read: skip => readGitHistoryBatch(reader, readable.tips, labels, skip, boundaries) };
}
