import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { addPrerequisiteInTransaction, canonicalConceptId, conceptStorageKey, getConcept, getConceptByKey, upsertConceptInTransaction, type Concept } from './concepts';
import type { Db } from './connection';
import { compatibleDescriptions, compatiblePortableAliases, normalizedConceptName, portableAlias, scopedFingerprint } from './portable-identity';
import { canonicalEdges, edgeReachable } from './migration-edges';
import { getWorkspace } from './workspaces';

type Candidate = { key: string; title: string; summary: string };
type Selection = { concept: Concept; candidateKey: string };

const variantKey = (candidate: Candidate) => 'foundation/' + scopedFingerprint({ ...candidate, portable: false });

export function findTutorPrerequisite(db: Db, workspaceId: string, candidate: Candidate, portableOnly = false): Concept | null {
  const key = conceptStorageKey(candidate.key, true);
  const localKey = conceptStorageKey(candidate.key, false, workspaceId);
  const title = normalizedConceptName(candidate.title);
  const alias = portableAlias(key, title);
  const local = getConceptByKey(db, localKey);
  const scopedId = local ? canonicalConceptId(db, local.id) : null;
  const variant = variantKey(candidate);
  assert.ok(title.length > 0, 'matching requires a nonblank concept title');
  const rows = db.prepare(`SELECT c.id, c.key, c.title, c.summary, c.portable FROM concepts c
    WHERE (c.portable = 1 OR (c.workspace_id = ? AND ? = 0))
      AND c.key NOT LIKE 'Demo:%'
      AND NOT EXISTS (SELECT 1 FROM concept_identity_links l WHERE l.legacy_concept_id = c.id)
    ORDER BY CASE WHEN c.id = ? THEN 0 WHEN c.key = ? OR c.key = ? THEN 1 ELSE 2 END, c.portable, c.id`)
    .iterate(workspaceId, Number(portableOnly), scopedId, key, variant);
  for (const row of rows) {
    assert.ok(typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0);
    assert.ok(typeof row.key === 'string' && typeof row.title === 'string' && typeof row.summary === 'string');
    assert.ok(row.portable === 0 || row.portable === 1);
    const unscopedKey = row.portable === 1 ? row.key : row.key.slice(`ws/${workspaceId}/`.length);
    const savedAlias = portableAlias(unscopedKey, row.title);
    const sameKey = row.id === scopedId || row.key === key || row.key === variant;
    const sameAlias = Boolean(alias && alias === savedAlias);
    const sameLocalTitle = row.portable === 0 && normalizedConceptName(row.title) === title;
    if (!sameKey && !sameAlias && !sameLocalTitle) continue;
    if (!compatibleDescriptions(candidate.summary, row.summary) || !compatiblePortableAliases(alias, savedAlias)) continue;
    const match = getConcept(db, row.id);
    assert.ok(match && (!portableOnly || match.portable));
    return match;
  }
  return null;
}

function resolveCandidate(db: Db, workspaceId: string, target: Concept, candidate: Candidate): Concept {
  assert.ok(db.isTransaction);
  const match = findTutorPrerequisite(db, workspaceId, candidate, target.portable);
  if (match) return match;
  let key = conceptStorageKey(candidate.key, true);
  if (getConceptByKey(db, key)) {
    key = variantKey(candidate);
    const existing = getConceptByKey(db, key);
    if (existing) throw new DomainError('CONCEPT_CONFLICT', `Concept key "${key}" is unavailable.`);
  }
  assert.notEqual(key, target.key);
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

export function persistTutorPrerequisites(db: Db, workspaceId: string, conceptId: number, candidates: readonly Candidate[]): Selection[] {
  assert.ok(db.isTransaction, 'prerequisite writes require a transaction');
  if (!getWorkspace(db, workspaceId)) throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
  const target = getConcept(db, conceptId);
  if (!target || (!target.portable && target.workspaceId !== workspaceId)) {
    throw new DomainError('CONCEPT_NOT_FOUND', 'That concept is not available in this workspace.');
  }
  const legacy = db.prepare('SELECT 1 FROM concept_identity_links WHERE legacy_concept_id = ?').get(conceptId);
  if (legacy) throw new DomainError('CONCEPT_NOT_FOUND', 'That concept has been replaced.');
  for (const candidate of candidates) {
    if (typeof candidate.key !== 'string' || typeof candidate.title !== 'string' || !candidate.title.trim() || typeof candidate.summary !== 'string') {
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
    const concept = resolveCandidate(db, workspaceId, target, candidate);
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
