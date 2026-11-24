import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors';
import { addPrerequisiteInTransaction, canonicalConceptId, conceptStorageKey, getConcept, getConceptByKey, upsertConceptInTransaction, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleDescriptions, compatiblePortableAliases, normalizedConceptName, portableAlias } from './portable-identity';
import { canonicalEdges, edgeReachable } from './migration-edges';
import { getWorkspace } from './workspaces';

type Candidate = { key: string; title: string; summary: string };
type Selection = { concept: Concept; candidateKey: string };

function variantKey(candidate: Candidate): string {
  const key = conceptStorageKey(candidate.key, true);
  const definition = normalizedConceptName(candidate.summary);
  assert.ok(definition);
  assert.ok(candidate.title.trim());
  return 'foundation/' + createHash('sha256').update(JSON.stringify([key, definition])).digest('hex');
}

export function findTutorPrerequisite(db: Db, workspaceId: string, candidate: Candidate, portableOnly = false): Concept | null {
  const key = conceptStorageKey(candidate.key, true);
  const prefix = `ws/${workspaceId}/`;
  const alias = portableAlias(key, candidate.title);
  assert.ok(workspaceId && candidate.title.trim());
  assert.ok(candidate.summary.trim());
  const keys = [key, variantKey(candidate)];
  if (!portableOnly) keys.unshift(prefix + key);
  for (const storedKey of keys) {
    const saved = getConceptByKey(db, storedKey);
    if (!saved || !compatibleDescriptions(candidate.summary, saved.summary)) continue;
    const concept = getConcept(db, canonicalConceptId(db, saved.id));
    assert.ok(concept && (concept.portable || concept.workspaceId === workspaceId));
    if (portableOnly && !concept.portable) continue;
    const unscoped = concept.portable ? concept.key : concept.key.slice(prefix.length);
    if (compatibleDescriptions(candidate.summary, concept.summary) &&
      compatiblePortableAliases(alias, portableAlias(unscoped, concept.title))) return concept;
  }
  return null;
}

export function resolveTutorPrerequisite(db: Db, workspaceId: string, candidate: Candidate, portableOnly = false): Concept {
  assert.ok(db.isTransaction);
  assert.ok(workspaceId && candidate.summary.trim());
  const match = findTutorPrerequisite(db, workspaceId, candidate, portableOnly);
  if (match) return match;
  const preferred = conceptStorageKey(candidate.key, true);
  const key = getConceptByKey(db, preferred) || portableAlias(preferred, candidate.title) === null ? variantKey(candidate) : preferred;
  if (getConceptByKey(db, key)) throw new DomainError('CONCEPT_CONFLICT', `Concept key "${key}" is unavailable.`);
  return upsertConceptInTransaction(db, { ...candidate, key, portable: true }, false);
}

function linkToAtlas(db: Db, workspaceId: string, conceptId: number): void {
  const result = db.prepare(`INSERT INTO workspace_concepts (workspace_id, concept_id, on_atlas) VALUES (?, ?, 1)
    ON CONFLICT (workspace_id, concept_id) DO UPDATE SET on_atlas = 1`).run(workspaceId, conceptId);
  assert.equal(result.changes, 1, 'atlas membership must be written');
}

function bottomUp(db: Db, concepts: Selection[]): Selection[] {
  if (concepts.length < 2) return concepts;
  const selected = new Set(concepts.map(c => c.concept.id));
  assert.equal(selected.size, concepts.length, 'selected concepts must be unique');
  const edges = canonicalEdges(db);
  const pending = new Map(concepts.map(c => [c.concept.id, new Set([...selected]
    .filter(id => id !== c.concept.id && edgeReachable(edges, c.concept.id, id)))]));
  const ordered: Selection[] = [];
  while (ordered.length < concepts.length) {
    const next = concepts.find(c => pending.has(c.concept.id) && pending.get(c.concept.id)!.size === 0);
    assert.ok(next, 'selected prerequisites must form a directed acyclic graph');
    pending.delete(next.concept.id);
    for (const dependencies of pending.values()) dependencies.delete(next.concept.id);
    ordered.push(next);
  }
  assert.equal(ordered.length, selected.size);
  return ordered;
}

export function persistTutorPrerequisites(db: Db, workspaceId: string, conceptId: number, candidates: readonly Candidate[],
  bound: ReadonlyMap<string, Concept> = new Map()): Selection[] {
  assert.ok(db.isTransaction, 'prerequisite writes require a transaction');
  if (!getWorkspace(db, workspaceId)) throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
  const target = getConcept(db, conceptId);
  if (!target || (!target.portable && target.workspaceId !== workspaceId)) {
    throw new DomainError('CONCEPT_NOT_FOUND', 'That concept is not available in this workspace.');
  }
  const legacy = db.prepare('SELECT 1 FROM concept_identity_links WHERE legacy_concept_id = ?').get(conceptId);
  if (legacy) throw new DomainError('CONCEPT_NOT_FOUND', 'That concept has been replaced.');
  for (const candidate of candidates) {
    if (typeof candidate.key !== 'string' || typeof candidate.title !== 'string' || !candidate.title.trim() || typeof candidate.summary !== 'string' || !candidate.summary.trim()) {
      throw new DomainError('INVALID_CONCEPT', 'A prerequisite needs a title and summary.');
    }
    conceptStorageKey(candidate.key, true);
  }
  const selected: Selection[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    const targetKey = target.portable ? target.key : target.key.slice(`ws/${workspaceId}/`.length);
    if (!target.summary.trim() && conceptStorageKey(candidate.key, true) === targetKey
      && normalizedConceptName(candidate.title) === normalizedConceptName(target.title)
      && compatiblePortableAliases(portableAlias(candidate.key, candidate.title), portableAlias(targetKey, target.title))) continue;
    const linked = bound.get(candidate.key);
    assert.ok(!linked || linked.portable || !target.portable && linked.workspaceId === workspaceId);
    const concept = linked ?? resolveTutorPrerequisite(db, workspaceId, candidate, target.portable);
    if (concept.id === target.id) continue;
    if (seen.has(concept.id)) continue;
    try {
      addPrerequisiteInTransaction(db, target.id, concept.id);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CYCLE') continue;
      throw error;
    }
    seen.add(concept.id);
    linkToAtlas(db, workspaceId, concept.id);
    selected.push({ concept, candidateKey: candidate.key });
  }
  if (selected.length > 0) {
    db.prepare('INSERT OR IGNORE INTO workspace_concepts (workspace_id, concept_id, on_atlas) VALUES (?, ?, 1)')
      .run(workspaceId, target.id);
  }
  return bottomUp(db, selected);
}
