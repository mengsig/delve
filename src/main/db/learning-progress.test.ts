import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { Depth } from '../../shared/domain';
import type { LessonAddress } from '../../shared/reader';
import { lessonContext, storedLesson } from '../reader/stored-lesson';
import { upsertConcept } from './concepts';
import { openDatabase, transaction, type Db } from './connection';
import { recordEvidence, resetEvidence } from './evidence';
import { readWorkspaceGraph } from './graph';
import { readLearningProgress } from './learning-progress';
import { lessonRevision } from './lesson-selection';
import { bindSnapshot, saveLesson } from './lessons';
import { writeMasteryRow } from './mastery';
import { masteryScope } from './mastery-scope';
import { MIGRATIONS, migrate } from './migrations';
import { addWorkspace } from './workspaces';

const revision = 'f'.repeat(64);
const state = JSON.stringify({ attempts: 1, correctAnswers: 1 });
const lessonBody = (text: string) => ({ schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Field notes', text }] });
const lessonInput = (address: LessonAddress, key: string, snapshotId?: number) => ({
  ...address, snapshotId, cacheKey: key, provider: 'codex', model: 'fixture', schemaVersion: 'delve.lesson/1', body: lessonBody(key),
});

function setupConcept(db: Db, workspaceId: string, key: string): LessonAddress {
  const concept = upsertConcept(db, { workspaceId, key, title: key, portable: true });
  return { workspaceId, conceptId: concept.id, depth: 'medium' };
}

function commitCheck(db: Db, address: LessonAddress) {
  const context = lessonContext(db, address);
  const selected = storedLesson(db, context);
  assert.ok(selected.revision && selected.id !== null);
  assert.ok(!selected.invalidLatest);
  transaction(db, () => writeMasteryRow(db, address, { scope: masteryScope(context, selected.revision), revision,
    state, lessonId: selected.id }));
  return { lessonRevision: selected.revision, masteryRevision: revision, snapshot: context.snapshot };
}

it('projects only committed checks from the current workspace, depth, snapshot and lesson revision', () => {
  const db = openDatabase(':memory:');
  try {
    const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Fieldwork' }).id;
    const other = addWorkspace(db, { kind: 'topic', title: 'Another field' }).id;
    const concept = upsertConcept(db, { workspaceId, key: 'leases', title: 'Leases', portable: true });
    upsertConcept(db, { workspaceId: other, key: 'leases', title: 'Leases', portable: true });
    const address = { workspaceId, conceptId: concept.id, depth: 'medium' } as const;
    const snapshotId = bindSnapshot(db, workspaceId, 'aaaaaaa');
    const save = (text: string, snapshot = snapshotId) => saveLesson(db, lessonInput(address, text, snapshot));
    const read = (id = workspaceId, depth: Depth = address.depth) =>
      readLearningProgress(db, readWorkspaceGraph(db, id, true), depth);
    const commit = () => commitCheck(db, address);
    saveLesson(db, { ...lessonInput(address, 'Original lesson'), workspaceId: undefined });
    expect(read().checks).toEqual([]);
    const metadata = commit();
    expect(read().checks).toEqual([{ conceptId: concept.id, streak: 1, attempted: true, ...metadata }]);
    recordEvidence(db, { ...address, status: 'demonstrated', source: 'check', masteryVerified: true });
    expect(readWorkspaceGraph(db, other).evidence).toMatchObject([{ conceptId: concept.id, status: 'demonstrated' }]);
    expect(read(other).checks).toEqual([]);
    expect(read(workspaceId, 'low').checks).toEqual([]);
    saveLesson(db, { ...lessonInput(address, 'Demo only'), workspaceId: undefined, provider: 'demo' });
    expect(read().checks).toMatchObject([{ ...metadata }]);
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

it('preserves the last readable lesson and its progress across corrupt rows and cache replacements', () => {
  const db = openDatabase(':memory:');
  try {
    const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Fieldwork' }).id;
    const address = setupConcept(db, workspaceId, 'leases');
    const previous = lessonInput(address, 'Previous');
    const valid = saveLesson(db, previous);
    const check = commitCheck(db, address);
    const invalid = { schema: 'delve.lesson/1', blocks: [] };
    expect(() => saveLesson(db, { ...previous, body: invalid })).toThrow(/saved lesson was preserved/);
    const saved = saveLesson(db, { ...lessonInput(address, 'Latest'), body: invalid });
    const read = () => readLearningProgress(db, readWorkspaceGraph(db, workspaceId), address.depth).checks;
    const selected = () => storedLesson(db, lessonContext(db, address));
    expect(selected()).toMatchObject({ id: valid.id, invalidLatest: true, revision: check.lessonRevision });
    expect(read()).toMatchObject([{ ...check, streak: 1 }]);

    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE lessons SET body = ? WHERE id = ?').run('{"truncated":', saved.id);
    db.exec('PRAGMA ignore_check_constraints = OFF');
    expect(selected()).toMatchObject({ id: valid.id, invalidLatest: true, revision: check.lessonRevision });
    expect(read()).toMatchObject([{ ...check, streak: 1 }]);

    const repaired = JSON.stringify(lessonBody('New readable body'));
    db.prepare('UPDATE lessons SET body = ? WHERE id = ?').run(repaired, saved.id);
    expect(selected()).toMatchObject({ id: saved.id, invalidLatest: false, revision: lessonRevision(saved.id, repaired) });
    expect(read()).toEqual([]);

    commitCheck(db, address);
    const replacement = saveLesson(db, { ...lessonInput(address, 'Latest'), body: lessonBody('Revised in place') });
    expect(replacement.id).toBe(saved.id);
    expect(read()).toEqual([]);
  } finally {
    db.close();
  }
});

it('reads a pre-projection database with legacy check state and a valid older lesson', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 5));
    const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Fieldwork' }).id;
    const address = setupConcept(db, workspaceId, 'leases');
    const save = db.prepare(`INSERT INTO lessons (cache_key, schema_version, concept_id, workspace_id,
      depth, provider, model, created_at, body) VALUES (?, 'delve.lesson/1', ?, ?, ?, 'codex', 'fixture', ?, ?)`);
    const body = JSON.stringify(lessonBody('Legacy lesson'));
    const id = Number(save.run('valid', address.conceptId, workspaceId, address.depth, '2026-01-01', body).lastInsertRowid);
    save.run('unreadable', address.conceptId, workspaceId, address.depth, '2026-01-02', '{"blocks":[]}');
    const selectedRevision = lessonRevision(id, body);
    const scope = masteryScope({ ...address, snapshotId: null }, selectedRevision);
    transaction(db, () => writeMasteryRow(db, address, { scope, revision, state, lessonId: id }));
    migrate(db);

    const graph = readWorkspaceGraph(db, workspaceId);
    expect(readLearningProgress(db, graph, address.depth).checks).toEqual([{ conceptId: address.conceptId,
      snapshot: null, lessonRevision: selectedRevision, masteryRevision: revision, streak: 1, attempted: true }]);
    db.prepare('UPDATE lesson_mastery SET state = ?').run(JSON.stringify({ attempts: 2, correctAnswers: 0 }));
    expect(readLearningProgress(db, graph, address.depth).checks).toMatchObject([{ streak: 0, attempted: true }]);
    db.exec('UPDATE lesson_mastery SET state = NULL');
    expect(readLearningProgress(db, graph, address.depth).checks).toEqual([]);
  } finally {
    db.close();
  }
});

it('uses one indexed projection statement for one or many newly committed checks', () => {
  const db = openDatabase(':memory:');
  try {
    const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Fieldwork' }).id;
    for (let index = 1; index <= 32; index++) {
      const key = `concept-${index}`;
      const address = setupConcept(db, workspaceId, key);
      saveLesson(db, { ...lessonInput(address, key), body: lessonBody('a'.repeat(16000)) });
      commitCheck(db, address);
      if (index !== 1 && index !== 32) continue;
      const graph = readWorkspaceGraph(db, workspaceId);
      const prepare = vi.spyOn(db, 'prepare');
      try {
        expect(readLearningProgress(db, graph, address.depth).checks).toHaveLength(index);
        expect(prepare).toHaveBeenCalledTimes(1);
        const [sql] = prepare.mock.calls[0]!;
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all({ workspace: workspaceId, depth: address.depth, demo: 0 }).map(row => row.detail);
        expect(plan).toEqual(expect.arrayContaining([
          expect.stringContaining('USING INDEX mastery_progress'),
          expect.stringContaining('USING COVERING INDEX lessons_selectable_by_scope'),
        ]));
      } finally {
        prepare.mockRestore();
      }
    }
  } finally {
    db.close();
  }
});

it('uses the current change binding while keeping baseline concepts on the baseline snapshot', () => {
  const db = openDatabase(':memory:');
  try {
    const workspaceId = addWorkspace(db, { kind: 'topic', title: 'Fieldwork' }).id;
    const baseline = setupConcept(db, workspaceId, 'baseline');
    const change = setupConcept(db, workspaceId, 'change');
    db.prepare('UPDATE workspace_concepts SET on_atlas = 0 WHERE workspace_id = ? AND concept_id = ?')
      .run(workspaceId, change.conceptId);
    const saveBinding = db.prepare(`INSERT INTO repository_generations
      (cache_key, workspace_id, snapshot_id, kind, ref, depth, provider, model, schema_version, result, proposal,
       last_used, next_concept, reason, created_at) VALUES (?, ?, ?, ?, ?, 'medium', 'codex', 'fixture',
       'fixture', '{"brief":{"title":"Fixture"}}', '{}', ?, ?, 'Fixture', '2026-01-01')`);
    const linkSnapshot = db.prepare('INSERT INTO snapshot_concepts (snapshot_id, concept_id) VALUES (?, ?)');
    const bind = (address: LessonAddress, kind: 'baseline' | 'commit', sha: string, sequence: number) => {
      const snapshotId = bindSnapshot(db, workspaceId, sha);
      saveBinding.run(sha, workspaceId, snapshotId, kind, sha, sequence, address.conceptId);
      linkSnapshot.run(snapshotId, address.conceptId);
      return snapshotId;
    };
    saveLesson(db, lessonInput(baseline, 'baseline lesson', bind(baseline, 'baseline', 'aaaaaaa', 1)));
    saveLesson(db, lessonInput(change, 'change lesson', bind(change, 'commit', 'bbbbbbb', 2)));
    const baselineCheck = commitCheck(db, baseline);
    const changeCheck = commitCheck(db, change);
    expect(baselineCheck.snapshot).toBe('aaaaaaa');
    expect(changeCheck.snapshot).toBe('bbbbbbb');
    const read = (includeChanges: boolean) =>
      readLearningProgress(db, readWorkspaceGraph(db, workspaceId, includeChanges), change.depth).checks;
    expect(read(false)).toMatchObject([{ conceptId: baseline.conceptId, ...baselineCheck }]);
    expect(read(true)).toMatchObject([{ conceptId: baseline.conceptId, ...baselineCheck }, { conceptId: change.conceptId, ...changeCheck }]);
    bind(change, 'commit', 'ccccccc', 3);
    expect(read(true)).toMatchObject([{ conceptId: baseline.conceptId, ...baselineCheck }]);
  } finally {
    db.close();
  }
});
