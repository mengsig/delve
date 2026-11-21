import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
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
      db.exec(migration.sql);
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
