import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readLesson } from '../reader/ipc';
import type { Document } from '../reader/document';
import { lessonContext } from '../reader/stored-lesson';
import { saveCheckEvidence } from '../tutor/assessment';
import { prepareTurn } from '../tutor/prompt';
import { executeTurn } from '../tutor/turn';
import { transaction } from './connection';
import { recordEvidence } from './evidence';
import { MIGRATIONS, migrate } from './migrations';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';
import { readLearningProgress } from './learning-progress';
import { lessonRevision } from './lesson-selection';
import { saveLesson } from './lessons';
import { writeMasteryRow } from './mastery';
import { masteryScope } from './mastery-scope';

it('reads the newest workspace-independent lesson and its check streak after a v6 upgrade', () => {
  const db = migratedQueue();
  try {
    const address = { workspaceId: 'a', conceptId: 3, depth: 'low' } as const;
    const body = { schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Queue', text: 'New shared opening.' }] };
    const fresh = saveLesson(db, { ...address, workspaceId: undefined, cacheKey: 'portable', schemaVersion: body.schema,
      provider: 'codex', model: 'fixture', body });
    const selectedRevision = lessonRevision(fresh.id, JSON.stringify(body));
    const revision = 'a'.repeat(64);
    transaction(db, () => writeMasteryRow(db, address, {
      scope: masteryScope({ ...address, snapshotId: 1 }, selectedRevision), revision, lessonId: fresh.id,
      state: JSON.stringify({ stage: 'understood', check: null, attempts: 2, correctAnswers: 2, applied: true, cycle: 0, prompts: [] }),
    }));
    recordEvidence(db, { ...address, workspaceId: 'b', status: 'demonstrated', source: 'check', masteryVerified: true });

    expect(readLesson(db, address)).toMatchObject({
      revision: selectedRevision, blocks: [{ text: 'New shared opening.' }], mastery: { stage: 'understood', correctAnswers: 2 },
    });
    expect(readLearningProgress(db, readWorkspaceGraph(db, 'a'), 'low').checks).toMatchObject([
      { conceptId: 3, lessonRevision: selectedRevision, masteryRevision: revision, streak: 2, attempted: true },
    ]);
    expect(readLesson(db, { ...address, workspaceId: 'b' })).toMatchObject({
      revision: selectedRevision, blocks: [{ text: 'New shared opening.' }], mastery: { stage: 'understood' },
    });
  } finally {
    db.close();
  }
});

it('recovers an unreadable migrated opening with or without a readable fallback', async () => {
  const db = migratedQueue();
  try {
    const address = { workspaceId: 'a', conceptId: 3, depth: 'low' } as const;
    const body: Document = { schema: 'delve.lesson/1', blocks: [{ type: 'prose', heading: 'Queue', text: 'Readable shared opening.' }] };
    const fallback = saveLesson(db, { ...address, workspaceId: undefined, cacheKey: 'fallback', schemaVersion: body.schema,
      provider: 'codex', model: 'fixture', body });
    db.prepare("UPDATE lessons SET body = '{}', created_at = '2100-01-01' WHERE id = 1").run();
    recordEvidence(db, { ...address, workspaceId: 'b', status: 'demonstrated', source: 'check', masteryVerified: true });
    expect(readLesson(db, address)).toMatchObject({ invalidLatest: true, blocks: [{ text: 'Readable shared opening.' }] });
    db.prepare('DELETE FROM lessons WHERE id = ?').run(fallback.id);
    expect(readLesson(db, address)).toMatchObject({ invalidLatest: true, revision: null, blocks: [], mastery: { stage: 'understood' } });
    const turn = prepareTurn(db, { ...address, provider: 'codex', intent: { kind: 'teach' } });
    expect(turn.selected.invalidLatest).toBe(true);
    const check: Document['blocks'][number] = { type: 'check', kind: 'prediction', prompt: 'A writer adds C after A and B. Which item comes out first?',
      options: ['A', 'B', 'C', 'None'], expected: 0 };
    const recovered = await executeTurn(db, async () => ({
      lesson: { ...body, blocks: [...body.blocks, check] }, assessment: null, observation: null, recommendation: null,
    }), turn, new AbortController().signal);
    expect(recovered).toMatchObject({ invalidLatest: false, blocks: [{ text: 'Readable shared opening.' }, { type: 'check' }] });
    expect(db.prepare("SELECT concept_id FROM lessons WHERE id = 1").get()?.concept_id).toBe(1);
    expect(db.prepare("SELECT concept_id FROM lessons WHERE id <> 1").get()?.concept_id).toBe(3);
  } finally {
    db.close();
  }
});

it('corroborates legacy matches to existing portable identities before transferring evidence', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 6));
    db.exec(`INSERT INTO workspaces (id,kind,name,source,created_at) VALUES ('a','git','A','/a','2020'), ('b','git','B','/b','2020');
      INSERT INTO concepts (id,key,title,summary,portable,workspace_id,created_at,updated_at) VALUES
      (1,'cache','Cache','CPU cache',1,NULL,'2020','2020'),
      (2,'ws/a/cache','Cache','HTTP response cache',0,'a','2020','2020'),
      (3,'semaphore','Semaphore','Limits concurrent access.',1,NULL,'2020','2020'),
      (4,'ws/a/semaphore','Semaphore',' limits concurrent access. ',0,'a','2020','2020'),
      (5,'queues','Queue','First in, first out.',1,NULL,'2020','2020'),
      (6,'ws/a/queue','Queue','Where this repository stores failed jobs.',0,'a','2020','2020');
      INSERT INTO workspace_concepts (workspace_id,concept_id) VALUES ('a',2), ('a',4), ('a',6), ('b',1), ('b',3), ('b',5);
      INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,recorded_at,revision,mastery_verified) VALUES
      (1,'medium','demonstrated','check','CPU hit rate','b','2020',1,1),
      (2,'medium','demonstrated','check','HTTP headers','a','2021',3,1),
      (4,'low','demonstrated','check','Release a permit','a','2021',2,1),
      (6,'low','demonstrated','check','Locate failed jobs','a','2021',2,1);`);
    migrate(db);
    expect(db.prepare('SELECT legacy_concept_id, canonical_concept_id FROM concept_identity_links').all())
      .toEqual([{ legacy_concept_id: 4, canonical_concept_id: 3 }]);
    expect(readWorkspaceGraph(db, 'a').evidence).toMatchObject([
      { conceptId: 2, note: 'HTTP headers', revision: 3 }, { conceptId: 3, note: 'Release a permit', revision: 2 },
      { conceptId: 6, note: 'Locate failed jobs', revision: 2 },
    ]);
    expect(readWorkspaceGraph(db, 'b').evidence).toMatchObject([
      { conceptId: 1, note: 'CPU hit rate', revision: 1 }, { conceptId: 3, note: 'Release a permit', revision: 2 },
    ]);
    expect(db.prepare('SELECT concept_id, note FROM migrated_evidence_archive').all())
      .toEqual([{ concept_id: 4, note: 'Release a permit' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});

function migratedQueue(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS.slice(0, 6));
  db.exec(`INSERT INTO workspaces (id,kind,name,source,created_at) VALUES ('a','git','A','/a','2020'), ('b','git','B','/b','2020');
    INSERT INTO concepts (id,key,title,portable,workspace_id,created_at,updated_at) VALUES
    (1,'ws/a/queue','Queue',0,'a','2020','2020'), (2,'ws/b/queue','Queue',0,'b','2020','2020'),
    (3,'queues','Queues',1,NULL,'2020','2020');
    INSERT INTO workspace_concepts (workspace_id,concept_id) VALUES ('a',1), ('b',2);
    INSERT INTO snapshots VALUES (1,'a','abcd','2020');`);
  db.exec("UPDATE concepts SET summary = 'First in first out ordering' WHERE id IN (1,2,3)");
  seedLegacyLesson(db);
  db.exec("UPDATE lessons SET created_at = '2020' WHERE id = 1");
  migrate(db);
  return db;
}

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
  db.prepare(`INSERT INTO conversations (id,workspace_id,concept_id,depth,title,created_at,updated_at)
    VALUES (2,'a',?,'low','Current chat','t','t')`).run(portable);
  db.exec(`INSERT INTO messages (conversation_id,role,body,created_at) VALUES (2,'learner','{"text":"Newer question"}','t');`);
  const lesson = readLesson(db, { workspaceId: 'a', conceptId: portable, depth: 'low' });
  expect(lesson.source).toBe('abcd');
  expect(lesson.blocks).toContainEqual(expect.objectContaining({ text: 'The saved queue lesson.' }));
  expect(lesson.messages).toMatchObject([{ text: 'Saved question' }, { text: 'Newer question' }]);
  expect(lesson.mastery).toMatchObject({ stage: 'checking', correctAnswers: 1 });
  const progress = readLearningProgress(db, readWorkspaceGraph(db, 'a'), 'low');
  expect(progress.checks).toMatchObject([{ conceptId: portable, snapshot: 'abcd', streak: 1, attempted: true }]);
}

function expectRelatedRemap(db: DatabaseSync, portable: number): void {
  db.prepare('INSERT INTO snapshot_concepts (snapshot_id, concept_id) VALUES (2, ?)').run(portable);
  const lesson = readLesson(db, { workspaceId: 'a', conceptId: portable, depth: 'low' });
  expect(lesson).toMatchObject({ source: 'efab', blocks: [],
    messages: [{ text: 'Saved question' }, { text: 'Newer question' }] });
  expect(readLearningProgress(db, readWorkspaceGraph(db, 'a'), 'low').checks).toEqual([]);
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
        UPDATE concepts SET summary = 'First in first out ordering' WHERE id IN (1,2,3);
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
      expect(db.prepare('SELECT legacy_concept_id, canonical_concept_id FROM concept_identity_links ORDER BY legacy_concept_id').all())
        .toEqual([{ legacy_concept_id: 1, canonical_concept_id: 3 }, { legacy_concept_id: 2, canonical_concept_id: 3 }]);
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
        UPDATE concepts SET summary = 'First in first out ordering' WHERE id IN (1,2);
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
      expect(db.prepare('SELECT legacy_concept_id, canonical_concept_id FROM concept_identity_links ORDER BY legacy_concept_id').all())
        .toEqual([{ legacy_concept_id: 1, canonical_concept_id: portable }, { legacy_concept_id: 2, canonical_concept_id: portable }]);
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
      expectRelatedRemap(db, portable);
      db.prepare("DELETE FROM workspaces WHERE id = 'a'").run();
      expect(db.prepare('SELECT count(*) AS n FROM migrated_evidence_archive').get()!.n).toBe(4);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

it('preserves distinct punctuation and keeps an uncorroborated title scoped', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 6));
    db.exec(`INSERT INTO workspaces (id,kind,name,source,created_at) VALUES ('a','git','A','/a','t'), ('b','git','B','/b','t');
      INSERT INTO concepts (id,key,title,summary,portable,workspace_id,created_at,updated_at) VALUES
      (1,'ws/a/c','C++','Templates',0,'a','t','t'), (2,'ws/b/c','C#','Generics',0,'b','t','t'),
      (3,'c','C','A procedural language',1,NULL,'t','t'),
      (4,'ws/a/bloom-filter','Bloom filter','Probabilistic set membership',0,'a','t','t'),
      (5,'ws/b/bloom-filter','Bloom filter','Probabilistic set membership',0,'b','t','t'),
      (6,'ds/bloom-filter','Bloom filter','Probabilistic set membership',1,NULL,'t','t');
      INSERT INTO workspace_concepts (workspace_id,concept_id) VALUES ('a',1), ('b',2), ('a',4), ('b',5), ('a',6);
      INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,recorded_at,mastery_verified) VALUES
      (1,'low','demonstrated','check','C++ templates','a','t',1),
      (6,'medium','demonstrated','check','False positives','a','t',1);`);
    migrate(db);
    expect(db.prepare('SELECT legacy_concept_id, canonical_concept_id FROM concept_identity_links ORDER BY legacy_concept_id').all())
      .toEqual([]);
    const graph = readWorkspaceGraph(db, 'b');
    expect(graph.concepts.map(c => c.id)).toEqual([2, 5]);
    expect(graph.evidence).toEqual([]);
    expect(db.prepare('SELECT note FROM evidence WHERE concept_id = 1').get()?.note).toBe('C++ templates');
  } finally {
    db.close();
  }
});

it('does not merge conflicting known aliases when upgrading a v0.1.0 schema-5 profile', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 5));
    db.exec(`INSERT INTO workspaces (id,kind,name,source,created_at) VALUES ('a','git','A','/a','t'), ('b','git','B','/b','t');
      INSERT INTO concepts (id,key,title,summary,portable,workspace_id,created_at,updated_at) VALUES
      (1,'ws/a/tcp','TCP','A reliable ordered byte stream',0,'a','t','t'),
      (2,'ws/b/tcp','Transmission Control Protocol','A tropical climate policy for farmers',0,'b','t','t');
      INSERT INTO workspace_concepts (workspace_id,concept_id) VALUES ('a',1),('b',2);
      INSERT INTO snapshots VALUES (1,'a','abcd','t');
      INSERT INTO lessons (id,cache_key,schema_version,concept_id,workspace_id,snapshot_id,depth,provider,model,body,created_at)
      VALUES (1,'tcp-opening','delve.lesson/1',1,'a',1,'medium','codex','fixture',
        '{"schema":"delve.lesson/1","blocks":[{"type":"prose","heading":"TCP","text":"The network lesson."}]}','t');
      INSERT INTO transfer_links (from_concept_id,to_concept_id,reason,provider,model,workspace_id,created_at)
      VALUES (1,2,'Compare lessons from different domains.','codex','fixture','a','t');
      INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,recorded_at) VALUES
      (1,'medium','demonstrated','check','network proof','a','t'), (2,'low','partial','check','climate proof','b','t');`);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT * FROM concept_identity_links').all()).toEqual([]);
    expect(db.prepare('SELECT concept_id,note FROM evidence ORDER BY concept_id').all())
      .toEqual([{ concept_id: 1, note: 'network proof' }, { concept_id: 2, note: 'climate proof' }]);
    expect(readLesson(db, { workspaceId: 'a', conceptId: 1, depth: 'medium' })).toMatchObject({
      source: 'abcd', blocks: [{ text: 'The network lesson.' }],
    });
    expect(db.prepare('SELECT from_concept_id,to_concept_id FROM transfer_links').all())
      .toEqual([{ from_concept_id: 1, to_concept_id: 2 }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
});

it('does not merge opposite high-overlap descriptions into an existing portable concept', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 5));
    db.exec(`INSERT INTO workspaces (id,kind,name,source,created_at) VALUES ('a','git','A','/a','t'), ('b','git','B','/b','t');
      INSERT INTO concepts (id,key,title,summary,portable,workspace_id,created_at,updated_at) VALUES
      (1,'queues','Queue','A collection that processes queued jobs in first in first out order.',1,NULL,'t','t'),
      (2,'ws/b/queue','Queue','A collection that processes queued jobs in last in first out order.',0,'b','t','t');
      INSERT INTO workspace_concepts (workspace_id,concept_id) VALUES ('a',1),('b',2);
      INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,recorded_at) VALUES
      (1,'medium','demonstrated','check','FIFO proof','a','t');`);
    migrate(db);
    expect(db.prepare('SELECT * FROM concept_identity_links').all()).toEqual([]);
    expect(readWorkspaceGraph(db, 'b').evidence).toEqual([]);
    expect(readWorkspaceGraph(db, 'b').concepts.map(concept => concept.id)).toEqual([2]);
  } finally { db.close(); }
});

it.each([
  { key: 'tcp', portableTitle: 'TCP', localTitle: 'HTTP' },
  { key: 'tcp', portableTitle: 'HTTP', localTitle: 'TCP' },
  { key: 'transport', portableTitle: 'HTTP', localTitle: 'TCP' },
])(
  'does not link disagreeing known aliases during the v0.1.0 upgrade ($key, $portableTitle, $localTitle)', ({ key, portableTitle, localTitle }) => {
    const db = new DatabaseSync(':memory:');
    try {
      migrate(db, MIGRATIONS.slice(0, 5));
      db.exec("INSERT INTO workspaces (id,kind,name,source,created_at) VALUES ('a','git','A','/a','t'), ('b','git','B','/b','t')");
      const concept = db.prepare(`INSERT INTO concepts (id,key,title,summary,portable,workspace_id,created_at,updated_at)
        VALUES (?,?,?,'A reliable ordered byte stream.',?,?,'t','t')`);
      concept.run(1, key, portableTitle, 1, null);
      concept.run(2, `ws/b/${key}`, localTitle, 0, 'b');
      db.exec(`INSERT INTO workspace_concepts (workspace_id,concept_id) VALUES ('a',1),('b',2);
        INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,recorded_at) VALUES
        (1,'medium','demonstrated','check','Original proof','a','t'), (2,'low','partial','check','Local proof','b','t');`);

      expect(migrate(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT * FROM concept_identity_links').all()).toEqual([]);
      expect(readWorkspaceGraph(db, 'b').concepts).toMatchObject([{ id: 2, title: localTitle, portable: false }]);
      expect(readWorkspaceGraph(db, 'b').evidence).toMatchObject([{ conceptId: 2, note: 'Local proof' }]);
      expect(readWorkspaceGraph(db, 'a').evidence).toMatchObject([{ conceptId: 1, note: 'Original proof' }]);
    } finally {
      db.close();
    }
  },
);
