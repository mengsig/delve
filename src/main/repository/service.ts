import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Workspace } from '../../shared/domain';
import type { RepositoryInventory, RepoRequest, SavedRequest } from '../../shared/repository';
import { DomainError } from '../../shared/errors';
import type { Db } from '../db/connection';
import { isDemoWorkspace } from '../db/demo';
import { getWorkspace } from '../db/workspaces';
import type { ProviderRunner } from '../providers/runner';
import { listChanges, listFiles, repositoryPath } from './source';
import { prepareSource } from './preview';
import { baselineReply, changeReply } from './schemas';
import { digest, useCachedGeneration, latestBrief, persistGeneration, savedChanges, type ApprovedSource } from './store';

function outputSchema(schema: typeof baselineReply | typeof changeReply) {
  return z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any', override: ({ jsonSchema }) => {
    for (const field of ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) delete jsonSchema[field];
  } });
}

const formats = { baseline: outputSchema(baselineReply), change: outputSchema(changeReply) };

export class RepositoryLearning {
  private readonly previews = new Map<string, ApprovedSource>();
  private readonly inventories = new Map<string, RepositoryInventory>();
  private readonly runs = new Map<string, AbortController>();
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

  files(id: string) { return this.whileOpen(() => this.inventory(id)); }

  private async inventory(id: string): Promise<RepositoryInventory> {
    const inventory = await listFiles(await repositoryPath(this.workspace(id), this.cacheRoot));
    const key = id + '/' + inventory.commit;
    if (this.inventories.size >= 12) this.inventories.delete(this.inventories.keys().next().value!);
    this.inventories.set(key, inventory);
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

  saved(request: SavedRequest) { return latestBrief(this.db, request); }

  preview(request: RepoRequest) { return this.whileOpen(() => this.prepare(request)); }

  private async prepare(request: RepoRequest) {
    const workspace = this.workspace(request.workspaceId);
    const path = workspace.kind === 'github' && request.selection.kind === 'pr'
      ? null : await repositoryPath(workspace, this.cacheRoot);
    const inventory = request.selection.kind === 'baseline' ? this.inventories.get(workspace.id + '/' + request.selection.commit) : undefined;
    const source = await prepareSource(this.db, path, workspace, request, inventory);
    if (this.closed) throw new DomainError('REPO_CLOSED', 'Delve is closing.');
    if (this.previews.size >= 12) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(source.preview.token, source);
    return source.preview;
  }

  async generate(token: string, requestId: string) {
    const source = this.previews.get(token);
    if (!source || this.closed) throw new DomainError('STALE_PREVIEW', 'Review the repository request again before sending it.');
    if (this.runs.has(requestId)) throw new DomainError('DUPLICATE_REQUEST', 'This request is already running.');
    const cached = useCachedGeneration(this.db, source);
    if (cached) return cached;
    const controller = new AbortController();
    this.runs.set(requestId, controller);
    try {
      const base = { provider: source.request.provider, model: source.preview.model, prompt: source.preview.prompt,
        cacheKey: digest([source.cacheKey, source.preview.prompt]), signal: controller.signal };
      const reply = source.request.selection.kind === 'baseline'
        ? await this.runner.run({ ...base, schema: baselineReply, jsonSchema: formats.baseline })
        : await this.runner.run({ ...base, schema: changeReply, jsonSchema: formats.change });
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
    assert.equal(this.reads.size, 0);
  }
}
