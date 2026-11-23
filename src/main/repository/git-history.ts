import assert from 'node:assert/strict';
import type { HistoryNode } from '../../shared/explorer';
import { DomainError } from '../../shared/errors';
import { withBoundaries, type BrokenBoundary } from './git-boundaries';
import { commitParentHeaders } from './git-commit-headers';
import { gitReadFailed, gitReadState } from './git-diagnostics';
import { changeTitle, checkReachability, gitReader, headTip, isMissingCommit, nulRecords, reachabilityDiagnostics, reachabilityFailed,
  REACHABILITY_REVISIONS, type GitReader } from './git-reader';
import { OBJECT_ID, safeBranch, safeAuthor } from './source-policy';
import type { CommandResult } from './source-process';

const COMMIT_BATCH = 32;
const MAX_BRANCHES = 256;
const MAX_PARENT_REPAIRS = 4;
const WALK_LIMIT = 2 * 1024 * 1024;
const METADATA_LIMIT = 1024 * 1024;
const LOG = ['log', '--no-notes', '--no-show-signature', '--no-color', '--encoding=UTF-8', '-z'];
const LOG_RECORD_FORMAT = '%H%x00%P%x00%an%x00%aI%x00%s';
const LOG_RECORDS = [...LOG, `--format=${LOG_RECORD_FORMAT}`];
const TIP_LOG = [...LOG, '--no-walk=unsorted', '--format=%H'];

type ObjectFailure = { object: string; child?: string };
type HistoryRead =
  | { kind: 'complete'; output: Buffer }
  | { kind: 'object'; output: Buffer; failure: ObjectFailure };
type HistoryWalk = HistoryRead | { kind: 'limited'; output: Buffer };

function historyReadFailed(result: CommandResult): never {
  gitReadFailed(result, result.truncated ? 'Git history output exceeded the read limit.' : 'Could not read Git history.');
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
  if (gitReadState(result) === 'complete') return { kind: 'complete', output: result.output };
  if (result.truncated) historyReadFailed(result);
  const lines = result.diagnostic.split(/\r?\n/);
  const fatals = lines.filter(line => line.startsWith('fatal:'));
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

export async function readCommitLog(reader: GitReader, head: string, parents: string[], format: string, limit: number): Promise<CommandResult> {
  assert.ok(OBJECT_ID.test(head) && parents.every(parent => OBJECT_ID.test(parent)));
  assert.ok(Number.isSafeInteger(limit) && limit > 0);
  const args = [...LOG, `--format=${format}`, '--max-count=1', head, '--'];
  let result = await reader.run(args, limit);
  if (result.status !== 128) return result;

  const boundaries = new Map<string, BrokenBoundary>();
  for (let attempt = 0; attempt < MAX_PARENT_REPAIRS; attempt++) {
    const parent = missingCommitLogParent(result, head, parents);
    if (!parent || !addBrokenBoundary(boundaries, { commit: head, parents, missing: parent })) break;
    await verifyUnreadable(reader, parent, result);
    result = await withBoundaries(reader, boundaries, git => git.run(args, limit));
  }
  return result;
}

function missingCommitLogParent(result: CommandResult, head: string, parents: string[]): string | undefined {
  if (result.truncated || result.status !== 128 || result.output.length > 0) return;
  const errors = result.diagnostic.split(/\r?\n/).filter(line => /^(?:error|fatal):/.test(line));
  if (errors.length !== 2 || errors[1] !== `fatal: Failed to traverse parents of commit ${head}`) return;
  return parents.find(parent => errors[0] === `error: Could not read ${parent}`);
}

export async function gitHistoryNode(reader: GitReader, head: string, parents: string[]): Promise<HistoryNode> {
  assert.ok(OBJECT_ID.test(head));
  const { labels } = await branchTips(reader);
  const result = await readCommitLog(reader, head, parents, LOG_RECORD_FORMAT, METADATA_LIMIT);
  if (gitReadState(result, METADATA_LIMIT) === 'limited') {
    throw new DomainError('SOURCE_LIMIT', 'The Git commit metadata exceeded the read limit.');
  }
  const nodes = commitNodes(nulRecords(completeHistoryOutput(result)), labels);
  const [node] = nodes;
  assert.ok(nodes.length === 1 && node);
  assert.equal(node.head, head);
  return { ...node, parents };
}

interface BrokenParent {
  commit: string;
  missing: string;
  parents: string[];
}

interface GitHistoryBatch {
  nodes: HistoryNode[];
  next: number | null;
  warning?: string;
}

async function brokenParent(reader: GitReader, revisions: string[], original: GitReader): Promise<BrokenParent | null> {
  assert.ok(revisions.length > 0);
  assert.ok(revisions.every(revision => OBJECT_ID.test(revision) || REACHABILITY_REVISIONS.includes(revision)));
  // A plain walk reports the child of a missing parent even when the ordered walk fails during setup.
  const traversal = await reader.run([...LOG, '--format=', ...revisions, '--'], 256 * 1024);
  const read = await readHistoryOutput(reader, traversal);
  if (read.kind !== 'object' || !read.failure.child) return null;
  const { object: missing, child: commit } = read.failure;
  const result = await original.run(['cat-file', 'commit', commit], WALK_LIMIT);
  const content = gitReadState(result, WALK_LIMIT) === 'limited' ? result.output : completeHistoryOutput(result);
  const headers = commitParentHeaders(content, commit, result.truncated);
  if (!headers) historyReadFailed(result);
  if (!headers.parents.includes(missing)) return null;
  return { commit, missing, parents: headers.parents };
}

function missingReachabilityParent(result: CommandResult): string | undefined {
  if (result.truncated) return;
  const [first, ...rest] = reachabilityDiagnostics(result);
  const parent = /^error: Could not read ([a-f0-9]+)$/.exec(first ?? '')?.[1];
  if (!parent || !OBJECT_ID.test(parent)) return;
  if (rest.every(line => line === `error: could not parse commit ${parent}` || line === 'fatal: failed to check reachability'
    || /^fatal: Failed to traverse parents of commit [a-f0-9]+$/.test(line))) return parent;
}

export async function requireReachableChange(reader: GitReader, commit: string, parents: string[], missing: string[]): Promise<void> {
  assert.ok(OBJECT_ID.test(commit) && parents.every(parent => OBJECT_ID.test(parent)));
  assert.ok(missing.every(parent => parents.includes(parent)));
  const boundaries = new Map<string, BrokenBoundary>();
  if (missing.length) boundaries.set(commit, { parents, missing: new Set(missing) });
  const check = () => withBoundaries(reader, boundaries, git => checkReachability(git, commit), 'reachability');
  let failure = await check();
  if (!failure) return;
  if (!missingReachabilityParent(failure)) reachabilityFailed(failure);

  const head = await headTip(reader);
  const revisions = [...REACHABILITY_REVISIONS, ...(head ? [head] : [])];
  for (let attempt = 0; attempt < MAX_PARENT_REPAIRS && failure; attempt++) {
    const missingParent = missingReachabilityParent(failure);
    if (!missingParent || !await isMissingCommit(reader, missingParent)) break;
    const boundary = await withBoundaries(reader, boundaries, git => brokenParent(git, revisions, reader), 'reachability');
    if (!boundary || (boundary.missing !== missingParent && !await isMissingCommit(reader, boundary.missing))) break;
    if (!addBrokenBoundary(boundaries, boundary)) break;
    failure = await check();
  }
  if (failure) reachabilityFailed(failure);
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

function orderedLog(reader: GitReader, tips: string[], skip: number, count: number) {
  assert.ok(tips.length > 0 && tips.every(tip => OBJECT_ID.test(tip)));
  assert.ok(Number.isSafeInteger(skip) && skip >= 0);
  // Ancestry takes precedence when authored dates are out of order.
  return reader.run([...LOG_RECORDS, '--author-date-order', `--skip=${skip}`, `--max-count=${count}`, ...tips, '--'], WALK_LIMIT);
}

async function walkHistory(reader: GitReader, tips: string[], skip: number, boundaries: Map<string, BrokenBoundary>): Promise<HistoryWalk> {
  const run = () => withBoundaries(reader, boundaries, async git => {
    const result = await orderedLog(git, tips, skip, COMMIT_BATCH + 1);
    if (gitReadState(result, WALK_LIMIT) === 'limited') return { kind: 'limited', output: result.output } as const;
    return readHistoryOutput(git, result);
  });
  let log = await run();
  for (let attempt = 0; attempt < MAX_PARENT_REPAIRS && log.kind === 'object'; attempt++) {
    const parent = await withBoundaries(reader, boundaries, git => brokenParent(git, tips, reader));
    if (!parent || !addBrokenBoundary(boundaries, parent)) break;
    log = await run();
  }
  return log;
}

async function checkWalkLimit(reader: GitReader, tips: string[], skip: number, labels: Map<string, string[]>,
  boundaries: Map<string, BrokenBoundary>): Promise<{ node: HistoryNode; more: boolean } | { oversized: string }> {
  const result = await withBoundaries(reader, boundaries, git => orderedLog(git, tips, skip, 2));
  const limited = gitReadState(result, WALK_LIMIT) === 'limited';
  const records = nulRecords(limited ? result.output : completeHistoryOutput(result));
  const nodes = commitNodes(records, labels);
  assert.ok(nodes.length <= 2);
  const [node] = nodes;
  if (node) return { node, more: limited || nodes.length === 2 };
  const [id] = records;
  if (!limited || !id || !OBJECT_ID.test(id)) historyReadFailed(result);
  return { oversized: id };
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
  let oversized: string | undefined;
  let more = false;
  if (log.kind === 'limited') {
    assert.ok(history.length <= COMMIT_BATCH);
    // A single record gets its own budget before we stop at the boundary.
    const limit = await checkWalkLimit(reader, tips, skip + history.length, labels, boundaries);
    if ('oversized' in limit) oversized = limit.oversized;
    else {
      history.push(limit.node);
      more = limit.more;
    }
  }
  const nodes = history.slice(0, COMMIT_BATCH);
  const gaps = boundaries.size ? nodes.filter(node => boundaries.has(node.ref)) : [];
  const restored = gaps.length ? nodes.map(node => {
    const boundary = boundaries.get(node.ref);
    return boundary ? { ...node, parents: boundary.parents } : node;
  }) : nodes;
  const warnings: string[] = [];
  if (log.kind === 'object') warnings.push(unreadableWarning(log.failure.object));
  else if (gaps.length) warnings.push(gapWarning(boundaries, gaps));
  if (oversized) warnings.push(`Git history stopped at commit ${oversized.slice(0, 12)} because its metadata exceeded the read limit.`);
  const hasMore = !oversized && (more || history.length > COMMIT_BATCH);
  return { nodes: restored, next: hasMore ? skip + nodes.length : null, warning: warnings.join(' ') || undefined };
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
