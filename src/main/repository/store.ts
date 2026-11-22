import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChangeRef, ChangeBrief, GenerationResult, RepoPreview, RepoRequest, SavedRequest } from '../../shared/repository';
import { DEPTHS, type Depth } from '../../shared/domain';
import { portableProofAtDepth } from '../db/evidence';
import { changeApplicationReason } from '../db/graph-suggestions';
import { DomainError } from '../../shared/errors';
import { addPrerequisiteInTransaction, conceptStorageKey, getConcept, getConceptByKey, upsertConceptInTransaction, type Concept } from '../db/concepts';
import { nowIso, transaction, type Db } from '../db/connection';
import { bindSnapshot, saveLessonInTransaction } from '../db/lessons';
import { documentSchema } from '../reader/document';
import type { HistoryNode } from '../../shared/explorer';
import { bindConceptSpans } from './concept-spans';
import { cacheModel, selectModel } from '../providers/model';
import { baselineReply, type ChangeReply, type GraphProposal } from './schemas';
import { portableConceptLookup } from './portable-concepts';

export interface ApprovedSource {
  request: RepoRequest;
  preview: RepoPreview;
  cacheKey: string;
  revision: string;
  diff?: string;
  patches?: { path: string; patch: string }[];
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function invalid(message: string): never { throw new DomainError('INVALID_PROPOSAL', message + ' Retry the request.'); }

function proposalConceptLookup(db: Db, workspaceId: string) {
  const portable = portableConceptLookup(db);
  const alias = db.prepare(`SELECT c.key FROM concept_identity_links link JOIN concepts c ON c.id = link.portable_concept_id
    WHERE link.legacy_concept_id = ?`);
  return (input: GraphProposal['concepts'][number]) => {
    if (input.portable) return { ...input, ...portable(input.key, input.title) };
    const local = getConceptByKey(db, conceptStorageKey(input.key, false, workspaceId));
    const canonical = local && alias.get(local.id);
    if (typeof canonical?.key === 'string') return { ...input, ...portable(canonical.key, input.title), portable: true };
    return { ...input, concept: local };
  };
}

function bindChangeConcepts(db: Db, source: ApprovedSource, snapshotId: number, reply: ChangeReply) {
  const workspaceId = source.request.workspaceId;
  const mapped = new Map<string, Concept>();
  const bind = db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
  const lookup = proposalConceptLookup(db, workspaceId);
  for (const input of reply.concepts) {
    if (mapped.has(input.key)) invalid('The provider supplied a duplicate concept key.');
    const { concept: existing, ...resolved } = lookup(input);
    const reviewed = existing && db.prepare('SELECT 1 FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ? AND on_atlas = 1')
      .get(workspaceId, existing.id);
    const key = existing || resolved.portable ? resolved.key : 'change/' + digest([source.revision, input.key]);
    const concept = upsertConceptInTransaction(db, { ...resolved, workspaceId, key,
      title: existing?.title ?? input.title, summary: existing?.summary ?? input.summary }, false);
    // Reading a PR may add a discussion, but cannot move an established concept to a different commit.
    if (!reviewed) bind.run(snapshotId, concept.id);
    mapped.set(input.key, concept);
  }
  for (const edge of reply.edges) {
    const from = mapped.get(edge.concept);
    const prerequisite = mapped.get(edge.prerequisite);
    if (!from || !prerequisite) invalid('A prerequisite is missing from the change proposal.');
    const reviewed = db.prepare('SELECT on_atlas FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ?').get(workspaceId, from.id);
    if (!from.portable && reviewed?.on_atlas === 0) addPrerequisiteInTransaction(db, from.id, prerequisite.id);
  }
  assert.equal(mapped.size, reply.concepts.length);
  return mapped;
}

function mergeBaseline(db: Db, workspaceId: string, snapshotId: number, proposal: Extract<GraphProposal, {schema: 'delve.map/1'}>) {
  assert.ok(db.isTransaction);
  const mapped = new Map<string, Concept>();
  const bind = db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
  const lookup = proposalConceptLookup(db, workspaceId);
  const migrated = new Set<string>();
  for (const input of proposal.concepts) {
    if (mapped.has(input.key)) invalid('The provider supplied a duplicate concept key.');
    const { concept: existing, ...resolved } = lookup(input);
    const canonical = resolved.portable ? existing : null;
    if (!input.portable && resolved.portable) migrated.add(input.key);
    const concept = upsertConceptInTransaction(db, { ...resolved, workspaceId,
      title: canonical?.title ?? input.title, summary: canonical?.summary ?? input.summary });
    bind.run(snapshotId, concept.id);
    mapped.set(input.key, concept);
  }
  for (const edge of proposal.edges) {
    const from = mapped.get(edge.concept);
    const prerequisite = mapped.get(edge.prerequisite);
    if (!from || !prerequisite) invalid('A prerequisite refers to a concept outside this proposal.');
    if (from.id === prerequisite.id && edge.concept !== edge.prerequisite) continue;
    if (migrated.has(edge.concept)) continue;
    addPrerequisiteInTransaction(db, from.id, prerequisite.id);
  }
  assert.equal(mapped.size, proposal.concepts.length);
  return mapped;
}

function recommendation(proposal: GraphProposal, concepts: Map<string, Concept>) {
  const key = proposal.recommendation.key;
  if (key === null) return null;
  const target = concepts.get(key);
  if (!target) invalid('The suggested first step refers to an unknown concept.');
  return { conceptId: target.id, title: target.title, reason: proposal.recommendation.reason };
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
  const touchedIds = new Map<string, number>();
  const touched = [...new Set(reply.touched)].map(key => {
    const concept = concepts.get(key);
    if (!concept) invalid('The change footprint refers to an unknown concept.');
    touchedIds.set(key, concept.id);
    return { id: concept.id, title: concept.title };
  });
  const foundations = new Set(reply.edges.filter(edge => touchedIds.has(edge.concept)).map(edge => edge.prerequisite));
  for (const [key, concept] of concepts) {
    if (concept.portable && (foundations.has(key) || touchedIds.has(key))) addPrerequisiteInTransaction(db, change.id, concept.id);
  }
  const spans = bindConceptSpans(reply.spans, source.patches ?? [], touchedIds);
  const suggested = recommendation(reply, concepts) ?? { conceptId: change.id, title: change.title,
    reason: reply.recommendation.reason };
  return { conceptId: change.id, title: preview.title, summary: reply.summary, what: reply.what, why: reply.why,
    before: reply.before, after: reply.after, base: preview.base, commit: preview.commit, files: preview.files, spans, partial: preview.partial, mechanics, boundary, coverageNote: preview.coverageNote, touched, trace, excerpt,
    recommendation: suggested };
}

function projectSavedChange(db: Db, result: GenerationResult, depth: Depth): GenerationResult {
  if (result.kind !== 'change') return result;
  const { brief } = result;
  const find = db.prepare(`SELECT c.id, c.title FROM concept_identity_links l JOIN concepts c ON c.id = l.portable_concept_id
    WHERE l.legacy_concept_id = ?`);
  const canonical = new Map<number, { id: number; title: string }>();
  const ids = new Set([...brief.touched.map(c => c.id), brief.recommendation.conceptId]);
  for (const id of ids) {
    const concept = find.get(id);
    if (!concept) continue;
    assert.ok(typeof concept.id === 'number' && concept.id !== id);
    assert.ok(typeof concept.title === 'string');
    canonical.set(id, { id: concept.id, title: concept.title });
  }
  const target = canonical.get(brief.recommendation.conceptId);
  const savedTarget = getConcept(db, target?.id ?? brief.recommendation.conceptId);
  const mastered = savedTarget?.portable && portableProofAtDepth(db, savedTarget.id, depth);
  if (!canonical.size && !mastered) return result;
  const touched = brief.touched.map(concept => canonical.get(concept.id) ?? concept);
  const spans = brief.spans?.map(span => ({ ...span, conceptId: canonical.get(span.conceptId)?.id ?? span.conceptId }));
  const recommendation = mastered ? { conceptId: brief.conceptId, title: brief.title, reason: changeApplicationReason }
    : target ? { ...brief.recommendation, conceptId: target.id, title: target.title } : brief.recommendation;
  return { kind: 'change', brief: { ...brief, touched: [...new Map(touched.map(c => [c.id, c])).values()], spans, recommendation } };
}

export function cachedGeneration(db: Db, cacheKey: string): GenerationResult | null {
  const row = db.prepare('SELECT result, depth FROM repository_generations WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  assert.equal(typeof row.result, 'string');
  assert.ok(typeof row.depth === 'string' && DEPTHS.includes(row.depth as Depth));
  return projectSavedChange(db, JSON.parse(String(row.result)) as GenerationResult, row.depth as Depth);
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

export function savedHistory(db: Db, workspaceId: string): HistoryNode[] {
  const rows = db.prepare(`SELECT kind, ref, json_extract(result, '$.brief.title') AS title,
    json_extract(result, '$.brief.commit') AS head FROM repository_generations
    WHERE workspace_id = ? AND kind <> 'baseline' GROUP BY kind, ref ORDER BY max(last_used) DESC LIMIT 100`).all(workspaceId);
  return rows.map(row => {
    assert.ok(row.kind === 'commit' || row.kind === 'pr');
    assert.ok(typeof row.ref === 'string' && typeof row.title === 'string' && typeof row.head === 'string');
    return { kind: row.kind, ref: row.ref, title: row.title, head: row.head, date: '', author: '',
      branches: [], parents: row.kind === 'pr' ? [row.head] : [] };
  });
}

export function savedChanges(db: Db, workspaceId: string): (ChangeRef & { title: string })[] {
  return savedHistory(db, workspaceId).map(({ kind, ref, title }) => ({ kind, ref, title }));
}

export function latestBrief(db: Db, request: SavedRequest): ChangeBrief | null {
  const ref = request.kind === 'commit' ? request.ref.toLowerCase() + '%' : request.ref;
  const rows = db.prepare(`SELECT result FROM repository_generations WHERE workspace_id = ? AND kind = ?
    AND ref LIKE ? AND depth = ? AND provider = ? AND model = ? AND schema_version = 'delve.change/1'
    GROUP BY ref ORDER BY max(last_used) DESC LIMIT 2`).all(request.workspaceId, request.kind, ref, request.depth, request.provider, cacheModel(selectModel(request.provider).model));
  if (rows.length !== 1 || !rows[0]) return null;
  const result = projectSavedChange(db, JSON.parse(String(rows[0].result)) as GenerationResult, request.depth);
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
    const next = result.kind === 'change' ? result.brief.recommendation : recommendation(proposal, concepts);
    if (!next) invalid('The suggested first step refers to an unknown concept.');
    const ref = selection.kind === 'pr' ? selection.ref : preview.commit;
    db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth,
      provider, model, schema_version, result, proposal, next_concept, reason, created_at, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(last_used), 0) + 1 FROM repository_generations))`)
      .run(cacheKey, workspaceId, snapshotId, selection.kind, ref, depth, provider, cacheModel(preview.model), proposal.schema,
        JSON.stringify(result), JSON.stringify(proposal), next.conceptId, next.reason, nowIso());
    return projectSavedChange(db, result, depth);
  });
}
