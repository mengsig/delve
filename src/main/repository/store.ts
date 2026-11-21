import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChangeRef, ChangeBrief, GenerationResult, RepoPreview, RepoRequest, SavedRequest } from '../../shared/repository';
import { DomainError } from '../../shared/errors';
import { addPrerequisiteInTransaction, conceptStorageKey, getConceptByKey, upsertConceptInTransaction, type Concept } from '../db/concepts';
import { nowIso, transaction, type Db } from '../db/connection';
import { bindSnapshot, saveLessonInTransaction } from '../db/lessons';
import { documentSchema } from '../reader/document';
import { cacheModel, selectModel } from '../providers/model';
import { baselineReply, type ChangeReply, type GraphProposal } from './schemas';

export interface ApprovedSource {
  request: RepoRequest;
  preview: RepoPreview;
  cacheKey: string;
  revision: string;
  diff?: string;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function invalid(message: string): never { throw new DomainError('INVALID_PROPOSAL', message + ' Retry the request.'); }

function bindChangeConcepts(db: Db, source: ApprovedSource, snapshotId: number, reply: ChangeReply) {
  const workspaceId = source.request.workspaceId;
  const mapped = new Map<string, Concept>();
  const bind = db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
  for (const input of reply.concepts) {
    if (mapped.has(input.key)) invalid('The provider supplied a duplicate concept key.');
    const existing = getConceptByKey(db, conceptStorageKey(input.key, input.portable, workspaceId));
    const reviewed = existing && db.prepare('SELECT 1 FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ? AND on_atlas = 1')
      .get(workspaceId, existing.id);
    const key = existing || input.portable ? input.key : 'change/' + digest([source.revision, input.key]);
    const concept = upsertConceptInTransaction(db, { ...input, workspaceId, key,
      title: existing?.title ?? input.title, summary: existing?.summary ?? input.summary }, false);
    // Reading a PR may add a discussion, but cannot move an established concept to a different commit.
    if (!reviewed) bind.run(snapshotId, concept.id);
    mapped.set(input.key, concept);
  }
  for (const edge of reply.edges) {
    if (!mapped.has(edge.concept) || !mapped.has(edge.prerequisite)) invalid('A prerequisite is missing from the change proposal.');
  }
  assert.equal(mapped.size, reply.concepts.length);
  return mapped;
}

function mergeBaseline(db: Db, workspaceId: string, snapshotId: number, proposal: Extract<GraphProposal, {schema: 'delve.map/1'}>) {
  assert.ok(db.isTransaction);
  const mapped = new Map<string, Concept>();
  const bind = db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
  for (const input of proposal.concepts) {
    if (mapped.has(input.key)) invalid('The provider supplied a duplicate concept key.');
    const canonical = input.portable ? getConceptByKey(db, input.key) : null;
    const concept = upsertConceptInTransaction(db, { ...input, workspaceId,
      title: canonical?.title ?? input.title, summary: canonical?.summary ?? input.summary });
    bind.run(snapshotId, concept.id);
    mapped.set(input.key, concept);
  }
  for (const edge of proposal.edges) {
    const from = mapped.get(edge.concept);
    const prerequisite = mapped.get(edge.prerequisite);
    if (!from || !prerequisite) invalid('A prerequisite refers to a concept outside this proposal.');
    addPrerequisiteInTransaction(db, from.id, prerequisite.id);
  }
  assert.equal(mapped.size, proposal.concepts.length);
  return mapped;
}

function saveBrief(db: Db, source: ApprovedSource, snapshotId: number, reply: ChangeReply, concepts: Map<string, Concept>): ChangeBrief {
  const { request, preview, cacheKey } = source;
  assert.notEqual(request.selection.kind, 'baseline');
  const localKey = 'change/' + digest([source.revision, request.provider, preview.model]);
  const change = upsertConceptInTransaction(db, { workspaceId: request.workspaceId, key: localKey, portable: false,
    title: preview.title, summary: reply.summary }, false);
  db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)').run(snapshotId, change.id);
  const trace = request.depth === 'high' ? [] : reply.trace;
  const excerpt = request.depth === 'low' ? reply.excerpt : [];
  if (excerpt.length && !('\n' + (source.diff ?? '') + '\n').includes('\n' + excerpt.join('\n') + '\n')) invalid('The source excerpt does not occur in the approved diff.');
  const mechanics = request.depth === 'high' ? null : reply.mechanics;
  const boundary = request.depth === 'low' ? reply.boundary : null;
  const document = documentSchema.parse({ schema: 'delve.lesson/1', source: preview.commit, blocks: [
    { type: 'prose', heading: 'What changed', text: reply.what }, { type: 'prose', heading: 'Why it changed', text: reply.why },
    ...(mechanics ? [{ type: 'prose', heading: 'How it works', text: mechanics }] : []),
    ...(boundary ? [{ type: 'prose', heading: 'Protocol edge', text: boundary }] : []),
    { type: 'comparison', heading: 'Before → after', before: reply.before, after: reply.after },
    ...(trace.length ? [{ type: 'diagram', nodes: trace }] : []),
    ...(excerpt.length ? [{ type: 'code', source: 'Approved diff', lines: excerpt }] : []),
    ...(preview.partial ? [{ type: 'callout', heading: 'Partial coverage', text: preview.coverageNote ?? 'This brief covers only the available excerpts.' }] : []),
  ] });
  saveLessonInTransaction(db, { workspaceId: request.workspaceId, snapshotId, conceptId: change.id, cacheKey,
    depth: request.depth, model: cacheModel(preview.model), provider: request.provider, schemaVersion: document.schema, body: document });
  const touched = [...new Set(reply.touched)].map(key => {
    const concept = concepts.get(key);
    if (!concept) invalid('The change footprint refers to an unknown concept.');
    return { id: concept.id, title: concept.title };
  });
  const target = reply.recommendation.key === null ? change : concepts.get(reply.recommendation.key);
  if (!target) invalid('The change recommendation refers to an unknown concept.');
  return { conceptId: change.id, title: preview.title, summary: reply.summary, what: reply.what, why: reply.why,
    before: reply.before, after: reply.after, base: preview.base, commit: preview.commit, files: preview.files, partial: preview.partial, mechanics, boundary, coverageNote: preview.coverageNote, touched, trace, excerpt,
    recommendation: { conceptId: target.id, title: target.title, reason: reply.recommendation.reason } };
}

export function cachedGeneration(db: Db, cacheKey: string): GenerationResult | null {
  const row = db.prepare('SELECT result FROM repository_generations WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  assert.equal(typeof row.result, 'string');
  return JSON.parse(String(row.result)) as GenerationResult;
}

export function useCachedGeneration(db: Db, source: ApprovedSource): GenerationResult | null {
  const cached = cachedGeneration(db, source.cacheKey);
  if (!cached) return null;
  return transaction(db, () => {
    const row = db.prepare('SELECT snapshot_id, proposal FROM repository_generations WHERE cache_key = ?').get(source.cacheKey);
    assert.ok(row && typeof row.snapshot_id === 'number');
    if (cached.kind === 'baseline') {
      const proposal = baselineReply.parse(JSON.parse(String(row.proposal)));
      mergeBaseline(db, source.request.workspaceId, row.snapshot_id, proposal);
    }
    const updated = db.prepare(`UPDATE repository_generations SET last_used = (SELECT max(last_used) + 1 FROM repository_generations),
      created_at = ? WHERE cache_key = ?`).run(nowIso(), source.cacheKey);
    assert.equal(updated.changes, 1);
    return cached;
  });
}

export function savedChanges(db: Db, workspaceId: string): (ChangeRef & { title: string })[] {
  const rows = db.prepare(`SELECT kind, ref, json_extract(result, '$.brief.title') AS title FROM repository_generations
    WHERE workspace_id = ? AND kind <> 'baseline' GROUP BY kind, ref ORDER BY max(last_used) DESC LIMIT 100`).all(workspaceId);
  return rows.map(row => {
    assert.ok(row.kind === 'commit' || row.kind === 'pr');
    assert.ok(typeof row.ref === 'string' && typeof row.title === 'string');
    return { kind: row.kind, ref: row.ref, title: row.title };
  });
}

export function latestBrief(db: Db, request: SavedRequest): ChangeBrief | null {
  const ref = request.kind === 'commit' ? request.ref.toLowerCase() + '%' : request.ref;
  const rows = db.prepare(`SELECT result FROM repository_generations WHERE workspace_id = ? AND kind = ?
    AND ref LIKE ? AND depth = ? AND provider = ? AND model = ? AND schema_version = 'delve.change/1'
    GROUP BY ref ORDER BY max(last_used) DESC LIMIT 2`).all(request.workspaceId, request.kind, ref, request.depth, request.provider, cacheModel(selectModel(request.provider).model));
  if (rows.length !== 1 || !rows[0]) return null;
  const result = JSON.parse(String(rows[0].result)) as GenerationResult;
  assert.equal(result.kind, 'change');
  return result.brief;
}

export function persistGeneration(db: Db, source: ApprovedSource, proposal: GraphProposal): GenerationResult {
  const { cacheKey, request: { workspaceId, depth, provider, selection }, preview } = source;
  return transaction(db, () => {
    const existing = cachedGeneration(db, cacheKey);
    if (existing) return existing;
    assert.equal(selection.kind === 'baseline', proposal.schema === 'delve.map/1');
    const snapshotId = bindSnapshot(db, workspaceId, preview.commit);
    const concepts = proposal.schema === 'delve.map/1' ? mergeBaseline(db, workspaceId, snapshotId, proposal)
      : bindChangeConcepts(db, source, snapshotId, proposal);
    const result: GenerationResult = proposal.schema === 'delve.change/1'
      ? { kind: 'change', brief: saveBrief(db, source, snapshotId, proposal, concepts) } : { kind: 'baseline' };
    const next = result.kind === 'change' ? result.brief.recommendation.conceptId : concepts.get(proposal.recommendation.key ?? '')?.id;
    if (!next) invalid('The suggested first step refers to an unknown concept.');
    const ref = selection.kind === 'pr' ? selection.ref : preview.commit;
    db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth,
      provider, model, schema_version, result, proposal, next_concept, reason, created_at, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(last_used), 0) + 1 FROM repository_generations))`)
      .run(cacheKey, workspaceId, snapshotId, selection.kind, ref, depth, provider, cacheModel(preview.model), proposal.schema,
        JSON.stringify(result), JSON.stringify(proposal), next, proposal.recommendation.reason, nowIso());
    return result;
  });
}
