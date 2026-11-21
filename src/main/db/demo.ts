import assert from 'node:assert/strict';
import { getConceptByKey } from './concepts';
import { nowIso, transaction, type Db } from './connection';
import { DEMO_CONCEPTS, DEMO_PORTABLE, DEMO_WORKSPACES, matchesDemo, type DemoConceptId, type DemoWorkspace } from './demo-fixtures';
import { bindSnapshot } from './lessons';
import { ACTIVE_WORKSPACE_KEY, getWorkspace } from './workspaces';

const SEED_MARKER = 'demo_seed_v1';
const demoSource = (demo: DemoWorkspace): string => `Demo: ${demo.title}`;

export function isDemoWorkspace(db: Db, workspaceId: string): boolean {
  const workspace = getWorkspace(db, workspaceId);
  return workspace !== null && matchesDemo(workspace);
}

function linkDemoConcept(db: Db, workspaceId: string, id: DemoConceptId, timestamp: string): number {
  const [title, summary] = DEMO_CONCEPTS[id];
  const portable = DEMO_PORTABLE.has(id);
  // Uppercase keys reserve the fixture namespace outside canonical user keys.
  const key = portable ? `Demo:${id}` : `ws/${workspaceId}/Demo:${id}`;
  db.prepare(
    `INSERT INTO concepts (key, title, summary, portable, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`,
  ).run(key, title, summary, portable ? 1 : 0, portable ? null : workspaceId, timestamp, timestamp);
  const saved = getConceptByKey(db, key);
  assert.ok(saved && saved.portable === portable, 'demo concept must exist with the configured portability');
  assert.equal(saved.workspaceId, portable ? null : workspaceId, 'demo concept must have the configured owner');
  db.prepare('INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES (?, ?)').run(workspaceId, saved.id);
  return saved.id;
}

function seedDemoGraph(db: Db, workspace: DemoWorkspace, timestamp: string): void {
  assert.ok(db.isTransaction, 'demo graph is written with the seed transaction');
  const ids = new Map(workspace.concepts.map((id) => [id, linkDemoConcept(db, workspace.id, id, timestamp)]));
  const insertEdge = db.prepare('INSERT INTO concept_edges (concept_id, prerequisite_id, created_at) VALUES (?, ?, ?)');
  for (const [from, to] of workspace.edges) {
    const prerequisite = ids.get(from);
    const concept = ids.get(to);
    assert.ok(prerequisite && concept, 'demo edge endpoints must both be on the map');
    assert.notEqual(concept, prerequisite, 'demo edges cannot be self-loops');
    insertEdge.run(concept, prerequisite, timestamp);
  }

  const snapshotId = workspace.snapshot ? bindSnapshot(db, workspace.id, workspace.snapshot) : null;
  const insertEvidence = db.prepare(
    `INSERT INTO evidence (concept_id, depth, status, source, note, workspace_id, snapshot_id, recorded_at, mastery_verified)
     VALUES (?, ?, 'demonstrated', 'check', 'Curated demo evidence.', ?, ?, ?, 1)`,
  );
  for (const [key, depths] of workspace.evidence ?? []) {
    const concept = ids.get(key);
    assert.ok(concept, 'demo evidence must refer to a concept in the demo workspace');
    assert.ok(depths.length > 0, 'demo evidence must identify at least one depth');
    for (const depth of depths) insertEvidence.run(concept, depth, workspace.id, snapshotId, timestamp);
  }
}

/** Adds fixtures once, so a later startup preserves workspace selection and evidence resets. */
export function seedDemoWorkspaces(db: Db): void {
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM app_state WHERE key = ?').get(SEED_MARKER)) return;
    const timestamp = nowIso();
    const [firstDemo] = DEMO_WORKSPACES;
    assert.ok(firstDemo && DEMO_WORKSPACES.length > 1, 'demo must include multiple workspaces');
    const insertWorkspace = db.prepare(
      'INSERT INTO workspaces (id, kind, name, source, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const demo of [...DEMO_WORKSPACES].reverse()) {
      insertWorkspace.run(demo.id, demo.kind, `${demo.title} (demo)`, demoSource(demo), timestamp);
    }
    for (const demo of DEMO_WORKSPACES) seedDemoGraph(db, demo, timestamp);
    const select = db.prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE id = app_state.value)`,
    ).run(ACTIVE_WORKSPACE_KEY, firstDemo.id);
    if (select.changes === 1) {
      const opened = db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(timestamp, firstDemo.id);
      assert.equal(opened.changes, 1, 'selected demo workspace must exist');
    }
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run(SEED_MARKER, '1');
  });
}
