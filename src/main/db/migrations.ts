import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { indexSavedChanges } from './migration-change-concepts';
import { compatibleDescriptions, normalizedConceptName, portableAlias } from './portable-identity';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  registerFunctions?: (db: DatabaseSync) => void;
  afterSql?: (db: DatabaseSync) => void;
}

function registerPortableIdentity(db: DatabaseSync): void {
  db.function('delve_portable_key', { deterministic: true, directOnly: true }, (key, title) => {
    assert.ok(typeof key === 'string');
    assert.ok(typeof title === 'string');
    const alias = portableAlias(key, title);
    return alias === undefined ? key : alias;
  });
  db.function('delve_compatible_descriptions', { deterministic: true, directOnly: true }, (left, right) => {
    assert.equal(typeof left, 'string');
    assert.equal(typeof right, 'string');
    return Number(compatibleDescriptions(String(left), String(right)));
  });
  db.function('delve_normalized_concept', { deterministic: true, directOnly: true }, text => {
    assert.ok(typeof text === 'string');
    return normalizedConceptName(text);
  });
}

const INITIAL_SCHEMA = `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'github', 'topic')),
  name TEXT NOT NULL CHECK (length(name) > 0),
  source TEXT NOT NULL CHECK (length(source) > 0),
  created_at TEXT NOT NULL,
  last_opened_at TEXT,
  UNIQUE (kind, source)
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A portable concept (workspace_id NULL) is shared by every workspace; a local one belongs to one.
CREATE TABLE concepts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (length(key) > 0),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT NOT NULL DEFAULT '',
  portable INTEGER NOT NULL CHECK (portable IN (0, 1)),
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((portable = 1 AND workspace_id IS NULL) OR (portable = 0 AND workspace_id IS NOT NULL))
);

CREATE TABLE workspace_concepts (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  concept_id INTEGER NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, concept_id)
);

-- concept_id requires prerequisite_id.
CREATE TABLE concept_edges (
  concept_id INTEGER NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  prerequisite_id INTEGER NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (concept_id, prerequisite_id),
  CHECK (concept_id <> prerequisite_id)
);
CREATE INDEX concept_edges_prerequisite ON concept_edges (prerequisite_id);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) BETWEEN 4 AND 64),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, commit_sha)
);

CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  concept_id INTEGER NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  snapshot_id INTEGER REFERENCES snapshots (id) ON DELETE SET NULL,
  depth TEXT NOT NULL CHECK (depth IN ('high', 'medium', 'low')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL
);
CREATE INDEX lessons_concept_depth ON lessons (concept_id, depth);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  concept_id INTEGER REFERENCES concepts (id) ON DELETE SET NULL,
  lesson_id INTEGER REFERENCES lessons (id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('learner', 'tutor', 'system')),
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

-- One revisable record per concept and depth; workspace/snapshot record where it was shown.
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
  depth TEXT NOT NULL CHECK (depth IN ('high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('demonstrated', 'partial', 'revisit')),
  source TEXT NOT NULL CHECK (source IN ('check', 'environment', 'self-report')),
  note TEXT NOT NULL DEFAULT '',
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  snapshot_id INTEGER REFERENCES snapshots (id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  recorded_at TEXT NOT NULL,
  UNIQUE (concept_id, depth)
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: INITIAL_SCHEMA },
  {
    version: 2,
    name: 'scope reader conversations and link evidence origins',
    sql: `ALTER TABLE conversations ADD COLUMN depth TEXT CHECK (depth IN ('high', 'medium', 'low'));
          CREATE UNIQUE INDEX conversations_by_depth ON conversations (workspace_id, concept_id, depth);
          INSERT OR IGNORE INTO workspace_concepts (workspace_id, concept_id)
          SELECT e.workspace_id, e.concept_id FROM evidence e JOIN concepts c ON c.id = e.concept_id
          WHERE e.workspace_id IS NOT NULL AND c.portable = 1;`,
  },
  {
    version: 3,
    name: 'bind repository maps and change conversations to reviewed sources',
    sql: `ALTER TABLE workspace_concepts ADD COLUMN on_atlas INTEGER NOT NULL DEFAULT 1 CHECK (on_atlas IN (0, 1));
    CREATE TABLE snapshot_concepts (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots ON DELETE CASCADE,
      concept_id INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      PRIMARY KEY (snapshot_id, concept_id)
    );
    CREATE TABLE repository_generations (
      id INTEGER PRIMARY KEY,
      cache_key TEXT UNIQUE NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('baseline', 'commit', 'pr')),
      ref TEXT NOT NULL,
      depth TEXT NOT NULL CHECK (depth IN ('high', 'medium', 'low')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      result TEXT NOT NULL CHECK (json_valid(result)),
      proposal TEXT NOT NULL CHECK (json_valid(proposal)),
      last_used INTEGER NOT NULL UNIQUE,
      next_concept INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX repository_saved ON repository_generations (workspace_id, kind, ref, depth, provider, model, last_used);
    CREATE INDEX repository_path ON repository_generations (workspace_id, depth, last_used);
    CREATE INDEX snapshot_membership ON snapshot_concepts (concept_id, snapshot_id);`,
  },
  {
    version: 4,
    name: 'persist guided lesson mastery',
    sql: `ALTER TABLE evidence ADD COLUMN mastery_verified INTEGER NOT NULL DEFAULT 0 CHECK (
      mastery_verified IN (0, 1) AND (mastery_verified = 0 OR (status = 'demonstrated' AND source = 'check'))
    );
    UPDATE evidence SET mastery_verified = 1 WHERE status = 'demonstrated' AND source = 'check'
      AND note = 'Curated demo evidence.'
      AND workspace_id IN ('de100000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000002', 'de100000-0000-4000-8000-000000000003');
    CREATE TABLE lesson_mastery (
      workspace_id TEXT NOT NULL,
      concept_id INTEGER NOT NULL,
      depth TEXT NOT NULL CHECK (depth IN ('high', 'medium', 'low')),
      lesson_id INTEGER REFERENCES lessons ON DELETE CASCADE,
      scope TEXT NOT NULL,
      revision TEXT NOT NULL,
      state TEXT CHECK (json_valid(state)),
      PRIMARY KEY (workspace_id, concept_id, depth),
      FOREIGN KEY (workspace_id, concept_id) REFERENCES workspace_concepts ON DELETE CASCADE
    );`,
  },
  {
    version: 5,
    name: 'persist cross-concept transfer links',
    sql: `CREATE TABLE transfer_links (
      id INTEGER PRIMARY KEY,
      from_concept_id INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      to_concept_id INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (length(reason) > 0),
      provider TEXT NOT NULL CHECK (length(provider) > 0),
      model TEXT NOT NULL CHECK (length(model) > 0),
      workspace_id TEXT REFERENCES workspaces ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      CHECK (from_concept_id <> to_concept_id)
    );
    CREATE UNIQUE INDEX transfer_links_pair ON transfer_links (min(from_concept_id, to_concept_id), max(from_concept_id, to_concept_id));
    CREATE INDEX transfer_links_to ON transfer_links (to_concept_id);`,
  },
  {
    version: 6,
    name: 'index lesson selection and committed check progress',
    sql: `-- NULL requires validation; an empty revision marks an unreadable lesson.
    ALTER TABLE lessons ADD COLUMN document_revision TEXT;
    CREATE INDEX lessons_selectable ON lessons (concept_id, depth, created_at DESC, id DESC,
      workspace_id, snapshot_id, provider, document_revision) WHERE document_revision IS NOT '';
    CREATE INDEX lessons_selectable_by_scope ON lessons (concept_id, depth, workspace_id, snapshot_id,
      created_at DESC, id DESC, provider, document_revision) WHERE document_revision IS NOT '';
    CREATE TRIGGER lesson_document_changed AFTER UPDATE OF body, schema_version, id ON lessons
    WHEN NEW.body IS NOT OLD.body OR NEW.schema_version IS NOT OLD.schema_version OR NEW.id <> OLD.id
    BEGIN UPDATE lessons SET document_revision = NULL WHERE id = NEW.id; END;

    ALTER TABLE lesson_mastery ADD COLUMN check_attempts INTEGER;
    ALTER TABLE lesson_mastery ADD COLUMN check_streak INTEGER;
    CREATE INDEX mastery_progress ON lesson_mastery (workspace_id, depth, concept_id, lesson_id,
      scope, revision, check_attempts, check_streak) WHERE state IS NOT NULL;
    CREATE TRIGGER mastery_progress_insert AFTER INSERT ON lesson_mastery WHEN NEW.state IS NOT NULL
    BEGIN UPDATE lesson_mastery SET check_attempts = json_extract(NEW.state, '$.attempts'),
      check_streak = json_extract(NEW.state, '$.correctAnswers')
      WHERE workspace_id = NEW.workspace_id AND concept_id = NEW.concept_id AND depth = NEW.depth; END;
    CREATE TRIGGER mastery_progress_update AFTER UPDATE OF state ON lesson_mastery
    WHEN NEW.state IS NOT OLD.state
    BEGIN UPDATE lesson_mastery SET check_attempts = json_extract(NEW.state, '$.attempts'),
      check_streak = json_extract(NEW.state, '$.correctAnswers')
      WHERE workspace_id = NEW.workspace_id AND concept_id = NEW.concept_id AND depth = NEW.depth; END;
    CREATE INDEX snapshot_generations ON repository_generations (snapshot_id);
    CREATE INDEX workspace_baselines ON repository_generations (workspace_id, last_used DESC) WHERE kind = 'baseline';
    CREATE INDEX workspace_snapshots ON snapshots (workspace_id, created_at DESC, id DESC);`,
  },
  {
    version: 7,
    name: 'link duplicate repository concepts to portable identities',
    registerFunctions: registerPortableIdentity,
    sql: `CREATE TABLE concept_identity_links (
      legacy_concept_id INTEGER PRIMARY KEY REFERENCES concepts ON DELETE CASCADE,
      portable_concept_id INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      CHECK (legacy_concept_id <> portable_concept_id)
    );
    CREATE INDEX concept_identity_portable ON concept_identity_links (portable_concept_id);
    CREATE TABLE scoped_proposal_concepts (
      workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      concept_id INTEGER NOT NULL UNIQUE REFERENCES concepts ON DELETE CASCADE,
      PRIMARY KEY (workspace_id, fingerprint)
    );
    CREATE TABLE migrated_evidence_archive (
      id INTEGER PRIMARY KEY,
      original_evidence_id INTEGER NOT NULL,
      concept_id INTEGER NOT NULL,
      portable_concept_id INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      depth TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL,
      workspace_id TEXT, snapshot_id INTEGER, revision INTEGER NOT NULL,
      recorded_at TEXT NOT NULL, mastery_verified INTEGER NOT NULL
    );
    CREATE TEMP TABLE migration_candidates AS
    SELECT id, workspace_id, delve_portable_key(local_key, title) AS general_key,
      delve_portable_key(delve_normalized_concept(title), '') AS normalized_title,
      delve_normalized_concept(summary) AS normalized_summary
    FROM (SELECT c.*, substr(c.key, length('ws/' || c.workspace_id || '/') + 1) AS local_key
    FROM concepts c JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.portable = 0 AND w.kind <> 'topic' AND w.source NOT LIKE 'Demo:%'
      AND substr(c.key, 1, length('ws/' || c.workspace_id || '/')) = 'ws/' || c.workspace_id || '/'
      AND substr(c.key, length('ws/' || c.workspace_id || '/') + 1) <> ''
      AND substr(c.key, length('ws/' || c.workspace_id || '/') + 1) NOT LIKE 'change/%'
      AND substr(c.key, length('ws/' || c.workspace_id || '/') + 1) NOT LIKE 'Demo:%'
      AND c.title NOT LIKE 'Demo:%');
    CREATE INDEX migration_candidates_key ON migration_candidates(general_key, workspace_id);
    CREATE TEMP TABLE migration_portable AS
    SELECT id, delve_portable_key(key, title) AS general_key,
      delve_portable_key(delve_normalized_concept(title), '') AS normalized_title,
      delve_normalized_concept(summary) AS normalized_summary
    FROM concepts WHERE portable = 1 AND key NOT LIKE 'Demo:%';
    CREATE INDEX migration_portable_key ON migration_portable(general_key);
    CREATE INDEX migration_portable_title ON migration_portable(normalized_title, normalized_summary);
    CREATE TEMP TABLE migration_groups AS
    SELECT general_key, min(id) AS sample_id, min(normalized_title) AS normalized_title,
      count(DISTINCT workspace_id) AS workspace_count,
      CASE WHEN count(DISTINCT normalized_summary) = 1 AND min(normalized_summary) <> '' THEN min(normalized_summary) END AS shared_summary
    FROM migration_candidates WHERE general_key IS NOT NULL
    GROUP BY general_key HAVING count(DISTINCT normalized_title) = 1 AND count(DISTINCT workspace_id) = count(*);
    CREATE INDEX migration_groups_key ON migration_groups(general_key);
    ALTER TABLE migration_groups ADD COLUMN portable_id INTEGER;
    UPDATE migration_groups AS groups SET portable_id = (
      SELECT CASE WHEN count(*) = 1 AND groups.shared_summary IS NOT NULL
        AND delve_compatible_descriptions(min(p.normalized_summary), groups.shared_summary)
        THEN min(p.id) END
      FROM migration_portable p WHERE p.general_key = groups.general_key
    );
    CREATE TEMP TABLE migration_duplicate_memberships AS
    SELECT m.workspace_id, g.portable_id FROM migration_candidates m
    JOIN migration_groups g ON g.general_key = m.general_key
    WHERE g.portable_id IS NOT NULL
    GROUP BY m.workspace_id, g.portable_id HAVING count(*) > 1;
    CREATE INDEX migration_duplicate_memberships_id ON migration_duplicate_memberships(portable_id);
    DELETE FROM migration_groups WHERE portable_id IN (SELECT portable_id FROM migration_duplicate_memberships);
    DELETE FROM migration_groups WHERE shared_summary IS NULL OR (portable_id IS NULL AND (
      workspace_count < 2
      OR EXISTS (SELECT 1 FROM migration_portable p WHERE p.general_key = migration_groups.general_key)
      OR EXISTS (SELECT 1 FROM migration_portable p WHERE p.normalized_title = migration_groups.normalized_title)
      OR EXISTS (SELECT 1 FROM concepts c WHERE c.key = migration_groups.general_key)
    ));
    DROP TABLE migration_duplicate_memberships;
    INSERT INTO concepts (key, title, summary, portable, workspace_id, created_at, updated_at)
    SELECT g.general_key, c.title, c.summary, 1, NULL, c.created_at, c.updated_at
    FROM migration_groups g JOIN concepts c ON c.id = g.sample_id WHERE g.portable_id IS NULL;
    UPDATE migration_groups SET portable_id = (SELECT c.id FROM concepts c WHERE c.key = migration_groups.general_key) WHERE portable_id IS NULL;
    INSERT INTO concept_identity_links (legacy_concept_id, portable_concept_id)
    SELECT m.id, g.portable_id FROM migration_candidates m JOIN migration_groups g ON g.general_key = m.general_key;
    INSERT INTO workspace_concepts (workspace_id, concept_id, on_atlas)
    SELECT wc.workspace_id, l.portable_concept_id, max(wc.on_atlas)
    FROM workspace_concepts wc JOIN concept_identity_links l ON l.legacy_concept_id = wc.concept_id
    GROUP BY wc.workspace_id, l.portable_concept_id
    ON CONFLICT (workspace_id, concept_id) DO UPDATE SET on_atlas = max(on_atlas, excluded.on_atlas);
    INSERT INTO snapshot_concepts (snapshot_id, concept_id)
    SELECT DISTINCT sc.snapshot_id, l.portable_concept_id FROM snapshot_concepts sc
    JOIN concept_identity_links l ON l.legacy_concept_id = sc.concept_id
    WHERE true ON CONFLICT (snapshot_id, concept_id) DO NOTHING;
    UPDATE workspace_concepts SET on_atlas = 0 WHERE concept_id IN (SELECT legacy_concept_id FROM concept_identity_links);
    INSERT INTO migrated_evidence_archive (original_evidence_id, concept_id, portable_concept_id, depth, status,
      source, note, workspace_id, snapshot_id, revision, recorded_at, mastery_verified)
    SELECT e.id, e.concept_id, l.portable_concept_id, e.depth, e.status, e.source, e.note,
      e.workspace_id, e.snapshot_id, e.revision, e.recorded_at, e.mastery_verified
    FROM evidence e JOIN concept_identity_links l ON l.legacy_concept_id = e.concept_id
    UNION ALL
    SELECT e.id, e.concept_id, e.concept_id, e.depth, e.status, e.source, e.note,
      e.workspace_id, e.snapshot_id, e.revision, e.recorded_at, e.mastery_verified
    FROM evidence e WHERE e.concept_id IN (SELECT portable_concept_id FROM concept_identity_links);
    INSERT INTO evidence (concept_id, depth, status, source, note, workspace_id, snapshot_id, revision, recorded_at, mastery_verified)
    SELECT portable_concept_id, depth, status, source, note, workspace_id, snapshot_id, revision, recorded_at, mastery_verified
    FROM (SELECT *, row_number() OVER (PARTITION BY portable_concept_id, depth ORDER BY mastery_verified DESC,
      CASE status WHEN 'demonstrated' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END DESC,
      revision DESC, recorded_at DESC, original_evidence_id DESC) AS rank FROM migrated_evidence_archive)
    WHERE rank = 1
    ON CONFLICT (concept_id, depth) DO UPDATE SET status = excluded.status, source = excluded.source,
      note = excluded.note, workspace_id = excluded.workspace_id, snapshot_id = excluded.snapshot_id,
      revision = excluded.revision, recorded_at = excluded.recorded_at, mastery_verified = excluded.mastery_verified;
    DROP TABLE migration_candidates;
    DROP TABLE migration_portable;
    DROP TABLE migration_groups;`,
  },
  {
    version: 8,
    name: 'persist approved tutor requests',
    sql: `CREATE TABLE tutor_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      concept_id INTEGER NOT NULL,
      depth TEXT NOT NULL CHECK (depth IN ('high', 'medium', 'low')),
      token TEXT NOT NULL CHECK (length(token) = 64),
      detail TEXT NOT NULL CHECK (json_valid(detail)),
      phase TEXT NOT NULL CHECK (phase IN ('running', 'ready', 'failed')),
      code TEXT,
      message TEXT,
      CHECK ((phase = 'failed' AND code IS NOT NULL AND message IS NOT NULL)
        OR (phase <> 'failed' AND code IS NULL AND message IS NULL)),
      UNIQUE (workspace_id, concept_id, depth),
      FOREIGN KEY (workspace_id, concept_id) REFERENCES workspace_concepts ON DELETE CASCADE
    );`,
  },
  {
    version: 9,
    name: 'version saved tutor jobs',
    sql: `ALTER TABLE tutor_jobs ADD COLUMN version TEXT NOT NULL DEFAULT '';
    UPDATE tutor_jobs SET version = lower(hex(randomblob(16)));
    CREATE TRIGGER tutor_jobs_version_insert AFTER INSERT ON tutor_jobs BEGIN
      UPDATE tutor_jobs SET version = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
    END;
    CREATE TRIGGER tutor_jobs_version_update
      AFTER UPDATE OF id, workspace_id, concept_id, depth, token, detail, phase, code, message ON tutor_jobs BEGIN
      UPDATE tutor_jobs SET version = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
    END;`,
  },
  {
    version: 10,
    name: 'save foundations, change identities, and per-lesson progress',
    sql: `ALTER TABLE evidence ADD COLUMN probe_answered INTEGER NOT NULL DEFAULT 0 CHECK (probe_answered IN (0, 1));
    CREATE TABLE lesson_foundations (
      lesson_id INTEGER PRIMARY KEY REFERENCES lessons ON DELETE CASCADE,
      entries TEXT NOT NULL CHECK (json_valid(entries)),
      phase TEXT NOT NULL CHECK (phase IN ('probe', 'practice', 'done')),
      cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor BETWEEN 0 AND 4)
    );
    ALTER TABLE concept_identity_links RENAME COLUMN portable_concept_id TO canonical_concept_id;
    CREATE TABLE change_concept_keys (
      workspace_id TEXT NOT NULL REFERENCES workspaces ON DELETE CASCADE,
      change_id TEXT NOT NULL CHECK (length(change_id) = 64),
      identity TEXT NOT NULL CHECK (length(identity) > 0),
      summary TEXT NOT NULL,
      concept_id INTEGER NOT NULL REFERENCES concepts ON DELETE CASCADE,
      PRIMARY KEY (workspace_id, change_id, identity, concept_id)
    );
    CREATE INDEX change_concept_keys_concept ON change_concept_keys (concept_id);
    UPDATE repository_generations AS g SET result = json_set(g.result, '$.brief.lessonId', l.id)
    FROM lessons l WHERE g.kind <> 'baseline' AND l.cache_key = g.cache_key
      AND l.workspace_id = g.workspace_id AND l.snapshot_id = g.snapshot_id AND l.depth = g.depth
      AND l.provider = g.provider AND l.model = g.model AND l.schema_version = 'delve.lesson/1'
      AND l.concept_id = g.result ->> '$.brief.conceptId';
    ALTER TABLE messages ADD COLUMN pinned_lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL;
    CREATE INDEX messages_by_pinned_lesson ON messages(pinned_lesson_id);
    UPDATE messages AS m SET pinned_lesson_id = l.id
    FROM conversations c JOIN lessons l ON l.id = c.lesson_id
    JOIN repository_generations g ON g.cache_key = l.cache_key
    WHERE m.conversation_id = c.id AND g.kind <> 'baseline' AND g.result ->> '$.brief.lessonId' = l.id
      AND c.workspace_id = l.workspace_id AND c.concept_id = l.concept_id
      AND (c.depth IS NULL OR c.depth = l.depth)
      AND NOT EXISTS (SELECT 1 FROM lessons other WHERE other.concept_id = l.concept_id AND other.depth = l.depth
        AND other.id <> l.id AND (other.workspace_id = l.workspace_id OR other.workspace_id IS NULL));
    ALTER TABLE lesson_mastery RENAME TO previous_lesson_mastery;
    CREATE TABLE lesson_mastery (
      workspace_id TEXT NOT NULL,
      concept_id INTEGER NOT NULL,
      depth TEXT NOT NULL CHECK (depth IN ('high', 'medium', 'low')),
      lesson_id INTEGER REFERENCES lessons ON DELETE CASCADE,
      scope TEXT NOT NULL,
      revision TEXT NOT NULL,
      state TEXT CHECK (json_valid(state)),
      check_attempts INTEGER GENERATED ALWAYS AS (json_extract(state, '$.attempts')),
      check_streak INTEGER GENERATED ALWAYS AS (json_extract(state, '$.correctAnswers')),
      FOREIGN KEY (workspace_id, concept_id) REFERENCES workspace_concepts ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX mastery_lesson ON lesson_mastery(workspace_id, concept_id, depth, coalesce(lesson_id, 0));
    CREATE INDEX mastery_by_lesson ON lesson_mastery(lesson_id) WHERE lesson_id IS NOT NULL;
    INSERT INTO lesson_mastery (workspace_id, concept_id, depth, lesson_id, scope, revision, state)
      SELECT workspace_id, concept_id, depth, lesson_id, scope, revision, state FROM previous_lesson_mastery;
    DROP TABLE previous_lesson_mastery;
    CREATE INDEX mastery_progress ON lesson_mastery(workspace_id, depth, concept_id, lesson_id,
      scope, revision, check_attempts, check_streak) WHERE state IS NOT NULL;`,
    afterSql: indexSavedChanges,
  },
];

function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    assert.equal(migration.version, index + 1, `migration ${migration.name} must have version ${index + 1}`);
    assert.ok(migration.sql.trim().length > 0, `migration ${migration.version} is empty`);
  });
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  assert.ok(row && Number.isInteger(row.user_version), 'PRAGMA user_version returned no integer');
  return row.user_version;
}

/** Applies every pending migration, each in its own transaction. Returns the final version. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  assertOrdered(migrations);
  const current = schemaVersion(db);
  const latest = migrations.length;
  if (current > latest) {
    throw new Error(`Database schema version ${current} is newer than this build supports (${latest}). Update Delve.`);
  }
  for (const migration of migrations.slice(current)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.registerFunctions?.(db);
      db.exec(migration.sql);
      migration.afterSql?.(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
  const final = schemaVersion(db);
  assert.equal(final, latest, 'schema version after migration must equal the latest migration');
  return final;
}
