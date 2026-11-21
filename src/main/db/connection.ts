import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations';

export type Db = DatabaseSync;

/** Opens (creating if needed) and migrates the database. `:memory:` is allowed for tests. */
export function openDatabase(file: string): Db {
  assert.ok(file === ':memory:' || isAbsolute(file), `database path must be absolute, got ${file}`);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  assert.equal(fk?.foreign_keys, 1, 'foreign keys must be enforced');
  migrate(db);
  return db;
}

/** Runs `work` in one IMMEDIATE transaction; rolls back and rethrows on failure. */
export function transaction<T>(db: Db, work: () => T): T {
  assert.ok(!db.isTransaction, 'nested transactions are not supported');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
