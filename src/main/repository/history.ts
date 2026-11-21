import assert from 'node:assert/strict';
import type { Workspace } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import type { HistoryNode, HistoryPage, HistoryRequest } from '../../shared/explorer';
import { gitHistory, pullHistory } from './source';

const PAGE_SIZE = 30;
type Batch = { nodes: HistoryNode[]; next: number | null; warning?: string };
type Reader = ((offset: number) => Promise<Batch>) | null;

class HistoryFeed {
  private nodes: HistoryNode[] = [];
  private offset: number | null;
  private index = 0;
  warning?: string;

  constructor(private read: Reader, start: number) {
    assert.ok(Number.isSafeInteger(start) && start >= 0);
    this.offset = read ? start : null;
    assert.equal(this.done, !read);
  }

  get head() { return this.nodes[this.index]; }
  get done() { return !this.head && this.offset === null; }

  async fill(): Promise<HistoryNode[]> {
    if (this.nodes.length - this.index >= PAGE_SIZE || this.offset === null) return [];
    assert.ok(this.read);
    try {
      const from = this.offset;
      const batch = await this.read(from);
      assert.ok(batch.next === null || batch.next > from);
      this.nodes = [...this.nodes.slice(this.index), ...batch.nodes];
      this.index = 0;
      this.offset = batch.next;
      this.warning = batch.warning ?? this.warning;
      return batch.nodes;
    } catch (cause) {
      if (!(cause instanceof DomainError)) throw cause;
      this.offset = null;
      this.warning = cause.message;
      return [];
    }
  }

  take(): HistoryNode {
    const head = this.head;
    assert.ok(head);
    this.index++;
    assert.ok(this.index <= this.nodes.length);
    return head;
  }
}

function matches(node: HistoryNode, request: HistoryRequest): boolean {
  if (request.kind && node.kind !== request.kind) return false;
  if (request.branch && node.kind === 'pr') {
    const branch = request.branch;
    if (!node.branches.some(label => branch === label || branch === 'origin/' + label)) return false;
  }
  if (request.author && !node.author.toLowerCase().includes(request.author.toLowerCase())) return false;
  const query = request.search?.toLowerCase();
  if (!query) return true;
  if (/^#\d+$/.test(query)) return node.kind === 'pr' && node.ref === query.slice(1);
  return [node.title, node.ref, node.head, node.author, ...node.branches].some(text => text.toLowerCase().includes(query));
}

function byDate(node: HistoryNode) {
  return node.date ? Date.parse(node.date) : -Infinity;
}

const changeKey = (node: HistoryNode) => node.kind + '/' + node.ref;

class RepositoryHistory {
  private readonly seenPulls = new Set<string>();
  private readonly commits: HistoryFeed;
  private readonly pulls: HistoryFeed;
  private readonly saved: Map<string, HistoryNode>;
  private readonly branches: Set<string>;
  private pullStatus: HistoryPage['pullStatus'];

  constructor(
    private request: HistoryRequest,
    private git: Awaited<ReturnType<typeof gitHistory>>,
    private github: Awaited<ReturnType<typeof pullHistory>>,
    saved: HistoryNode[],
  ) {
    this.commits = new HistoryFeed(git.read, 0);
    this.pulls = new HistoryFeed(github.read, 1);
    this.saved = new Map(request.branch ? [] : saved.filter(node => matches(node, request)).map(node => [changeKey(node), node]));
    this.branches = new Set(git.branches);
    if (request.branch) this.branches.add(request.branch);
    this.pullStatus = github.status;
  }

  async advance(cursor: () => number): Promise<HistoryPage> {
    const [, pullsRead] = await Promise.all([this.commits.fill(), this.pulls.fill()]);
    if (pullsRead.length) this.pullStatus = 'available';
    for (const pull of pullsRead) {
      for (const branch of pull.branches) this.branches.add(branch);
    }
    if (this.pulls.done && this.pullStatus === 'unchecked' && this.github.read) {
      this.pullStatus = this.pulls.warning ? 'unavailable' : 'empty';
    }

    const nodes: HistoryNode[] = [];
    while (nodes.length < PAGE_SIZE) {
      const { commits, pulls } = this;
      if ((!commits.head && !commits.done) || (!pulls.head && !pulls.done)) break;
      if (commits.done && pulls.done) break;
      const usePull = pulls.head && (!commits.head || byDate(pulls.head) >= byDate(commits.head));
      const node = usePull ? pulls.take() : commits.take();
      if (node.kind === 'pr') {
        if (this.seenPulls.has(node.ref)) continue;
        this.seenPulls.add(node.ref);
      }
      this.saved.delete(changeKey(node));
      if (matches(node, this.request)) nodes.push(node);
    }

    const liveDone = this.commits.done && this.pulls.done;
    const warnings = [...this.git.warnings, this.github.warning, this.commits.warning, this.pulls.warning].filter(Boolean);
    if (liveDone && this.saved.size && warnings.length) warnings.push('Previously saved changes are included.');
    if (liveDone) {
      for (const [key, node] of this.saved) {
        if (nodes.length === PAGE_SIZE) break;
        nodes.push(node);
        this.saved.delete(key);
      }
    }
    assert.ok(nodes.length <= PAGE_SIZE);
    const next = liveDone && this.saved.size === 0 ? null : cursor();
    return { nodes, next, branches: [...this.branches].sort(), pullStatus: this.pullStatus,
      warning: [...new Set(warnings)].join(' ') || null };
  }
}

export async function openRepositoryHistory(workspace: Workspace, cacheRoot: string, request: HistoryRequest, saved: HistoryNode[]) {
  assert.equal(request.workspaceId, workspace.id);
  assert.ok(saved.every(node => node.date === ''));
  const [git, github] = await Promise.all([gitHistory(workspace, cacheRoot, request), pullHistory(workspace, request.kind === 'commit')]);
  return new RepositoryHistory(request, git, github, saved);
}
