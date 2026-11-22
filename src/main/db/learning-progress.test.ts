import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import type { Depth } from '../../shared/domain';
import { lessonContext, storedLesson } from '../reader/stored-lesson';
import { upsertConcept } from './concepts';
import { openDatabase, transaction } from './connection';
import { recordEvidence, resetEvidence } from './evidence';
import { readWorkspaceGraph } from './graph';
import { readLearningProgress } from './learning-progress';
import { bindSnapshot, saveLesson } from './lessons';
import { writeMasteryRow } from './mastery';
import { masteryScope } from './mastery-scope';
import { addWorkspace } from './workspaces';

it('projects only committed checks from the current workspace, depth, snapshot and lesson revision', () => {
  const db = openDatabase(':memory:');
  try {
    const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Fieldwork' }).id;
    const other = addWorkspace(db, { kind: 'topic', title: 'Another field' }).id;
    const concept = upsertConcept(db, { workspaceId, key: 'leases', title: 'Leases', portable: true });
    upsertConcept(db, { workspaceId: other, key: 'leases', title: 'Leases', portable: true });
    const address = { workspaceId, conceptId: concept.id, depth: 'medium' } as const;
    const snapshotId = bindSnapshot(db, workspaceId, 'aaaaaaa');
    const save = (text: string, snapshot = snapshotId) => saveLesson(db, { ...address, snapshotId: snapshot, cacheKey: text,
      provider: 'codex', model: 'fixture', schemaVersion: 'delve.lesson/1',
      body: { schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Field notes', text }] } });
    const read = (id = workspaceId, depth: Depth = address.depth) =>
      readLearningProgress(db, readWorkspaceGraph(db, id, true), depth);
    const commit = () => {
      const context = lessonContext(db, address);
      const selected = storedLesson(db, context);
      assert.ok(selected.revision && selected.id !== null);
      assert.ok(!selected.invalidLatest);
      const revision = 'f'.repeat(64);
      transaction(db, () => writeMasteryRow(db, address, { scope: masteryScope(context, selected.revision), revision,
        state: JSON.stringify({ attempts: 1, correctAnswers: 1 }), lessonId: selected.id }));
      return { lessonRevision: selected.revision, masteryRevision: revision, snapshot: context.snapshot };
    };
    save('Original lesson');
    expect(read().checks).toEqual([]);
    const metadata = commit();
    expect(read().checks).toEqual([{ conceptId: concept.id, streak: 1, attempted: true, ...metadata }]);
    expect(read(other).checks).toEqual([]);
    expect(read(workspaceId, 'low').checks).toEqual([]);
    save('New revision');
    expect(read().checks).toEqual([]);
    commit();
    const nextSnapshot = bindSnapshot(db, workspaceId, 'bbbbbbb');
    save('New snapshot', nextSnapshot);
    expect(read().checks).toEqual([]);
    commit();
    recordEvidence(db, { ...address, status: 'partial', source: 'check' });
    expect(resetEvidence(db, concept.id, { workspaceId, depth: address.depth })).toBe(1);
    expect(read().checks).toEqual([]);
  } finally {
    db.close();
  }
});
