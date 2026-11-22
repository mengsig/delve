import assert from 'node:assert/strict';
import { DEPTHS, type Depth } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { coversDepth } from '../../shared/evidence-depth';
import type { GraphEvidence } from '../../shared/graph';
import { getConceptByKey } from './concepts';
import { nowIso, transaction, type Db } from './connection';
import { resetMastery } from './mastery';
import { resolveScope } from './scope';
import { getWorkspace } from './workspaces';

export const EVIDENCE_STATUSES = ['demonstrated', 'partial', 'revisit'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export const EVIDENCE_SOURCES = ['check', 'environment', 'self-report'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface EvidenceInput {
  conceptId: number;
  depth: Depth;
  status: EvidenceStatus;
  source: EvidenceSource;
  note?: string;
  workspaceId?: string;
  snapshotId?: number;
  masteryVerified?: boolean;
}

export interface Evidence {
  id: number;
  conceptId: number;
  depth: Depth;
  status: EvidenceStatus;
  source: EvidenceSource;
  note: string;
  workspaceId: string | null;
  snapshotId: number | null;
  revision: number;
  recordedAt: string;
  masteryVerified: boolean;
}

interface EvidenceRow {
  id: number;
  concept_id: number;
  depth: string;
  status: string;
  source: string;
  note: string;
  workspace_id: string | null;
  snapshot_id: number | null;
  revision: number;
  recorded_at: string;
  mastery_verified: number;
}

function evidenceDetails(row: EvidenceRow): Omit<Evidence, 'id' | 'snapshotId'> {
  assert.ok((DEPTHS as readonly string[]).includes(row.depth), `unknown depth ${row.depth}`);
  assert.ok((EVIDENCE_STATUSES as readonly string[]).includes(row.status), `unknown status ${row.status}`);
  assert.ok((EVIDENCE_SOURCES as readonly string[]).includes(row.source), `unknown source ${row.source}`);
  assert.ok(row.mastery_verified === 0 || row.mastery_verified === 1);
  return {
    conceptId: row.concept_id,
    depth: row.depth as Depth,
    status: row.status as EvidenceStatus,
    source: row.source as EvidenceSource,
    note: row.note,
    workspaceId: row.workspace_id,
    revision: row.revision,
    recordedAt: row.recorded_at,
    masteryVerified: row.mastery_verified === 1,
  };
}

function assertInput(input: EvidenceInput): void {
  if (!(DEPTHS as readonly string[]).includes(input.depth)) throw new DomainError('INVALID_EVIDENCE', `Unknown depth "${input.depth}".`);
  if (!(EVIDENCE_STATUSES as readonly string[]).includes(input.status)) {
    throw new DomainError('INVALID_EVIDENCE', `Unknown evidence status "${input.status}".`);
  }
  if (!(EVIDENCE_SOURCES as readonly string[]).includes(input.source)) {
    throw new DomainError('INVALID_EVIDENCE', `Unknown evidence source "${input.source}".`);
  }
}

/** Records evidence for a concept at a depth; recording again revises it and bumps the revision. */
export function recordEvidence(db: Db, input: EvidenceInput): Evidence {
  return transaction(db, () => recordEvidenceInTransaction(db, input));
}

export function recordEvidenceInTransaction(db: Db, input: EvidenceInput): Evidence {
  assertInput(input);
  assert.ok(db.isTransaction, 'evidence must be recorded atomically');
  const scope = resolveScope(db, input.conceptId, input.workspaceId, input.snapshotId);
  if (scope.workspaceId !== null) {
    db.prepare('INSERT OR IGNORE INTO workspace_concepts (workspace_id, concept_id) VALUES (?, ?)').run(scope.workspaceId, input.conceptId);
  }
  db.prepare(
    `INSERT INTO evidence (concept_id, depth, status, source, note, workspace_id, snapshot_id, revision, recorded_at, mastery_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (concept_id, depth) DO UPDATE SET
       status = excluded.status, source = excluded.source, note = excluded.note,
       workspace_id = excluded.workspace_id, snapshot_id = excluded.snapshot_id,
       revision = evidence.revision + 1, recorded_at = excluded.recorded_at, mastery_verified = excluded.mastery_verified`,
  ).run(input.conceptId, input.depth, input.status, input.source, input.note ?? '', scope.workspaceId, scope.snapshotId,
    nowIso(), Number(input.masteryVerified ?? false));
  const saved = listEvidence(db, input.conceptId).find((e) => e.depth === input.depth);
  assert.ok(saved && saved.status === input.status, 'recorded evidence must be readable');
  return saved;
}

export function listEvidence(db: Db, conceptId: number): Evidence[] {
  const rows = db
    .prepare(
      `SELECT * FROM evidence WHERE concept_id = ?
       ORDER BY CASE depth WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
    )
    .all(conceptId) as unknown as EvidenceRow[];
  return rows.map((row) => ({ ...evidenceDetails(row), id: row.id, snapshotId: row.snapshot_id }));
}

export const portableProofAtDepth = (db: Db, conceptId: number, depth: Depth) =>
  listEvidence(db, conceptId).some(e => e.masteryVerified && coversDepth(e.depth, depth));

export function listWorkspaceEvidence(db: Db, workspaceId: string, includeChangeLessons = false): GraphEvidence[] {
  const rows = db.prepare(
    `SELECT e.*, origin.name AS workspace_name
     FROM workspace_concepts wc
     JOIN concepts c ON c.id = wc.concept_id
     JOIN evidence e ON e.concept_id = c.id
     LEFT JOIN workspaces origin ON origin.id = e.workspace_id
     WHERE wc.workspace_id = ? AND (wc.on_atlas = 1 OR ? = 1)
       AND NOT EXISTS (SELECT 1 FROM concept_identity_links l WHERE l.legacy_concept_id = c.id)
       AND (c.portable = 1 OR (c.workspace_id = wc.workspace_id AND e.workspace_id = wc.workspace_id))
     ORDER BY e.concept_id, CASE e.depth WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
  ).all(workspaceId, Number(includeChangeLessons)) as unknown as (EvidenceRow & { workspace_name: string | null })[];
  return rows.map((row) => {
    assert.equal(row.workspace_id === null, row.workspace_name === null, 'provenance must refer to an existing workspace');
    assert.ok(Number.isSafeInteger(row.revision) && row.revision >= 1, 'evidence revision must be a positive integer');
    const { masteryVerified: _masteryVerified, ...details } = evidenceDetails(row);
    const status = details.status === 'demonstrated' && !_masteryVerified ? 'revisit' : details.status;
    return { ...details, status, workspaceName: row.workspace_name };
  });
}

function assertResetOrigin(db: Db, workspaceId: string, conceptId: number, depth?: Depth): void {
  if (!getWorkspace(db, workspaceId)) throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
  const membership = db.prepare('SELECT 1 FROM workspace_concepts WHERE workspace_id = ? AND concept_id = ?');
  if (!membership.get(workspaceId, conceptId)) throw new DomainError('SCOPE_MISMATCH', 'That concept is not linked to this workspace.');
  const target = listEvidence(db, conceptId).filter((e) => depth === undefined || e.depth === depth);
  if (target.some((e) => e.workspaceId !== null && e.workspaceId !== workspaceId)) {
    throw new DomainError('SCOPE_MISMATCH', 'Reset this evidence from the workspace where it was recorded.');
  }
}

/** Removes canonical evidence. Scoped resets require membership and the recorded origin, when one exists. */
export function resetEvidence(db: Db, conceptId: number, options: { depth?: Depth; workspaceId?: string } = {}): number {
  const { depth, workspaceId } = options;
  if (depth !== undefined && !(DEPTHS as readonly string[]).includes(depth)) {
    throw new DomainError('INVALID_EVIDENCE', `Unknown depth "${depth}".`);
  }
  return transaction(db, () => {
    resolveScope(db, conceptId, workspaceId);
    if (workspaceId !== undefined) assertResetOrigin(db, workspaceId, conceptId, depth);
    const result =
      depth === undefined
        ? db.prepare('DELETE FROM evidence WHERE concept_id = ?').run(conceptId)
        : db.prepare('DELETE FROM evidence WHERE concept_id = ? AND depth = ?').run(conceptId, depth);
    const removed = Number(result.changes);
    resetMastery(db, conceptId, depth, removed > 0 ? undefined : workspaceId);
    assert.ok(Number.isSafeInteger(removed) && removed >= 0, 'deletion must report a non-negative integer');
    assert.ok(removed <= (depth === undefined ? DEPTHS.length : 1), 'at most one record per depth');
    return removed;
  });
}

export interface KnownResult {
  known: boolean;
  /** The depth whose evidence satisfies the request, when known. */
  viaDepth: Depth | null;
  reason: string;
}

/**
 * Whether a concept is known at `depth` in `workspaceId`, i.e. may be reused instead of retaught.
 * Depths are cumulative, so evidence at a deeper depth satisfies a shallower one.
 */
export function isConceptKnown(db: Db, query: { conceptKey: string; depth: Depth; workspaceId: string }): KnownResult {
  const wanted = DEPTHS.indexOf(query.depth);
  assert.ok(wanted >= 0, `unknown depth ${query.depth}`);
  const concept = getConceptByKey(db, query.conceptKey);
  if (!concept) return { known: false, viaDepth: null, reason: 'No such concept in the knowledge graph.' };
  if (!concept.portable && concept.workspaceId !== query.workspaceId) {
    return { known: false, viaDepth: null, reason: 'This concept is specific to another workspace and is not reused.' };
  }
  const satisfying = listEvidence(db, concept.id).find((e) => e.masteryVerified && DEPTHS.indexOf(e.depth) >= wanted);
  if (!satisfying) return { known: false, viaDepth: null, reason: `Not yet demonstrated at ${query.depth} depth.` };
  return { known: true, viaDepth: satisfying.depth, reason: `Demonstrated at ${satisfying.depth} depth.` };
}
