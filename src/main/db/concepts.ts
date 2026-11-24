import assert from 'node:assert/strict';
import { DomainError } from '../../shared/errors';
import { nowIso, transaction, type Db } from './connection';
import { canonicalEdges, edgeReachable } from './migration-edges';

const CONCEPT_KEY = /^[a-z0-9][a-z0-9._/-]{0,199}$/;

export interface ConceptInput {
  /** Stable key, e.g. `nginx/reverse-proxy`. Local keys are namespaced by workspace on save. */
  key: string;
  title: string;
  summary?: string;
  portable: boolean;
  /** Required for local concepts; for portable ones it records that the workspace uses it. */
  workspaceId?: string;
}

export interface Concept {
  id: number;
  key: string;
  title: string;
  summary: string;
  portable: boolean;
  workspaceId: string | null;
}

interface ConceptRow {
  id: number;
  key: string;
  title: string;
  summary: string;
  portable: number;
  workspace_id: string | null;
}

function toConcept(row: ConceptRow): Concept {
  assert.ok(row.portable === 0 || row.portable === 1, 'portable must be 0 or 1');
  assert.equal(row.portable === 1, row.workspace_id === null, 'portable concepts have no owning workspace');
  return { id: row.id, key: row.key, title: row.title, summary: row.summary, portable: row.portable === 1, workspaceId: row.workspace_id };
}

/** The stored key: portable keys are global; local keys live under their workspace. */
export function conceptStorageKey(key: string, portable: boolean, workspaceId?: string): string {
  const normalized = key.trim().toLowerCase();
  if (!CONCEPT_KEY.test(normalized)) throw new DomainError('INVALID_CONCEPT', `"${key}" is not a valid concept key.`);
  if (portable) return normalized;
  if (!workspaceId) throw new DomainError('INVALID_CONCEPT', 'A workspace-specific concept needs a workspace.');
  return `ws/${workspaceId}/${normalized}`;
}

export function getConceptByKey(db: Db, storedKey: string): Concept | null {
  const row = db.prepare('SELECT * FROM concepts WHERE key = ?').get(storedKey) as ConceptRow | undefined;
  return row ? toConcept(row) : null;
}

export function getConcept(db: Db, id: number): Concept | null {
  const row = db.prepare('SELECT * FROM concepts WHERE id = ?').get(id) as ConceptRow | undefined;
  return row ? toConcept(row) : null;
}

export function canonicalConceptId(db: Db, id: number): number {
  assert.ok(Number.isSafeInteger(id) && id > 0);
  const row = db.prepare('SELECT canonical_concept_id AS id FROM concept_identity_links WHERE legacy_concept_id = ?').get(id);
  if (!row) return id;
  assert.ok(typeof row.id === 'number' && row.id !== id);
  return row.id;
}

function requireConcept(db: Db, id: number): Concept {
  const concept = getConcept(db, id);
  if (!concept) throw new DomainError('CONCEPT_NOT_FOUND', `Concept ${id} does not exist.`);
  return concept;
}

/** Creates or updates a concept by stable key; a portable concept is shared, never duplicated. */
export function upsertConcept(db: Db, input: ConceptInput): Concept {
  return transaction(db, () => upsertConceptInTransaction(db, input));
}

export function upsertConceptInTransaction(db: Db, input: ConceptInput, onAtlas = true): Concept {
  assert.ok(db.isTransaction, 'concept writes require a transaction');
  const title = input.title.trim();
  if (title.length === 0) throw new DomainError('INVALID_CONCEPT', 'A concept needs a title.');
  const key = conceptStorageKey(input.key, input.portable, input.workspaceId);
  const existing = getConceptByKey(db, key);
  if (existing && existing.portable !== input.portable) {
    throw new DomainError('CONCEPT_CONFLICT', `Concept "${key}" already exists with a different portability.`);
  }
  const ownerId = input.portable ? null : (input.workspaceId ?? null);
  assert.ok(input.portable || ownerId, 'a local concept has an owning workspace');
  const now = nowIso();
  db.prepare(
    `INSERT INTO concepts (key, title, summary, portable, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at`,
  ).run(key, title, input.summary?.trim() ?? existing?.summary ?? '', input.portable ? 1 : 0, ownerId, now, now);
  const saved = getConceptByKey(db, key);
  assert.ok(saved, 'upserted concept must be readable');
  if (input.workspaceId) {
    db.prepare(`INSERT INTO workspace_concepts (workspace_id, concept_id, on_atlas) VALUES (?, ?, ?)
      ON CONFLICT (workspace_id, concept_id) DO UPDATE SET on_atlas = max(on_atlas, excluded.on_atlas)`)
      .run(input.workspaceId, saved.id, Number(onAtlas));
  }
  return saved;
}

/** True when `from` already (transitively) requires `to`. */
function requires(db: Db, from: number, to: number): boolean {
  assert.ok(Number.isSafeInteger(from) && from > 0);
  assert.ok(Number.isSafeInteger(to) && to > 0);
  if (db.prepare('SELECT 1 FROM concept_identity_links LIMIT 1').get()) {
    return edgeReachable(canonicalEdges(db), from, to);
  }
  return db.prepare(`WITH RECURSIVE reach (id) AS (
    SELECT prerequisite_id FROM concept_edges WHERE concept_id = ?
    UNION SELECT e.prerequisite_id FROM concept_edges e JOIN reach r ON e.concept_id = r.id
  ) SELECT 1 FROM reach WHERE id = ? LIMIT 1`).get(from, to) !== undefined;
}

function assertEdgeScope(concept: Concept, prerequisite: Concept): void {
  if (concept.portable && !prerequisite.portable) {
    throw new DomainError('INVALID_EDGE', `Portable "${concept.key}" cannot require workspace-specific "${prerequisite.key}".`);
  }
  if (!prerequisite.portable && prerequisite.workspaceId !== concept.workspaceId) {
    throw new DomainError('INVALID_EDGE', `"${prerequisite.key}" belongs to another workspace.`);
  }
}

/** Records that `conceptId` requires `prerequisiteId`. Rejects self-loops and cycles; idempotent. */
export function addPrerequisite(db: Db, conceptId: number, prerequisiteId: number): void {
  transaction(db, () => addPrerequisiteInTransaction(db, conceptId, prerequisiteId));
}

export function addPrerequisiteInTransaction(db: Db, conceptId: number, prerequisiteId: number): void {
  assert.ok(db.isTransaction, 'edge writes require a transaction');
  conceptId = canonicalConceptId(db, conceptId);
  prerequisiteId = canonicalConceptId(db, prerequisiteId);
  if (conceptId === prerequisiteId) throw new DomainError('CYCLE', 'A concept cannot require itself.');
  const concept = requireConcept(db, conceptId);
  const prerequisite = requireConcept(db, prerequisiteId);
  assertEdgeScope(concept, prerequisite);
  if (requires(db, prerequisiteId, conceptId)) {
    throw new DomainError('CYCLE', `"${prerequisite.title}" already depends on "${concept.title}"; that edge would create a cycle.`);
  }
  db.prepare('INSERT OR IGNORE INTO concept_edges (concept_id, prerequisite_id, created_at) VALUES (?, ?, ?)').run(
    conceptId,
    prerequisiteId,
    nowIso(),
  );
}

/** Direct prerequisites, ordered by title. */
export function listPrerequisites(db: Db, conceptId: number): Concept[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM concept_edges e JOIN concepts c ON c.id = e.prerequisite_id
       WHERE e.concept_id = ? ORDER BY c.title`,
    )
    .all(conceptId) as unknown as ConceptRow[];
  return rows.map(toConcept);
}

/** Concepts a workspace uses: its own plus the portable ones linked to it. */
export function listWorkspaceConcepts(db: Db, workspaceId: string, includeChangeLessons = false): Concept[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM workspace_concepts wc JOIN concepts c ON c.id = wc.concept_id
       WHERE wc.workspace_id = ? AND (wc.on_atlas = 1 OR ? = 1) AND (c.portable = 1 OR c.workspace_id = wc.workspace_id)
         AND NOT EXISTS (SELECT 1 FROM concept_identity_links l WHERE l.legacy_concept_id = c.id)
       ORDER BY c.title`,
    )
    .all(workspaceId, Number(includeChangeLessons)) as unknown as ConceptRow[];
  return rows.map(toConcept);
}
