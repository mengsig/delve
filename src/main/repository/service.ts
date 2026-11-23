import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workspace } from '../../shared/domain';
import type { RepositoryInput, RepositoryInventory, RepoRequest, SavedRequest } from '../../shared/repository';
import type { DetailRequest, HistoryPage, HistoryRequest } from '../../shared/explorer';
import { openRepositoryHistory } from './history';
import { DomainError } from '../../shared/errors';
import type { Db } from '../db/connection';
import { isDemoWorkspace } from '../db/demo';
import { addWorkspace, getWorkspace, listWorkspaces, resolveWorkspaceSource } from '../db/workspaces';
import type { ProviderRunner } from '../providers/runner';
import { listChanges, listFiles, readChangeDetail, repositoryPath, withCommitSnapshot } from './source';
import { prepareSource } from './preview';
import { baselineReply, changeReply, type ChangeReply } from './schemas';
import { digest, useCachedGeneration, latestBrief, persistGeneration, savedChanges, savedHistory, type ApprovedSource } from './store';
import { foundationLanguageIssue } from '../tutor/foundation-content';
import { highDepthTextIssue, withPlainLanguageRetry } from '../tutor/language';

function outputSchema(schema: typeof baselineReply | typeof changeReply) {
  return z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any', override: ({ jsonSchema }) => {
    for (const field of ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'minimum', 'maximum']) delete jsonSchema[field];
    if (jsonSchema.type === 'object' && jsonSchema.properties) jsonSchema.required = Object.keys(jsonSchema.properties);
  } });
}

const formats = { baseline: outputSchema(baselineReply), change: outputSchema(changeReply) };

function changeLanguageIssue({ summary, what, why, before, after, example, recommendation, foundations }: ChangeReply) {
  if (!example) return 'The change explanation needs a concrete example.';
  const text = [summary, what, why, before, after, example, recommendation.reason];
  return highDepthTextIssue(text) ?? foundationLanguageIssue(foundations ?? []);
}

export class RepositoryLearning {
  private readonly previews = new Map<string, ApprovedSource>();
  private readonly inventories = new Map<string, { path: string; inventory: RepositoryInventory }>();
  private readonly staged = new Map<string, { source: RepositoryInput; workspace: Workspace }>();
  private readonly runs = new Map<string, AbortController>();
  private readonly historyCursors = new Map<number, { key: string; load: () => Promise<HistoryPage>; result?: Promise<HistoryPage> }>();
  private nextHistoryCursor = 1;
  private readonly reads = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private db: Db, private cacheRoot: string, private runner: ProviderRunner) {}

  private async whileOpen<T>(read: () => Promise<T>): Promise<T> {
    if (this.closed) throw new DomainError('REPO_CLOSED', 'Delve is closing.');
    const pending = read();
    this.reads.add(pending);
    try { return await pending; }
    finally { this.reads.delete(pending); }
  }

  private workspace(id: string): Workspace {
    const workspace = getWorkspace(this.db, id);
    if (!workspace || workspace.kind === 'topic' || isDemoWorkspace(this.db, id)) throw new DomainError('INVALID_REPO', 'Choose a repository you have added.');
    return workspace;
  }

  stage(source: RepositoryInput) {
    return this.whileOpen(async () => {
      const resolved = resolveWorkspaceSource(source);
      if (listWorkspaces(this.db).workspaces.some(w => w.kind === resolved.kind && w.source === resolved.source)) {
        throw new DomainError('DUPLICATE_WORKSPACE', 'This repository is already in your workspace switcher.');
      }
      const workspace = { ...resolved, id: randomUUID(), createdAt: new Date().toISOString(), lastOpenedAt: null };
      const inventory = await this.inventory(workspace);
      if (this.staged.size >= 12) this.staged.delete(this.staged.keys().next().value!);
      this.staged.set(workspace.id, { source, workspace });
      return { workspace, inventory };
    });
  }

  attach(token: string): Workspace {
    const approved = this.previews.get(token);
    const staged = approved && this.staged.get(approved.request.workspaceId);
    if (!staged || approved?.request.selection.kind !== 'baseline') {
      throw new DomainError('STALE_PREVIEW', 'Refresh the file preview before adding this repository.');
    }
    const workspace = addWorkspace(this.db, staged.source, staged.workspace.id);
    this.staged.delete(workspace.id);
    return workspace;
  }

  files(id: string) { return this.whileOpen(() => this.inventory(this.workspace(id))); }

  private async inventory(workspace: Workspace): Promise<RepositoryInventory> {
    const path = await repositoryPath(workspace, this.cacheRoot);
    const inventory = await listFiles(path);
    const key = workspace.id + '/' + inventory.commit;
    if (this.inventories.size >= 12) this.inventories.delete(this.inventories.keys().next().value!);
    this.inventories.set(key, { inventory, path });
    return inventory;
  }

  changes(id: string) { return this.whileOpen(() => this.loadChanges(id)); }

  private async loadChanges(id: string) {
    const saved = savedChanges(this.db, id);
    try {
      const workspace = this.workspace(id);
      const path = await repositoryPath(workspace, this.cacheRoot);
      const { changes, warning } = await listChanges(path, workspace);
      const keys = new Set(changes.map(change => change.kind + '/' + change.ref));
      return { changes: [...changes, ...saved.filter(change => !keys.has(change.kind + '/' + change.ref))], warning };
    } catch (error) {
      if (!saved.length || !(error instanceof DomainError)) throw error;
      return { changes: saved, warning: error.message + ' Showing previously saved changes.' };
    }
  }

  history(request: HistoryRequest) {
    return this.whileOpen(async () => {
      const workspace = this.workspace(request.workspaceId);
      const key = JSON.stringify([workspace.id, request.branch, request.kind, request.author, request.search]);
      if (request.cursor !== 0) {
        const cursor = this.historyCursors.get(request.cursor);
        if (!cursor || cursor.key !== key) throw new DomainError('STALE_HISTORY', 'Refresh repository history to continue.');
        cursor.result ??= cursor.load().catch((cause: unknown) => {
          cursor.result = undefined;
          throw cause;
        });
        return cursor.result;
      }
      const history = await openRepositoryHistory(workspace, this.cacheRoot, request, savedHistory(this.db, workspace.id));
      const advance = (): Promise<HistoryPage> => history.advance(() => {
        const cursor = this.nextHistoryCursor++;
        assert.ok(Number.isSafeInteger(cursor) && cursor > 0);
        if (this.historyCursors.size >= 32) this.historyCursors.delete(this.historyCursors.keys().next().value!);
        this.historyCursors.set(cursor, { key, load: advance });
        assert.ok(this.historyCursors.size <= 32);
        return cursor;
      });
      return advance();
    });
  }

  detail(request: DetailRequest) {
    return this.whileOpen(async () => {
      const workspace = this.workspace(request.workspaceId);
      const { kind, ref } = request;
      try {
        if (kind === 'commit') return await withCommitSnapshot(workspace, this.cacheRoot, path => readChangeDetail(path, workspace, kind, ref));
        return await readChangeDetail(workspace.kind === 'git' ? workspace.source : null, workspace, kind, ref);
      } catch (cause) {
        if (!(cause instanceof DomainError) || cause.code === 'GITHUB_PULL_REQUEST_MOVED') throw cause;
        const matches = savedHistory(this.db, workspace.id).filter(node =>
          node.kind === kind && (kind === 'pr' ? node.ref === ref : node.ref.startsWith(ref.toLowerCase())));
        if (matches.length !== 1) throw cause;
        const node = matches[0]!;
        assert.equal(node.kind, kind);
        return { node, files: [], fileCount: 0, additions: 0, deletions: 0, partial: true, savedOnly: true, statsCoverage: 'unavailable' as const,
          coverageNote: cause.message + ' Showing the saved change. File and line totals are unavailable.' };
      }
    });
  }

  saved(request: SavedRequest) { return latestBrief(this.db, request); }

  preview(request: RepoRequest) { return this.whileOpen(() => this.prepare(request)); }

  private async prepare(request: RepoRequest) {
    const pending = this.staged.get(request.workspaceId);
    if (pending && request.selection.kind !== 'baseline') throw new DomainError('INVALID_REPO', 'Add this repository before reading changes.');
    const workspace = pending?.workspace ?? this.workspace(request.workspaceId);
    const listed = request.selection.kind === 'baseline' ? this.inventories.get(workspace.id + '/' + request.selection.commit) : undefined;
    const prepare = (path: string | null) => prepareSource(this.db, path, workspace, request, listed?.inventory);
    const source = request.selection.kind === 'commit' ? await withCommitSnapshot(workspace, this.cacheRoot, prepare)
      : await prepare(workspace.kind === 'github' && request.selection.kind === 'pr' ? null
        : listed?.path ?? await repositoryPath(workspace, this.cacheRoot));
    if (this.closed) throw new DomainError('REPO_CLOSED', 'Delve is closing.');
    if (this.previews.size >= 12) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(source.preview.token, source);
    return source.preview;
  }

  async generate(token: string, requestId: string) {
    const source = this.previews.get(token);
    if (!source || this.closed) throw new DomainError('STALE_PREVIEW', 'Review the repository request again before sending it.');
    if (this.runs.has(requestId)) throw new DomainError('DUPLICATE_REQUEST', 'This request is already running.');
    if (!getWorkspace(this.db, source.request.workspaceId)) throw new DomainError('UNCONFIRMED_REPO', 'Confirm the repository before building its map.');
    const cached = useCachedGeneration(this.db, source);
    if (cached) return cached;
    const controller = new AbortController();
    this.runs.set(requestId, controller);
    try {
      const base = { provider: source.request.provider, model: source.preview.model ?? undefined, prompt: source.preview.prompt,
        cacheKey: digest([source.cacheKey, source.preview.prompt]), signal: controller.signal };
      const runChange = () => this.runner.run({ ...base, schema: changeReply, jsonSchema: formats.change });
      const reply = source.request.selection.kind === 'baseline'
        ? await this.runner.run({ ...base, schema: baselineReply, jsonSchema: formats.baseline })
        : source.request.depth === 'high' ? await withPlainLanguageRetry(runChange, result => changeLanguageIssue(result.value))
          : await runChange();
      if (controller.signal.aborted) throw new DomainError('PROVIDER_CANCELLED', 'The repository request was cancelled.');
      return persistGeneration(this.db, source, reply.value);
    } finally { this.runs.delete(requestId); }
  }

  cancel(id: string): boolean {
    const controller = this.runs.get(id);
    controller?.abort();
    return controller !== undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.previews.clear();

    for (const controller of this.runs.values()) controller.abort();
    assert.ok([...this.runs.values()].every(c => c.signal.aborted));
    await Promise.allSettled(this.reads);
    this.inventories.clear();
    this.staged.clear();
    this.historyCursors.clear();
    assert.equal(this.reads.size, 0);
  }
}
