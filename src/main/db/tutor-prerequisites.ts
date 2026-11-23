import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { addPrerequisiteInTransaction, conceptStorageKey, getConcept, getConceptByKey, upsertConceptInTransaction, type Concept } from './concepts';
import type { Db } from './connection';
import { normalizedConceptName } from './portable-identity';
import { getWorkspace } from './workspaces';

type Candidate = { key: string; title: string; summary: string };
type Selection = { concept: Concept; candidateKey: string };

export function findTutorPrerequisite(db: Db, workspaceId: string, candidate: Candidate, portableOnly = false): Concept | null {
  const key = conceptStorageKey(candidate.key, true);
  const localKey = conceptStorageKey(candidate.key, false, workspaceId);
  const title = normalizedConceptName(candidate.title);
  assert.ok(title.length > 0, 'matching requires a nonblank concept title');
  const rows = db.prepare(`SELECT c.id, c.key, c.title FROM concepts c
    WHERE (c.portable = 1 OR (c.workspace_id = ? AND ? = 0))
      AND c.key NOT LIKE 'Demo:%'
      AND NOT EXISTS (SELECT 1 FROM concept_identity_links l WHERE l.legacy_concept_id = c.id)
    ORDER BY CASE c.key WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, c.portable, c.id`)
    .iterate(workspaceId, Number(portableOnly), localKey, key);
  for (const row of rows) {
    assert.ok(typeof row.key === 'string' && typeof row.title === 'string');
    if (row.key !== localKey && row.key !== key && normalizedConceptName(row.title) !== title) continue;
    assert.ok(typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0);
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
  const key = conceptStorageKey(candidate.key, true);
  assert.ok(key !== target.key);
  if (getConceptByKey(db, key)) throw new DomainError('CONCEPT_CONFLICT', `Concept key "${key}" is unavailable.`);
  return upsertConceptInTransaction(db, { ...candidate, portable: true }, false);
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
  const reach = db.prepare(`WITH RECURSIVE dependencies(id) AS (
    SELECT prerequisite_id FROM concept_edges WHERE concept_id = ?
    UNION SELECT e.prerequisite_id FROM concept_edges e JOIN dependencies d ON e.concept_id = d.id
  ) SELECT id FROM dependencies`);
  const pending = new Map(concepts.map(c => [c.concept.id, new Set(reach.all(c.concept.id)
    .map(row => Number(row.id)).filter(id => selected.has(id)))]));
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
