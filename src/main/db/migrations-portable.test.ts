import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MIGRATIONS, migrate } from './migrations';
import { readWorkspaceGraph } from './graph';
import { getGlobalKnowledgeGraph } from './knowledge';

  it('reuses a matching portable concept and skips ambiguous titles atomically', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      migrate(db, MIGRATIONS.slice(0, 6));
      db.exec(`INSERT INTO workspaces (id, kind, name, source, created_at) VALUES
        ('a', 'git', 'A', '/a', 't'), ('b', 'git', 'B', '/b', 't');
        INSERT INTO concepts (id, key, title, portable, workspace_id, created_at, updated_at) VALUES
        (1, 'ws/a/queue', 'Queue', 0, 'a', 't', 't'), (2, 'ws/b/queue', 'Queue', 0, 'b', 't', 't'),
        (3, 'queue', 'Queue', 1, NULL, 't', 't'),
        (4, 'ws/a/cache', 'Cache', 0, 'a', 't', 't'), (5, 'ws/b/cache', 'Different', 0, 'b', 't', 't');
        INSERT INTO workspace_concepts (workspace_id, concept_id) VALUES ('a',1), ('b',2), ('a',4), ('b',5);
        INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,revision,recorded_at,mastery_verified) VALUES
        (1,'high','demonstrated','check','local','a',2,'2020',1),
        (3,'high','partial','self-report','portable',NULL,9,'2021',0);
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
        INSERT INTO snapshots VALUES (1,'a','abcd','t');
        INSERT INTO snapshot_concepts VALUES (1,1);
        INSERT INTO lessons (id,cache_key,schema_version,concept_id,workspace_id,snapshot_id,depth,provider,model,body,created_at)
          VALUES (1,'cache','v',1,'a',1,'medium','p','m','{}','t');
        INSERT INTO conversations (id,workspace_id,concept_id,lesson_id,title,created_at,updated_at,depth)
          VALUES (1,'a',1,1,'Chat','t','t','medium');
        INSERT INTO repository_generations (id,cache_key,workspace_id,snapshot_id,kind,ref,depth,provider,model,schema_version,result,proposal,last_used,next_concept,reason,created_at)
          VALUES (1,'gen','a',1,'baseline','abcd','medium','p','m','v','{}','{}',1,1,'reason','t');
        INSERT INTO evidence (concept_id,depth,status,source,note,workspace_id,revision,recorded_at,mastery_verified) VALUES
          (1,'medium','demonstrated','check','verified','a',2,'2020',1),
          (2,'medium','partial','self-report','newer','b',8,'2022',0),
          (1,'low','partial','self-report','older','a',1,'2020',0),
          (2,'low','partial','self-report','latest','b',3,'2022',0);`);
      migrate(db);
      const portable = db.prepare("SELECT id FROM concepts WHERE key = 'queue'").get()!.id as number;
      expect(db.prepare('SELECT legacy_concept_id, portable_concept_id FROM concept_identity_links ORDER BY legacy_concept_id').all())
        .toEqual([{ legacy_concept_id: 1, portable_concept_id: portable }, { legacy_concept_id: 2, portable_concept_id: portable }]);
      expect(db.prepare('SELECT depth, note, revision FROM evidence WHERE concept_id = ? ORDER BY depth').all(portable))
        .toEqual([{ depth: 'low', note: 'latest', revision: 3 }, { depth: 'medium', note: 'verified', revision: 2 }]);
      expect(db.prepare('SELECT count(*) AS n FROM migrated_evidence_archive').get()!.n).toBe(4);
      expect(db.prepare('SELECT count(*) AS n FROM evidence WHERE concept_id IN (1,2)').get()!.n).toBe(4);
      expect(db.prepare('SELECT concept_id, workspace_id FROM lessons WHERE id = 1').get()).toEqual({ concept_id: 1, workspace_id: 'a' });
      expect(db.prepare('SELECT concept_id, lesson_id FROM conversations WHERE id = 1').get()).toEqual({ concept_id: 1, lesson_id: 1 });
      expect(db.prepare('SELECT next_concept FROM repository_generations WHERE id = 1').get()!.next_concept).toBe(1);
      expect(db.prepare('SELECT concept_id FROM snapshot_concepts WHERE snapshot_id = 1').get()!.concept_id).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const graph = readWorkspaceGraph(db, 'a', true);
      expect(graph.concepts.map(c => c.id)).not.toContain(1);
      expect(graph.edges).toContainEqual({ conceptId: 3, prerequisiteId: portable });
      expect(readWorkspaceGraph(db, 'b', true).edges).toEqual([]);
      expect(getGlobalKnowledgeGraph(db).concepts.map(c => c.id)).not.toContain(1);
      db.prepare("DELETE FROM workspaces WHERE id = 'a'").run();
      expect(db.prepare('SELECT count(*) AS n FROM migrated_evidence_archive').get()!.n).toBe(4);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
