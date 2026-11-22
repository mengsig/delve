import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MIGRATIONS, migrate } from './migrations';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';
import { readLearningProgress } from './learning-progress';
import { lessonRevision } from './lesson-selection';
import { masteryScope } from './mastery-scope';
import { readLesson } from '../reader/ipc';
import { lessonContext } from '../reader/stored-lesson';
import { saveCheckEvidence } from '../tutor/assessment';
import { transaction } from './connection';

function seedLegacyLesson(db: DatabaseSync): void {
  const check = { type: 'check', kind: 'prediction', prompt: 'Which task is next?', options: ['A', 'B', 'C', 'D'], expected: 0 };
  const document = JSON.stringify({ schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Queue', text: 'The saved queue lesson.' }, check] });
  db.prepare(`INSERT INTO lessons (id,cache_key,schema_version,concept_id,workspace_id,snapshot_id,depth,provider,model,body,created_at)
    VALUES (1,'cache','delve.lesson/1',1,'a',1,'low','codex','fixture',?,'t')`).run(document);
  db.exec(`INSERT INTO conversations (id,workspace_id,concept_id,lesson_id,title,created_at,updated_at,depth)
    VALUES (1,'a',1,1,'Chat','t','t','low');
    INSERT INTO messages (conversation_id,role,body,created_at) VALUES (1,'learner','{"text":"Saved question"}','t');`);
  const scope = masteryScope({ workspaceId: 'a', conceptId: 1, depth: 'low', snapshotId: 1 }, lessonRevision(1, document));
  const state = JSON.stringify({ stage: 'checking', check, attempts: 1, correctAnswers: 1, applied: true, cycle: 0, prompts: [check.prompt] });
  db.prepare("INSERT INTO lesson_mastery (workspace_id,concept_id,depth,lesson_id,scope,revision,state) VALUES ('a',1,'low',1,?,?,?)")
    .run(scope, 'f'.repeat(64), state);
}

function expectLegacyReader(db: DatabaseSync, portable: number): void {
  const lesson = readLesson(db, { workspaceId: 'a', conceptId: portable, depth: 'low' });
  expect(lesson.source).toBe('abcd');
  expect(lesson.blocks).toContainEqual(expect.objectContaining({ text: 'The saved queue lesson.' }));
  expect(lesson.messages).toMatchObject([{ text: 'Saved question' }]);
  expect(lesson.mastery).toMatchObject({ stage: 'checking', correctAnswers: 1 });
  const progress = readLearningProgress(db, readWorkspaceGraph(db, 'a'), 'low');
  expect(progress.checks).toMatchObject([{ conceptId: portable, snapshot: 'abcd', streak: 1, attempted: true }]);
}

function proveGlobalLearning(db: DatabaseSync, portable: number): void {
  const context = lessonContext(db, { workspaceId: 'a', conceptId: portable, depth: 'low' });
  expect(context).toMatchObject({ conceptId: 1, canonicalConceptId: portable, snapshot: 'abcd' });
  transaction(db, () => saveCheckEvidence(db, context, { prompt: 'Which task is next?', selectedIndex: 0,
    answer: 'A', reference: ['A'], correct: true }, true));
  expect(readWorkspaceGraph(db, 'b').evidence).toContainEqual(expect.objectContaining({
    conceptId: portable, depth: 'low', workspaceId: 'a', status: 'demonstrated',
  }));
  expect(db.prepare("SELECT note FROM evidence WHERE concept_id = 1 AND depth = 'low'").get()?.note).toBe('older');
}

  it('reuses a matching portable concept and skips ambiguous titles atomically', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      migrate(db, MIGRATIONS.slice(0, 6));
      db.exec(`INSERT INTO workspaces (id, kind, name, source, created_at) VALUES
        ('a', 'git', 'A', '/a', 't'), ('b', 'git', 'B', '/b', 't');
        INSERT INTO concepts (id, key, title, portable, workspace_id, created_at, updated_at) VALUES
        (1, 'ws/a/queue', 'Queue', 0, 'a', 't', 't'), (2, 'ws/b/queue', 'Queue', 0, 'b', 't', 't'),
        (3, 'queues', 'Queues', 1, NULL, 't', 't'),
        (4, 'ws/a/cache', 'Cache', 0, 'a', 't', 't'), (5, 'ws/b/cache', 'Different', 0, 'b', 't', 't'),
        (6, 'ws/a/routing-policy', 'Routing policy', 0, 'a', 't', 't'), (7, 'ws/b/routing-policy', 'Routing policy', 0, 'b', 't', 't');
        UPDATE concepts SET summary = 'Schedule CPU work.' WHERE id = 6;
        UPDATE concepts SET summary = 'Route HTTP hostnames.' WHERE id = 7;
        INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES ('a',1), ('b',2), ('a',4), ('b',5), ('a',6), ('b',7);
        INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,revision,recorded_at,mastery_verified) VALUES
        (1,'high','demonstrated','check','local','a',2,'2020',1),
        (3,'high','partial','self-report','portable',NULL,9,'2021',0),
        (6,'low','demonstrated','check','scheduler','a',3,'2021',1);
        CREATE TRIGGER reject_archive BEFORE INSERT ON evidence WHEN NEW.concept_id = 3
          BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
      expect(() => migrate(db)).toThrow(/Migration 7/);
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(6);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'concept_identity_links'").get()).toBeUndefined();
      db.exec('DROP TRIGGER reject_archive');
      migrate(db);
      expect(db.prepare('SELECT legacy_concept_id, portable_concept_id FROM concept_identity_links ORDER BY legacy_concept_id').all())
        .toEqual([{ legacy_concept_id: 1, portable_concept_id: 3 }, { legacy_concept_id: 2, portable_concept_id: 3 }]);
      expect(db.prepare('SELECT note FROM evidence WHERE concept_id = 3').get()!.note).toBe('local');
      expect(getGlobalKnowledgeGraph(db).concepts.filter(c => c.portable)).toMatchObject([{ id: 3, key: 'queues' }]);
      expect(readWorkspaceGraph(db, 'b').evidence).toMatchObject([{ conceptId: 3, note: 'local' }]);
      expect(db.prepare('SELECT note FROM migrated_evidence_archive ORDER BY note').all()).toEqual([{ note: 'local' }, { note: 'portable' }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('preserves scoped history and archives competing evidence on a v6 upgrade', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      migrate(db, MIGRATIONS.slice(0, 6));
      db.exec(`INSERT INTO workspaces (id, kind, name, source, created_at) VALUES
        ('a', 'git', 'A', '/a', 't'), ('b', 'github', 'B', 'b/b', 't'), ('topic', 'topic', 'Topic', 'topic', 't');
        INSERT INTO concepts (id, key, title, summary, portable, workspace_id, created_at, updated_at) VALUES
        (1, 'ws/a/queue', 'Queue', '', 0, 'a', 't', 't'),
        (2, 'ws/b/queue', ' queue ', '', 0, 'b', 't', 't'),
        (3, 'ws/a/other', 'Other', '', 0, 'a', 't', 't'),
        (4, 'ws/topic/queue', 'Queue', '', 0, 'topic', 't', 't'),
        (5, 'ws/a/change/queue', 'Queue', '', 0, 'a', 't', 't'),
        (6, 'ws/b/change/queue', 'Queue', '', 0, 'b', 't', 't'),
        (7, 'ws/a/Demo:x', 'Sample', '', 0, 'a', 't', 't'),
        (8, 'ws/b/Demo:x', 'Sample', '', 0, 'b', 't', 't');
        INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES
        ('a',1), ('b',2), ('a',3), ('topic',4), ('a',5), ('b',6), ('a',7), ('b',8);
        INSERT INTO concept_edges VALUES (3,1,'t'), (2,6,'t');
        INSERT INTO snapshots VALUES (1,'a','abcd','t'), (2,'a','efab','t');
        INSERT INTO snapshot_concepts VALUES (1,1);
        INSERT INTO repository_generations (id,cache_key,workspace_id,snapshot_id,kind,ref,depth,provider,model,schema_version,result,proposal,last_used,next_concept,reason,created_at)
          VALUES (1,'gen','a',1,'baseline','abcd','medium','p','m','v','{}','{}',1,1,'reason','t'),
            (2,'gen2','a',2,'baseline','efab','medium','p','m','v','{}','{}',2,3,'reason','t');
        INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,revision,recorded_at,mastery_verified) VALUES
          (1,'medium','demonstrated','check','verified','a',2,'2020',1),
          (2,'medium','partial','self-report','newer','b',8,'2022',0),
          (1,'low','partial','self-report','older','a',1,'2020',0),
          (2,'low','partial','self-report','latest','b',3,'2022',0);`);
      seedLegacyLesson(db);
      migrate(db);
      const portable = db.prepare("SELECT id FROM concepts WHERE key = 'queues'").get()!.id as number;
      expect(db.prepare('SELECT legacy_concept_id, portable_concept_id FROM concept_identity_links ORDER BY legacy_concept_id').all())
        .toEqual([{ legacy_concept_id: 1, portable_concept_id: portable }, { legacy_concept_id: 2, portable_concept_id: portable }]);
      expect(db.prepare('SELECT depth, note, revision FROM evidence WHERE concept_id = ? ORDER BY depth').all(portable))
        .toEqual([{ depth: 'low', note: 'latest', revision: 3 }, { depth: 'medium', note: 'verified', revision: 2 }]);
      expect(db.prepare('SELECT count(*) AS n FROM migrated_evidence_archive').get()!.n).toBe(4);
      expect(db.prepare('SELECT count(*) AS n FROM evidence WHERE concept_id IN (1,2)').get()!.n).toBe(4);
      expect(db.prepare('SELECT concept_id, workspace_id FROM lessons WHERE id = 1').get()).toEqual({ concept_id: 1, workspace_id: 'a' });
      expect(db.prepare('SELECT concept_id, lesson_id FROM conversations WHERE id = 1').get()).toEqual({ concept_id: 1, lesson_id: 1 });
      expect(db.prepare('SELECT next_concept FROM repository_generations WHERE id = 1').get()!.next_concept).toBe(1);
      expect(db.prepare('SELECT concept_id FROM snapshot_concepts WHERE snapshot_id = 1 ORDER BY concept_id').all())
        .toEqual([{ concept_id: 1 }, { concept_id: portable }]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const graph = readWorkspaceGraph(db, 'a', true);
      expect(graph.concepts.map(c => c.id)).not.toContain(1);
      expect(graph.edges).toContainEqual({ conceptId: 3, prerequisiteId: portable });
      expect(readWorkspaceGraph(db, 'b', true).edges).toEqual([]);
      expect(getGlobalKnowledgeGraph(db).concepts.map(c => c.id)).not.toContain(1);
      expectLegacyReader(db, portable);
      proveGlobalLearning(db, portable);
      db.prepare("DELETE FROM workspaces WHERE id = 'a'").run();
      expect(db.prepare('SELECT count(*) AS n FROM migrated_evidence_archive').get()!.n).toBe(4);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
