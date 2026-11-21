import assert from 'node:assert/strict';
import type { Db } from './connection';

export function learningSnapshot(db: Db, workspaceId: string, conceptId?: number) {
  const binding = conceptId === undefined ? undefined : db.prepare(`SELECT s.id, s.commit_sha FROM snapshots s
    JOIN snapshot_concepts sc ON s.id = sc.snapshot_id JOIN repository_generations g ON g.snapshot_id = s.id
    WHERE s.workspace_id = ? AND sc.concept_id = ? ORDER BY (g.kind = 'baseline') DESC, g.last_used DESC LIMIT 1`).get(workspaceId, conceptId);
  const row = binding ?? db.prepare(`SELECT s.id, s.commit_sha FROM repository_generations g
    JOIN snapshots s ON s.id = g.snapshot_id WHERE g.workspace_id = ? AND g.kind = 'baseline'
    ORDER BY g.last_used DESC LIMIT 1`).get(workspaceId) ?? db.prepare(`SELECT id, commit_sha FROM snapshots
    WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(workspaceId);
  if (!row) return null;
  assert.equal(typeof row.commit_sha, 'string');
  assert.equal(typeof row.id, 'number');
  return { id: Number(row.id), commit_sha: String(row.commit_sha) };
}
