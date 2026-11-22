import assert from 'node:assert/strict';
import type { Db } from './connection';

export function conceptSnapshotIdSql(workspace: string, concept: string): string {
  return `SELECT s.id FROM snapshots s
    JOIN snapshot_concepts sc ON s.id = sc.snapshot_id JOIN repository_generations g ON g.snapshot_id = s.id
    WHERE s.workspace_id = ${workspace} AND sc.concept_id = ${concept}
    ORDER BY (g.kind = 'baseline') DESC, g.last_used DESC LIMIT 1`;
}

export function workspaceSnapshotIdSql(workspace: string): string {
  return `SELECT coalesce(
    (SELECT s.id FROM repository_generations g JOIN snapshots s ON s.id = g.snapshot_id
      WHERE g.workspace_id = ${workspace} AND g.kind = 'baseline' ORDER BY g.last_used DESC LIMIT 1),
    (SELECT id FROM snapshots WHERE workspace_id = ${workspace} ORDER BY created_at DESC, id DESC LIMIT 1))`;
}

export function learningSnapshot(db: Db, workspaceId: string, conceptId?: number) {
  const binding = conceptId === undefined ? 'NULL' : `(${conceptSnapshotIdSql(':workspace', ':concept')})`;
  const row = db.prepare(`SELECT id, commit_sha FROM snapshots
    WHERE id = coalesce(${binding}, (${workspaceSnapshotIdSql(':workspace')}))`)
    .get(conceptId === undefined ? { workspace: workspaceId } : { workspace: workspaceId, concept: conceptId });
  if (!row) return null;
  assert.equal(typeof row.commit_sha, 'string');
  assert.equal(typeof row.id, 'number');
  return { id: Number(row.id), commit_sha: String(row.commit_sha) };
}
