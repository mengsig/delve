import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LessonAddress } from '../../shared/reader';
import { listWorkspaceConcepts, upsertConcept } from '../db/concepts';
import { openDatabase, type Db } from '../db/connection';
import { seedDemoWorkspaces } from '../db/demo';
import { listEvidence } from '../db/evidence';
import { bindSnapshot, saveLesson } from '../db/lessons';
import { addWorkspace, listWorkspaces } from '../db/workspaces';
import { readerHandlers, readerSchemas } from './ipc';

let db: Db;
let address: LessonAddress;
beforeEach(() => {
  db = openDatabase(':memory:');
  const workspaceId = addWorkspace(db, { kind: 'topic', title: 'A real topic' }).id;
  const concept = upsertConcept(db, { key: 'focus', title: 'Focus', portable: true, workspaceId });
  address = { workspaceId, conceptId: concept.id, depth: 'medium' };
});
afterEach(() => db.close());

function save(cacheKey: string, blocks: unknown[]) {
  return saveLesson(db, { ...address, cacheKey, provider: 'codex', model: 'a saved model',
    schemaVersion: 'delve.lesson/1', body: { schema: 'delve.lesson/1', blocks } });
}

describe('stored lesson reader', () => {
  it('preserves unknown blocks and falls back to the last valid document when newer content is invalid', () => {
    save('good', [{ type: 'prose', heading: 'The idea', text: 'Look for detail.' }, { type: 'new-kind', script: 'ignored' }]);
    save('bad', [{ type: 'code', source: 'source', lines: ['line'], span: { line: 2, start: 1, end: 2 } }]);
    const lesson = readerHandlers(db)['reader:lesson'](address);
    expect(lesson.invalidLatest).toBe(true);
    expect(lesson.blocks).toEqual([{ type: 'prose', heading: 'The idea', text: 'Look for detail.' }, { type: 'unknown', name: 'new-kind' }]);
    expect(lesson.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(lesson.messages).toEqual([]);
  });

  it('binds the answer to the displayed lesson and records exact-depth evidence once', () => {
    const check = { type: 'check', prompt: 'Which point?', options: ['Near', 'Far'], expected: 1 };
    save('one', [check]);
    const handlers = readerHandlers(db);
    const lesson = handlers['reader:lesson'](address);
    expect(lesson.blocks[0]).not.toHaveProperty('expected');
    const request = { ...address, revision: lesson.revision!, option: 0 };
    expect(handlers['reader:answer'](request).demonstrated).toBe(false);
    expect(listEvidence(db, address.conceptId)).toEqual([]);
    expect(handlers['reader:answer']({ ...request, option: 1 }).demonstrated).toBe(true);
    handlers['reader:answer']({ ...request, option: 1 });
    expect(listEvidence(db, address.conceptId)).toMatchObject([{ revision: 1, depth: address.depth, workspaceId: address.workspaceId }]);
    save('one', [{ ...check, expected: 0 }]);
    expect(() => handlers['reader:answer'](request)).toThrow(/current check/);
    save('two', [check, check]);
    expect(handlers['reader:lesson'](address).invalidLatest).toBe(true);
  });

  it('reads earlier lesson conversations and keeps old snapshots out of a new revision', () => {
    const snapshotId = bindSnapshot(db, address.workspaceId, 'abcd001');
    const lesson = saveLesson(db, { ...address, snapshotId, cacheKey: 'bound', schemaVersion: 'delve.lesson/1',
      provider: 'codex', model: 'saved', body: { schema: 'delve.lesson/1', blocks: [{ type: 'trace', steps: ['First', 'Second'] }] } });
    const prior = db.prepare(`INSERT INTO conversations (workspace_id, concept_id, lesson_id, title, created_at, updated_at)
      VALUES (?, ?, ?, 'Existing lesson', 'then', 'then')`).run(address.workspaceId, address.conceptId, lesson.id);
    db.prepare(`INSERT INTO messages (conversation_id, role, body, created_at) VALUES (?, 'learner', ?, 'then')`)
      .run(prior.lastInsertRowid, JSON.stringify('Earlier question'));
    const read = readerHandlers(db)['reader:lesson'];
    const body = read(address);
    expect(body.source).toBe('abcd001');
    expect(body.messages).toMatchObject([{ role: 'learner', text: 'Earlier question' }]);
    bindSnapshot(db, address.workspaceId, 'abcd002');
    expect(read(address)).toMatchObject({ blocks: [], source: 'abcd002', messages: body.messages });
  });

  it('retains local questions through generation and keeps workspace and depth boundaries', () => {
    const handlers = readerHandlers(db);
    expect(handlers['reader:lesson'](address).blocks).toEqual([]);
    const written = handlers['reader:message']({ ...address, text: 'How do I focus?' });
    expect(written).toMatchObject([{ role: 'learner', text: 'How do I focus?' }]);
    save('one', [{ type: 'diagram', nodes: ['Eye', 'Lens'] }]);
    expect(handlers['reader:lesson'](address).messages).toEqual(written);
    expect(handlers['reader:lesson']({ ...address, depth: 'low' }).messages).toEqual([]);
    const other = addWorkspace(db, { kind: 'topic', title: 'Other topic' });
    expect(() => handlers['reader:message']({ ...address, workspaceId: other.id, text: 'Wrong scope' })).toThrow(/does not contain/);
    upsertConcept(db, { key: 'focus', title: 'Focus', portable: true, workspaceId: other.id });
    expect(handlers['reader:lesson']({ ...address, workspaceId: other.id })).toMatchObject({ messages: [], blocks: [] });
    expect(readerSchemas['reader:message'].safeParse({ ...address, text: '  ' }).success).toBe(false);
  });
});

it('teaches from the explicit sample provider and supplies text alternatives for its environments', () => {
  db.close();
  db = openDatabase(':memory:');
  seedDemoWorkspaces(db);
  const archon = listWorkspaces(db).workspaces.find(w => w.name === 'Archon (demo)');
  const lease = listWorkspaceConcepts(db, archon!.id).find(c => c.key.endsWith(':lease'));
  const sample = { workspaceId: archon!.id, conceptId: lease!.id, depth: 'low' as const };
  const handlers = readerHandlers(db);
  const body = handlers['reader:lesson'](sample);
  expect(body.blocks.map(b => b.type)).toEqual(['prose', 'environment', 'prose', 'diagram', 'prose', 'code', 'analogy', 'check']);
  expect(body.blocks[1]).toMatchObject({ fallback: expect.stringContaining('generation 8') });
  expect(handlers['reader:message']({ ...sample, text: 'Show me an example' })).toMatchObject([
    { role: 'learner' }, { role: 'tutor', text: expect.stringContaining('generation 7') },
  ]);
  expect(handlers['reader:lesson'](sample).messages).toHaveLength(2);
});
