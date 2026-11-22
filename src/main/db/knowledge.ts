import assert from 'node:assert/strict';
import { DEPTHS, type Depth } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import type {
  GlobalKnowledgeGraph, KnowledgeConcept, MasteryState, KnowledgeMembership, TransferLink, TransferLinkInput,
} from '../../shared/knowledge';
import { getConcept } from './concepts';
import { nowIso, transaction, type Db } from './connection';
import { getWorkspace, listWorkspaces } from './workspaces';
import { matchesDemo } from './demo-fixtures';
import { projectedEdges } from './migration-edges';

interface ConceptRow {
  id: number;
  key: string;
  title: string;
  summary: string;
  portable: number;
}
interface MembershipRow extends KnowledgeMembership {
  conceptId: number;
}
interface MasteryRow {
  conceptId: number;
  depth: string;
  recordedAt: string;
  revision: number;
  workspaceId: string | null;
}
interface LinkRow {
  id: number;
  fromConceptId: number;
  toConceptId: number;
  reason: string;
  provider: string;
  model: string;
  workspaceId: string | null;
  createdAt: string;
}

const LINK_SELECT = `SELECT id, from_concept_id AS fromConceptId, to_concept_id AS toConceptId, reason, provider, model,
  workspace_id AS workspaceId, created_at AS createdAt FROM transfer_links`;

function groupMemberships(db: Db, demo: boolean): Map<number, KnowledgeMembership[]> {
  const demoIds = new Set(listWorkspaces(db).workspaces.filter(matchesDemo).map(workspace => workspace.id));
  const rows = db.prepare(
    `SELECT DISTINCT wc.concept_id AS conceptId, w.id AS workspaceId, w.name AS workspaceName
     FROM workspace_concepts wc
     JOIN workspaces w ON w.id = wc.workspace_id
     JOIN concepts c ON c.id = wc.concept_id
     WHERE (c.portable = 1 OR c.workspace_id = wc.workspace_id)
       AND NOT EXISTS (SELECT 1 FROM concept_identity_links l WHERE l.legacy_concept_id = c.id)
     ORDER BY wc.concept_id, w.name, w.id`,
  ).all() as unknown as MembershipRow[];
  const byConcept = new Map<number, KnowledgeMembership[]>();
  for (const { conceptId, workspaceId, workspaceName } of rows) {
    if (demoIds.has(workspaceId) !== demo) continue;
    const list = byConcept.get(conceptId) ?? [];
    list.push({ workspaceId, workspaceName });
    byConcept.set(conceptId, list);
  }
  return byConcept;
}

interface Mastered {
  depth: Depth;
  learnedAt: string;
  revision: number;
  workspaceId: string | null;
}

/** Per concept: deepest verified depth (with its revision) and the earliest verified recording date. */
function summarizeMastery(db: Db): Map<number, Mastered> {
  const rows = db.prepare(
    `SELECT concept_id AS conceptId, depth, recorded_at AS recordedAt, revision, workspace_id AS workspaceId FROM evidence
     WHERE status = 'demonstrated' AND mastery_verified = 1`,
  ).all() as unknown as MasteryRow[];
  const result = new Map<number, Mastered>();
  for (const row of rows) {
    assert.ok((DEPTHS as readonly string[]).includes(row.depth), `unknown depth ${row.depth}`);
    assert.ok(Number.isSafeInteger(row.revision) && row.revision >= 1, 'evidence revision must be a positive integer');
    const depth = row.depth as Depth;
    const current = result.get(row.conceptId);
    const learnedAt = current && current.learnedAt < row.recordedAt ? current.learnedAt : row.recordedAt;
    // DEPTHS runs shallow to deep, so a higher index is deeper.
    const keepCurrent = current !== undefined && DEPTHS.indexOf(current.depth) > DEPTHS.indexOf(depth);
    result.set(row.conceptId, keepCurrent ? { ...current, learnedAt } : { depth, learnedAt, revision: row.revision, workspaceId: row.workspaceId });
  }
  return result;
}

/** Concepts with an unfinished or skipped guided lesson, from the persisted lesson cycle stage. */
function summarizeLessonStages(db: Db): { inProgress: Set<number>; skipped: Set<number> } {
  const rows = db.prepare(
    `SELECT coalesce(l.portable_concept_id, m.concept_id) AS conceptId, json_extract(m.state, '$.stage') AS stage
     FROM lesson_mastery m LEFT JOIN concept_identity_links l ON l.legacy_concept_id = m.concept_id WHERE m.state IS NOT NULL`,
  ).all() as unknown as { conceptId: number; stage: string }[];
  const inProgress = new Set<number>();
  const skipped = new Set<number>();
  for (const { conceptId, stage } of rows) {
    if (stage === 'skipped') skipped.add(conceptId);
    else if (stage === 'teaching' || stage === 'checking' || stage === 'review') inProgress.add(conceptId);
    else assert.equal(stage, 'understood', `unknown lesson stage ${stage}`);
  }
  return { inProgress, skipped };
}

function masteryStateOf(conceptId: number, verified: boolean, stages: ReturnType<typeof summarizeLessonStages>): MasteryState {
  if (verified) return 'verified';
  if (stages.inProgress.has(conceptId)) return 'in-progress';
  return stages.skipped.has(conceptId) ? 'skipped' : 'not-started';
}

/**
 * Every concept in every workspace, once, with workspace memberships, verified mastery and bridge status.
 * Concepts with no membership (orphans) are omitted; edges are kept only between listed concepts.
 */
export function getGlobalKnowledgeGraph(db: Db, demo = false): GlobalKnowledgeGraph {
  const memberships = groupMemberships(db, demo);
  const mastery = summarizeMastery(db);
  const stages = summarizeLessonStages(db);
  const conceptRows = db.prepare('SELECT id, key, title, summary, portable FROM concepts ORDER BY id').all() as unknown as ConceptRow[];
  const concepts: KnowledgeConcept[] = [];
  for (const row of conceptRows) {
    const used = memberships.get(row.id);
    if (!used) continue;
    const learned = mastery.get(row.id);
    concepts.push({
      id: row.id, key: row.key, title: row.title, summary: row.summary, portable: row.portable === 1,
      memberships: used, masteredDepth: learned?.depth ?? null,
      masteryState: masteryStateOf(row.id, learned !== undefined, stages), evidenceRevision: learned?.revision ?? null,
      learnedAt: learned?.learnedAt ?? null, learnedWorkspaceId: learned?.workspaceId ?? null, bridge: used.length >= 2,
    });
  }
  assert.equal(new Set(concepts.map(({ id }) => id)).size, concepts.length, 'global concepts must be unique');
  const ids = new Set(concepts.map(({ id }) => id));
  const edges = projectedEdges(db, ids);
  const links = projectedTransferLinks(db, ids);
  return { concepts, edges, links };
}

function projectedTransferLinks(db: Db, ids: Set<number>): TransferLink[] {
  assert.ok(ids instanceof Set);
  const rows = db.prepare(`SELECT t.id, coalesce(a.portable_concept_id, t.from_concept_id) AS fromConceptId,
    coalesce(b.portable_concept_id, t.to_concept_id) AS toConceptId, t.reason, t.provider, t.model,
    t.workspace_id AS workspaceId, t.created_at AS createdAt FROM transfer_links t
    LEFT JOIN concept_identity_links a ON a.legacy_concept_id = t.from_concept_id
    LEFT JOIN concept_identity_links b ON b.legacy_concept_id = t.to_concept_id ORDER BY t.id`).all() as unknown as LinkRow[];
  const seen = new Set<string>();
  return rows.filter((row) => {
    assert.ok(row.id > 0 && row.fromConceptId > 0 && row.toConceptId > 0);
    const key = [row.fromConceptId, row.toConceptId].sort((a, b) => a - b).join(':');
    if (row.fromConceptId === row.toConceptId || !ids.has(row.fromConceptId) || !ids.has(row.toConceptId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function listTransferLinks(db: Db): TransferLink[] {
  return db.prepare(`${LINK_SELECT} ORDER BY id`).all() as unknown as LinkRow[];
}

function requireText(value: string, field: string): string {
  const text = value.trim();
  if (text.length === 0) throw new DomainError('INVALID_LINK', `A transfer link needs a ${field}.`);
  return text;
}

function assertLinkable(db: Db, input: TransferLinkInput): void {
  if (input.fromConceptId === input.toConceptId) throw new DomainError('INVALID_LINK', 'A concept cannot link to itself.');
  for (const id of [input.fromConceptId, input.toConceptId]) {
    if (!getConcept(db, id)) throw new DomainError('CONCEPT_NOT_FOUND', `Concept ${id} does not exist.`);
  }
  if (input.workspaceId !== undefined && !getWorkspace(db, input.workspaceId)) {
    throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
  }
  const duplicate = db.prepare(
    `SELECT 1 FROM transfer_links WHERE min(from_concept_id, to_concept_id) = min(?, ?) AND max(from_concept_id, to_concept_id) = max(?, ?)`,
  ).get(input.fromConceptId, input.toConceptId, input.fromConceptId, input.toConceptId);
  if (duplicate) throw new DomainError('DUPLICATE_LINK', 'These concepts are already linked.');
}

/** Creates a transfer link; rejects self-links, unknown endpoints and duplicates (in either direction). */
export function createTransferLink(db: Db, input: TransferLinkInput): TransferLink {
  const reason = requireText(input.reason, 'reason');
  const provider = requireText(input.provider, 'provider');
  const model = requireText(input.model, 'model');
  const save = () => {
    assertLinkable(db, input);
    const result = db.prepare(
      `INSERT INTO transfer_links (from_concept_id, to_concept_id, reason, provider, model, workspace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.fromConceptId, input.toConceptId, reason, provider, model, input.workspaceId ?? null, nowIso());
    const saved = db.prepare(`${LINK_SELECT} WHERE id = ?`).get(result.lastInsertRowid) as unknown as LinkRow | undefined;
    assert.ok(saved && saved.reason === reason, 'created link must be readable');
    return saved;
  };
  return db.isTransaction ? save() : transaction(db, save);
}

/** Deletes a link by id; returns false when it did not exist. */
export function deleteTransferLink(db: Db, id: number): boolean {
  assert.ok(Number.isSafeInteger(id) && id > 0, 'link id must be a positive integer');
  const result = db.prepare('DELETE FROM transfer_links WHERE id = ?').run(id);
  assert.ok(result.changes <= 1, 'link id is unique');
  return result.changes === 1;
}
