import { afterEach, beforeEach, expect, it } from 'vitest';
import { addPrerequisite, upsertConcept } from './concepts';
import { openDatabase, type Db } from './connection';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';
import { addWorkspace } from './workspaces';

let db: Db;
let workspace: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  workspace = addWorkspace(db, { kind: 'topic', title: 'First' }).id;
});
afterEach(() => db.close());

it('preserves workspace edges hidden by another workspace in the canonical projection', () => {
  const other = addWorkspace(db, { kind: 'topic', title: 'Second' }).id;
  const b = upsertConcept(db, { key: 'b', title: 'B', portable: true, workspaceId: workspace });
  const a = upsertConcept(db, { key: 'a', title: 'A', portable: true, workspaceId: workspace });
  upsertConcept(db, { key: 'a', title: 'A', portable: true, workspaceId: other });
  upsertConcept(db, { key: 'b', title: 'B', portable: true, workspaceId: other });
  const oldA = upsertConcept(db, { key: 'old-a', title: 'Old A', portable: false, workspaceId: workspace });
  const oldB = upsertConcept(db, { key: 'old-b', title: 'Old B', portable: false, workspaceId: other });
  const link = db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)');
  link.run(oldA.id, a.id);
  link.run(oldB.id, b.id);
  const edge = db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)');
  edge.run(oldA.id, b.id, '2026-01-01');
  edge.run(oldB.id, a.id, '2026-01-01');
  const visible = [{ conceptId: a.id, prerequisiteId: b.id }];
  expect(readWorkspaceGraph(db, workspace).edges).toEqual(visible);
  expect(readWorkspaceGraph(db, other).edges).toEqual([{ conceptId: b.id, prerequisiteId: a.id }]);
  expect(() => addPrerequisite(db, b.id, a.id)).toThrow(/cycle/);
  expect(readWorkspaceGraph(db, workspace).edges).toEqual(visible);
  expect(readWorkspaceGraph(db, workspace, true).edges).toEqual(visible);
});

it('preserves global edges hidden by orphan concepts in the canonical projection', () => {
  const b = upsertConcept(db, { key: 'b', title: 'B', portable: true, workspaceId: workspace });
  const orphan = upsertConcept(db, { key: 'orphan', title: 'Orphan', portable: true });
  const a = upsertConcept(db, { key: 'a', title: 'A', portable: true, workspaceId: workspace });
  const oldA = upsertConcept(db, { key: 'old-a', title: 'Old A', portable: false, workspaceId: workspace });
  db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(oldA.id, a.id);
  const edge = db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)');
  edge.run(b.id, orphan.id, '2026-01-01');
  edge.run(orphan.id, a.id, '2026-01-01');
  edge.run(oldA.id, b.id, '2026-01-01');
  const visible = [{ conceptId: a.id, prerequisiteId: b.id }];
  expect(getGlobalKnowledgeGraph(db).edges).toEqual(visible);
  expect(() => addPrerequisite(db, b.id, a.id)).toThrow(/cycle/);
  expect(getGlobalKnowledgeGraph(db).edges).toEqual(visible);
});

it('preserves atlas edges when change lessons alter the full workspace projection', () => {
  const b = upsertConcept(db, { key: 'b', title: 'B', portable: true, workspaceId: workspace });
  const hidden = upsertConcept(db, { key: 'hidden', title: 'Hidden', portable: true, workspaceId: workspace });
  const a = upsertConcept(db, { key: 'a', title: 'A', portable: true, workspaceId: workspace });
  const oldA = upsertConcept(db, { key: 'old-a', title: 'Old A', portable: false, workspaceId: workspace });
  db.prepare('UPDATE workspace_concepts SET on_atlas = 0 WHERE concept_id = ?').run(hidden.id);
  db.prepare('INSERT INTO concept_identity_links (legacy_concept_id, canonical_concept_id) VALUES (?, ?)').run(oldA.id, a.id);
  const edge = db.prepare('INSERT INTO concept_edges VALUES (?, ?, ?)');
  edge.run(b.id, hidden.id, '2026-01-01');
  edge.run(hidden.id, a.id, '2026-01-01');
  edge.run(oldA.id, b.id, '2026-01-01');
  const visible = [{ conceptId: a.id, prerequisiteId: b.id }];
  expect(readWorkspaceGraph(db, workspace).edges).toEqual(visible);
  expect(readWorkspaceGraph(db, workspace, true).edges).not.toContainEqual(visible[0]);
  expect(() => addPrerequisite(db, b.id, a.id)).toThrow(/cycle/);
  expect(readWorkspaceGraph(db, workspace).edges).toEqual(visible);
});
