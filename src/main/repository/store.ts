import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChangeRef, ChangeBrief, GenerationResult, RepoPreview, RepoRequest, SavedRequest } from '../../shared/repository';
import { DEPTHS, type Depth } from '../../shared/domain';
import { portableProofAtDepth } from '../db/evidence';
import { changeApplicationReason } from '../db/graph-suggestions';
import { DomainError } from '../../shared/errors';
import { addPrerequisiteInTransaction, canonicalConceptId, conceptStorageKey, getConcept, getConceptByKey, upsertConceptInTransaction, type Concept } from '../db/concepts';
import { nowIso, transaction, type Db } from '../db/connection';
import { bindSnapshot, saveLessonInTransaction } from '../db/lessons';
import { documentSchema } from '../reader/document';
import type { HistoryNode } from '../../shared/explorer';
import { bindConceptSpans } from './concept-spans';
import { plainConceptTitle } from '../../shared/plain-language';
import { cacheModel, selectModel } from '../providers/model';
import { baselineReply, type ChangeReply, type GraphProposal } from './schemas';
import { portableConceptLookup } from './portable-concepts';
import { baselineConceptFingerprint, compatibleConceptMeanings, compatibleDescriptions, compatiblePortableAliases, compatibleScopedMeanings, portableAlias } from '../db/portable-identity';
import { findPortableConcept } from '../db/portable-concepts';
import { saveFoundations } from '../tutor/foundation-progress';
import { resolveTutorPrerequisite } from '../db/tutor-prerequisites';
import { changeFootprintKey, changeIdentity, findChangeOverview, findScopedChangeKey, overviewKey, rememberChangeConcept, type ChangeConceptScope } from '../db/change-concept-identity';

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

type ProposalConcept = GraphProposal['concepts'][number];
type ResolvedConcept = Pick<ProposalConcept, 'key' | 'portable'> & { concept: Concept | null; fingerprint?: string; needsScope?: true };

function baselineScope(db: Db, workspaceId: string) {
  const registry = `SELECT c.key, s.fingerprint FROM scoped_proposal_concepts s JOIN concepts c ON c.id = s.concept_id
    LEFT JOIN concept_identity_links l ON l.legacy_concept_id = c.id
    WHERE s.workspace_id = ? AND c.workspace_id = s.workspace_id AND c.portable = 0 AND l.legacy_concept_id IS NULL`;
  const byFingerprint = db.prepare(registry + ' AND s.fingerprint = ?');
  const byKey = db.prepare(registry + ' AND c.key = ?');
  const find = (input: ProposalConcept): ResolvedConcept | null => {
    assert.ok(input.key && input.summary.trim());
    const fingerprint = baselineConceptFingerprint(input);
    const prefix = `ws/${workspaceId}/`;
    const row = byFingerprint.get(workspaceId, fingerprint)
      ?? (input.key.startsWith('ambiguous/') ? byKey.get(workspaceId, prefix + input.key) : null);
    if (!row) return null;
    assert.ok(typeof row.key === 'string' && row.key.startsWith(prefix));
    assert.ok(typeof row.fingerprint === 'string' && row.fingerprint.length === 64);
    const concept = getConceptByKey(db, row.key);
    assert.ok(concept && !concept.portable && concept.workspaceId === workspaceId);
    if (!compatibleScopedMeanings(input, { ...concept, key: input.key })) return null;
    return { key: concept.key.slice(prefix.length), portable: false, concept, fingerprint: row.fingerprint };
  };
  const allocate = (input: ProposalConcept): ResolvedConcept => {
    assert.ok(db.isTransaction);
    const prior = find(input);
    if (prior) return prior;
    const fingerprint = baselineConceptFingerprint(input);
    const prefix = 'ambiguous/' + fingerprint;
    let key = prefix;
    for (let suffix = 1; getConceptByKey(db, conceptStorageKey(key, false, workspaceId)); suffix++) key = prefix + '-' + suffix;
    return { key, portable: false, concept: null, fingerprint };
  };
  return { find, allocate };
}

function proposalConceptLookup(db: Db, workspaceId: string) {
  const portable = portableConceptLookup(db);
  const alias = db.prepare(`SELECT c.key FROM concept_identity_links link JOIN concepts c ON c.id = link.canonical_concept_id
    WHERE link.legacy_concept_id = ?`);
  const lookup = (input: ProposalConcept): ResolvedConcept => {
    const local = getConceptByKey(db, conceptStorageKey(input.key, false, workspaceId));
    const linked = local && alias.get(local.id);
    if (typeof linked?.key === 'string') {
      const canonical = getConceptByKey(db, linked.key);
      assert.ok(local && canonical, 'a migrated identity must point to a concept');
      assert.ok(canonical.portable, 'released identity links point to portable concepts');
      if (compatibleConceptMeanings(input, { ...local, key: input.key }) && compatibleConceptMeanings(input, canonical)) {
        return { ...input, key: canonical.key, concept: canonical, portable: true };
      }
      return { key: input.key, portable: false, concept: null, needsScope: true };
    }
    if (input.key.startsWith('ambiguous/')) return { key: input.key, portable: false, concept: null, needsScope: true };
    const localCompatible = local && compatibleConceptMeanings(input, { ...local, key: input.key });
    if (input.portable) {
      const resolved = portable(input.key, input.title, input.summary);
      if (resolved.portable) return { ...input, ...resolved };
      if (localCompatible) return { ...input, concept: local, portable: false };
      return { ...resolved, portable: false, needsScope: true };
    }
    return local && !localCompatible
      ? { key: input.key, portable: false, concept: null, needsScope: true }
      : { ...input, concept: local };
  };
  return lookup;
}

interface BaselineGroup {
  input: ProposalConcept;
  resolution: ResolvedConcept;
  dependents: Set<BaselineGroup>;
  local: boolean;
}

function groupBaselineConcepts(db: Db, workspaceId: string, proposal: GraphProposal, scope: ReturnType<typeof baselineScope>) {
  assert.ok(db.isTransaction);
  const lookup = proposalConceptLookup(db, workspaceId);
  const byMeaning = new Map<string, BaselineGroup>();
  const byKey = new Map<string, BaselineGroup>();
  for (const input of proposal.concepts) {
    if (byKey.has(input.key)) invalid('The provider supplied a duplicate concept key.');
    const resolution = scope.find(input) ?? lookup(input);
    const meaning = resolution.concept ? 'id/' + resolution.concept.id : baselineConceptFingerprint(input);
    let group = byMeaning.get(meaning);
    if (!group) {
      group = { input, resolution, dependents: new Set(), local: !resolution.portable };
      byMeaning.set(meaning, group);
    } else {
      if (group.resolution.key !== resolution.key || !resolution.portable) group.local = true;
      if (!resolution.portable && (group.resolution.portable || (group.resolution.needsScope && resolution.concept))) {
        group.resolution = resolution;
      }
    }
    byKey.set(input.key, group);
  }
  assert.equal(byKey.size, proposal.concepts.length);
  return { byMeaning, byKey };
}

function resolveBaselineConcepts(db: Db, workspaceId: string, proposal: Extract<GraphProposal, {schema: 'delve.map/1'}>) {
  const scope = baselineScope(db, workspaceId);
  const { byMeaning, byKey } = groupBaselineConcepts(db, workspaceId, proposal, scope);
  for (const edge of proposal.edges) {
    const concept = byKey.get(edge.concept);
    const prerequisite = byKey.get(edge.prerequisite);
    if (!concept || !prerequisite) invalid('A prerequisite refers to a concept outside this proposal.');
    prerequisite.dependents.add(concept);
  }
  const local = [...byMeaning.values()].filter(group => group.local);
  for (let i = 0; i < local.length; i++) {
    for (const dependent of local[i]!.dependents) {
      if (dependent.local) continue;
      dependent.local = true;
      local.push(dependent);
    }
  }
  for (const group of local) {
    const { input, resolution } = group;
    if (resolution.portable || resolution.needsScope) {
      group.resolution = scope.allocate(input);
    }
    assert.ok(!group.resolution.portable);
  }
  assert.equal(byKey.size, proposal.concepts.length);
  return byKey;
}

function rememberScopedConcept(db: Db, workspaceId: string, fingerprint: string | undefined, concept: Concept): void {
  if (!fingerprint) return;
  assert.ok(db.isTransaction && !concept.portable && concept.workspaceId === workspaceId);
  const binding = db.prepare(`INSERT INTO scoped_proposal_concepts (workspace_id, fingerprint, concept_id) VALUES (?, ?, ?)
    ON CONFLICT (workspace_id, fingerprint) DO UPDATE SET concept_id = excluded.concept_id
    WHERE scoped_proposal_concepts.concept_id = excluded.concept_id`).run(workspaceId, fingerprint, concept.id);
  assert.equal(binding.changes, 1, 'a scoped identity cannot be rebound');
}

function directChangeConcept(db: Db, workspaceId: string, input: ProposalConcept): ResolvedConcept | null {
  assert.ok(workspaceId && input.key);
  if (portableAlias(input.key, input.title) === null) return null;
  if (input.portable) {
    const concept = findPortableConcept(db, input);
    if (concept) return { key: concept.key, portable: true, concept };
    return getConceptByKey(db, input.key) ? null : { key: input.key, portable: true, concept: null };
  }
  const saved = getConceptByKey(db, conceptStorageKey(input.key, false, workspaceId));
  if (!saved || !compatibleConceptMeanings(input, { ...saved, key: input.key })) return null;
  const concept = getConcept(db, canonicalConceptId(db, saved.id));
  assert.ok(concept && (concept.portable || concept.workspaceId === workspaceId));
  if (!compatibleConceptMeanings(input, { ...concept, key: concept.portable ? concept.key : input.key })) return null;
  return { key: concept.portable ? concept.key : input.key, portable: concept.portable, concept };
}

function resolveChangeFootprint(db: Db, scope: ChangeConceptScope, overview: Concept, input: ProposalConcept, reply: ChangeReply,
  firstOverview: boolean): ResolvedConcept {
  assert.ok(db.isTransaction && !overview.portable && overview.workspaceId === scope.workspaceId);
  assert.ok(input.summary.trim());
  const { workspaceId } = scope;
  const prefix = `ws/${workspaceId}/`;
  const using = (concept: Concept) => ({ key: concept.portable ? concept.key : concept.key.slice(prefix.length), portable: concept.portable, concept });
  const prior = findScopedChangeKey(db, scope, input);
  if (prior) return using(prior);
  const direct = directChangeConcept(db, workspaceId, input);
  if (direct?.concept) return direct;
  const foundation = reply.foundations?.find(f => f.key === input.key && compatibleConceptMeanings(input, f));
  if (foundation) return using(resolveTutorPrerequisite(db, workspaceId, foundation));
  const alias = portableAlias(input.key, input.title);
  if (firstOverview && !input.portable && reply.overviewConceptKey === input.key
    && compatiblePortableAliases(alias, portableAlias('', overview.title))) return using(overview);
  if (direct) return direct;
  const stem = changeFootprintKey(scope, input);
  let key = stem;
  for (let suffix = 1; getConceptByKey(db, prefix + key); suffix++) key = stem + '-' + suffix;
  return { key, concept: null, portable: false };
}

function bindChangeConcepts(db: Db, scope: ChangeConceptScope, snapshotId: number, reply: ChangeReply, overview: Concept, firstOverview: boolean) {
  assert.ok(db.isTransaction && snapshotId > 0);
  const { workspaceId } = scope;
  assert.equal(overview.workspaceId, workspaceId);
  if (reply.overviewConceptKey && !reply.touched.includes(reply.overviewConceptKey)) invalid('The overview key must identify an affected concept.');
  const mapped = new Map<string, Concept>();
  const bind = db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
  if (reply.overviewConceptKey && !reply.concepts.some(c => c.key === reply.overviewConceptKey && !c.portable)) {
    invalid('The overview key must identify a local affected concept.');
  }
  for (const input of reply.concepts) {
    if (mapped.has(input.key)) invalid('The provider supplied a duplicate concept key.');
    const { concept: existing, ...resolved } = resolveChangeFootprint(db, scope, overview, input, reply, firstOverview);
    const reviewed = existing && db.prepare('SELECT 1 FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ? AND on_atlas = 1')
      .get(workspaceId, existing.id);
    const concept = upsertConceptInTransaction(db, { ...resolved, workspaceId,
      title: existing?.title ?? input.title, summary: existing?.summary ?? input.summary }, false);
    // Reading a PR may add a discussion, but cannot move an established concept to a different commit.
    if (!reviewed) bind.run(snapshotId, concept.id);
    rememberChangeConcept(db, scope, concept, input);
    mapped.set(input.key, concept);
  }
  for (const edge of reply.edges) {
    const from = mapped.get(edge.concept);
    const prerequisite = mapped.get(edge.prerequisite);
    if (!from || !prerequisite) invalid('A prerequisite is missing from the change proposal.');
    const reviewed = db.prepare('SELECT on_atlas FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ?').get(workspaceId, from.id);
    if (from.id === prerequisite.id && edge.concept !== edge.prerequisite) continue;
    if (!from.portable && reviewed?.on_atlas === 0) addPrerequisiteInTransaction(db, from.id, prerequisite.id);
  }
  assert.equal(mapped.size, reply.concepts.length);
  return mapped;
}

function mergeBaseline(db: Db, workspaceId: string, snapshotId: number, proposal: Extract<GraphProposal, {schema: 'delve.map/1'}>) {
  assert.ok(db.isTransaction);
  const mapped = new Map<string, Concept>();
  const bind = db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
  const resolvedConcepts = resolveBaselineConcepts(db, workspaceId, proposal);
  const migrated = new Set<string>();
  const saved = new Map<string, Concept>();
  for (const input of proposal.concepts) {
    const group = resolvedConcepts.get(input.key);
    assert.ok(group);
    const { concept: existing, fingerprint, ...resolved } = group.resolution;
    if (!input.portable && resolved.portable) migrated.add(input.key);
    const key = conceptStorageKey(resolved.key, resolved.portable, workspaceId);
    let concept = saved.get(key);
    if (!concept) {
      const canonical = fingerprint || resolved.portable ? existing : null;
      concept = upsertConceptInTransaction(db, { ...resolved, workspaceId,
        title: canonical?.title ?? input.title, summary: canonical?.summary ?? input.summary });
      rememberScopedConcept(db, workspaceId, fingerprint, concept);
      bind.run(snapshotId, concept.id);
      saved.set(key, concept);
    }
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

function saveChangeConcept(db: Db, source: ApprovedSource, reply: ChangeReply, scope: ChangeConceptScope, existing: Concept | null): Concept {
  const { request, preview } = source;
  assert.ok(db.isTransaction);
  assert.notEqual(request.selection.kind, 'baseline');
  const alreadyPlain = existing && db.prepare("SELECT 1 FROM lessons WHERE depth = 'high' AND concept_id = ? LIMIT 1").get(existing.id);
  const title = request.depth === 'high' ? reply.conceptTitle ?? plainConceptTitle(preview.title) : preview.title;
  const key = existing?.key.slice(('ws/' + scope.workspaceId + '/').length) ?? 'change/' + digest([overviewKey, scope.change]);
  const concept = existing && (request.depth !== 'high' || alreadyPlain) ? existing
    : upsertConceptInTransaction(db, { workspaceId: scope.workspaceId, key, portable: false, title, summary: reply.summary }, false);
  rememberChangeConcept(db, scope, concept);
  return concept;
}

// A foundation reuses its footprint's concept only when the footprint and that concept both mean the foundation itself.
function corroboratedFoundations(reply: ChangeReply, concepts: ReadonlyMap<string, Concept>): Map<string, Concept> {
  const bound = new Map<string, Concept>();
  for (const foundation of reply.foundations ?? []) {
    const input = reply.concepts.find(item => item.key === foundation.key);
    if (!input) continue;
    const concept = concepts.get(input.key);
    assert.ok(concept, 'every footprint was saved before its foundations');
    const sameReply = compatibleDescriptions(input.summary, foundation.summary)
      && compatiblePortableAliases(portableAlias(input.key, input.title), portableAlias(foundation.key, foundation.title));
    const saved = { ...concept, key: concept.portable ? concept.key : foundation.key };
    if (sameReply && compatibleConceptMeanings(foundation, saved)) bound.set(foundation.key, concept);
  }
  assert.ok(bound.size <= (reply.foundations?.length ?? 0));
  return bound;
}

function saveBrief(db: Db, source: ApprovedSource, snapshotId: number, reply: ChangeReply, change: Concept, concepts: Map<string, Concept>): ChangeBrief {
  const { request, preview, cacheKey } = source;
  assert.ok(db.isTransaction && snapshotId > 0);
  assert.notEqual(request.selection.kind, 'baseline');
  db.prepare('INSERT OR IGNORE INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)').run(snapshotId, change.id);
  const trace = request.depth === 'high' ? [] : [...new Set(reply.trace)];
  const excerpt = request.depth === 'low' ? reply.excerpt : [];
  if (excerpt.length && !('\n' + (source.diff ?? '') + '\n').includes('\n' + excerpt.join('\n') + '\n')) invalid('The source excerpt does not occur in the approved diff.');
  const mechanics = request.depth === 'high' ? null : reply.mechanics;
  const boundary = request.depth === 'low' ? reply.boundary : null;
  const example = request.depth === 'high' ? reply.example : null;
  const document = documentSchema.parse({ schema: 'delve.lesson/1', source: preview.commit, blocks: [
    { type: 'prose', heading: 'What changed', text: reply.what }, { type: 'prose', heading: 'Why it matters', text: reply.why },
    ...(mechanics ? [{ type: 'prose', heading: 'How it works', text: mechanics }] : []),
    ...(boundary ? [{ type: 'prose', heading: 'Protocol edge', text: boundary }] : []),
    { type: 'comparison', heading: 'Before → after', before: reply.before, after: reply.after },
    ...(example ? [{ type: 'analogy', heading: 'An everyday analogy', text: example }] : []),
    ...(trace.length ? [{ type: 'diagram', nodes: trace }] : []),
    ...(excerpt.length ? [{ type: 'code', source: 'Approved diff', lines: excerpt }] : []),
    ...(preview.partial && request.depth !== 'high' ? [{ type: 'callout', heading: 'Partial coverage', text: preview.coverageNote ?? 'This brief covers only the available excerpts.' }] : []),
  ] });
  const lesson = saveLessonInTransaction(db, { workspaceId: request.workspaceId, snapshotId, conceptId: change.id, cacheKey,
    depth: request.depth, model: cacheModel(preview.model), provider: request.provider, schemaVersion: document.schema, body: document });
  if (reply.foundations) saveFoundations(db, { workspaceId: request.workspaceId, canonicalConceptId: change.id, depth: request.depth },
    lesson.id, reply.foundations, corroboratedFoundations(reply, concepts));
  const touchedIds = new Map<string, number>();
  const touched = new Map<number, { id: number; title: string }>();
  for (const key of reply.touched) {
    const concept = concepts.get(key);
    if (!concept) invalid('The change footprint refers to an unknown concept.');
    touchedIds.set(key, concept.id);
    touched.set(concept.id, { id: concept.id, title: concept.title });
  }
  const foundations = new Set(reply.edges.filter(edge => touchedIds.has(edge.concept)).map(edge => edge.prerequisite));
  for (const [key, concept] of concepts) {
    if (concept.portable && (foundations.has(key) || touchedIds.has(key))) addPrerequisiteInTransaction(db, change.id, concept.id);
  }
  const spans = bindConceptSpans(reply.spans, source.patches ?? [], touchedIds);
  const suggested = recommendation(reply, concepts) ?? { conceptId: change.id, title: change.title,
    reason: reply.recommendation.reason };
  return { conceptId: change.id, lessonId: lesson.id, title: preview.title, summary: reply.summary, what: reply.what, why: reply.why, ...(example ? { example } : {}),
    before: reply.before, after: reply.after, base: preview.base, commit: preview.commit, files: preview.files, spans, partial: preview.partial, mechanics, boundary, coverageNote: preview.coverageNote, touched: [...touched.values()], trace, excerpt,
    recommendation: suggested };
}

function projectSavedChange(db: Db, result: GenerationResult, depth: Depth): GenerationResult {
  if (result.kind !== 'change') return result;
  const trace = [...new Set(result.brief.trace)];
  const brief = trace.length === result.brief.trace.length ? result.brief : { ...result.brief, trace };
  const find = db.prepare(`SELECT c.id, c.title FROM concept_identity_links l JOIN concepts c ON c.id = l.canonical_concept_id
    WHERE l.legacy_concept_id = ?`);
  const canonical = new Map<number, { id: number; title: string }>();
  const ids = new Set([brief.conceptId, ...brief.touched.map(c => c.id), brief.recommendation.conceptId]);
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
  if (!canonical.size && !mastered) return { kind: 'change', brief };
  const touched = brief.touched.map(concept => canonical.get(concept.id) ?? concept);
  const spans = brief.spans?.map(span => ({ ...span, conceptId: canonical.get(span.conceptId)?.id ?? span.conceptId }));
  const conceptId = canonical.get(brief.conceptId)?.id ?? brief.conceptId;
  const recommendation = mastered ? { conceptId, title: brief.title, reason: changeApplicationReason }
    : target ? { ...brief.recommendation, conceptId: target.id, title: target.title } : brief.recommendation;
  return { kind: 'change', brief: { ...brief, conceptId, touched: [...new Map(touched.map(c => [c.id, c])).values()], spans, recommendation } };
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
      const concepts = mergeBaseline(db, source.request.workspaceId, row.snapshot_id, proposal);
      const next = recommendation(proposal, concepts);
      if (!next) invalid('The suggested first step refers to an unknown concept.');
      db.prepare('UPDATE repository_generations SET next_concept = ?, reason = ? WHERE cache_key = ?')
        .run(next.conceptId, next.reason, source.cacheKey);
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
    const ref = selection.kind === 'pr' ? selection.ref : preview.commit;
    let concepts: Map<string, Concept>;
    let result: GenerationResult;
    if (proposal.schema === 'delve.change/1') {
      assert.ok(selection.kind !== 'baseline');
      const scope = { workspaceId, change: changeIdentity(selection.kind, ref, preview.base, preview.commit) };
      const existing = findChangeOverview(db, scope);
      const change = saveChangeConcept(db, source, proposal, scope, existing);
      concepts = bindChangeConcepts(db, scope, snapshotId, proposal, change, existing === null);
      result = { kind: 'change', brief: saveBrief(db, source, snapshotId, proposal, change, concepts) };
    } else {
      concepts = mergeBaseline(db, workspaceId, snapshotId, proposal);
      result = { kind: 'baseline' };
    }
    const next = result.kind === 'change' ? result.brief.recommendation : recommendation(proposal, concepts);
    if (!next) invalid('The suggested first step refers to an unknown concept.');
    db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth,
      provider, model, schema_version, result, proposal, next_concept, reason, created_at, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(last_used), 0) + 1 FROM repository_generations))`)
      .run(cacheKey, workspaceId, snapshotId, selection.kind, ref, depth, provider, cacheModel(preview.model), proposal.schema,
        JSON.stringify(result), JSON.stringify(proposal), next.conceptId, next.reason, nowIso());
    return projectSavedChange(db, result, depth);
  });
}
