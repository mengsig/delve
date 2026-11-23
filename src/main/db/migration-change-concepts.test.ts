import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readLesson } from '../reader/ipc';
import { cachedGeneration, digest } from '../repository/store';
import type { Depth } from '../../shared/domain';
import { upsertConcept } from './concepts';
import { recordEvidence, resetEvidence } from './evidence';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';
import { bindSnapshot } from './lessons';
import { migrate, MIGRATIONS } from './migrations';
import { addWorkspace } from './workspaces';

const head = 'a'.repeat(40);
const title = 'Keeping unconfirmed data';
const footprint = { key: 'pending-data', title, summary: 'Keep data until it is acknowledged.', portable: false };

function seedSavedChange(db: DatabaseSync, workspaceId: string, snapshotId: number, conceptId: number, touchedId: number, depth: Depth) {
  const document = { schema: 'delve.lesson/1', source: head, blocks: [{ type: 'prose', heading: 'What changed', text: depth + ' lesson' }] };
  const lessonId = db.prepare(`INSERT INTO lessons (cache_key, schema_version, concept_id, workspace_id, snapshot_id, depth, provider, model, body, created_at)
    VALUES (?, 'delve.lesson/1', ?, ?, ?, ?, 'codex', 'model', ?, '2026-01-01')`)
    .run(depth, conceptId, workspaceId, snapshotId, depth, JSON.stringify(document)).lastInsertRowid;
  const result = { kind: 'change', brief: { conceptId, lessonId: Number(lessonId), commit: head, title,
    touched: [{ id: touchedId, title }], recommendation: { conceptId: touchedId, title, reason: 'Start with this change.' } } };
  db.prepare(`INSERT INTO repository_generations (cache_key, workspace_id, snapshot_id, kind, ref, depth, provider, model, schema_version,
    result, proposal, next_concept, reason, created_at, last_used) VALUES (?, ?, ?, 'pr', '42', ?, 'codex', 'model', 'delve.change/1',
    ?, ?, ?, 'Start here.', '2026-01-01', (SELECT coalesce(max(last_used), 0) + 1 FROM repository_generations))`)
    .run(depth, workspaceId, snapshotId, depth, JSON.stringify(result), JSON.stringify({ concepts: [footprint], conceptTitle: title }), touchedId);
}

it('reconciles v10 PR duplicates without losing the strongest evidence or historical lessons', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 10));
    const workspaceId = addWorkspace(db, { kind: 'github', owner: 'acme', repo: 'web' }).id;
    const snapshotId = bindSnapshot(db, workspaceId, head);
    const make = (key: string) => upsertConcept(db, { ...footprint, workspaceId, key });
    const high = make('change/' + digest(['old', 'codex', 'model']));
    const low = make('change/' + digest(['old', 'codex', 'other-model']));
    const medium = make('change/' + digest(['old', 'claude', 'model']));
    const duplicate = make('change/' + digest(['concept', snapshotId, digest([footprint.key, footprint.summary.toLowerCase()])]));
    const other = make('unrelated');
    for (const concept of [high, low, medium, duplicate]) db.prepare('INSERT INTO snapshot_concepts VALUES (?, ?)').run(snapshotId, concept.id);
    seedSavedChange(db, workspaceId, snapshotId, high.id, duplicate.id, 'high');
    seedSavedChange(db, workspaceId, snapshotId, low.id, duplicate.id, 'low');
    seedSavedChange(db, workspaceId, snapshotId, medium.id, duplicate.id, 'medium');
    db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)').run(duplicate.id, other.id, '2026-01-01');
    const evidence = (conceptId: number, depth: Depth, verified: boolean) => recordEvidence(db, { conceptId, workspaceId, snapshotId, depth,
      status: verified ? 'demonstrated' : 'partial', source: 'check', masteryVerified: verified });
    evidence(duplicate.id, 'high', true);
    evidence(high.id, 'high', false);
    evidence(high.id, 'high', false);
    evidence(low.id, 'low', true);

    migrate(db);
    migrate(db);
    const graph = readWorkspaceGraph(db, workspaceId, true);
    expect(graph.concepts.map(c => c.id)).toEqual([high.id, other.id]);
    expect(graph.edges).toEqual([{ conceptId: high.id, prerequisiteId: other.id }]);
    expect(graph.evidence).toMatchObject([{ conceptId: high.id, depth: 'high', status: 'demonstrated' },
      { conceptId: high.id, depth: 'low', status: 'demonstrated' }]);
    expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === high.id)?.masteredDepth).toBe('low');
    expect(cachedGeneration(db, 'low')).toMatchObject({ brief: { conceptId: high.id, touched: [{ id: high.id }], recommendation: { conceptId: high.id } } });
    expect(readLesson(db, { conceptId: high.id, workspaceId, depth: 'low' })).toMatchObject({
      mastery: { stage: 'understood' }, blocks: [{ text: 'low lesson' }],
    });
    expect(readLesson(db, { conceptId: high.id, workspaceId, depth: 'medium' })).toMatchObject({
      mastery: { stage: 'teaching' }, blocks: [{ text: 'medium lesson' }],
    });
    expect(resetEvidence(db, high.id, { workspaceId, depth: 'low' })).toBe(1);
    expect(getGlobalKnowledgeGraph(db).concepts.find(c => c.id === high.id)?.masteredDepth).toBe('high');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
