import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection';
import { MIGRATIONS, migrate, schemaVersion } from './migrations';
import { addWorkspace, listWorkspaces, resolveWorkspaceSource, switchWorkspace } from './workspaces';

const open: Db[] = [];
function memoryDb(): Db {
  const db = openDatabase(':memory:');
  open.push(db);
  return db;
}

afterEach(() => {
  open.splice(0).forEach((db) => db.close());
});

describe('migrations', () => {
  it('migrates a new database to the latest version and is idempotent', () => {
    const db = memoryDb();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
  });

  it('links existing portable evidence to its recording workspace on upgrade', () => {
    const db = new DatabaseSync(':memory:');
    open.push(db);
    migrate(db, MIGRATIONS.slice(0, 1));
    const workspace = addWorkspace(db, { kind: 'topic', title: 'Photography' });
    db.prepare(`INSERT INTO concepts (id, key, title, portable, created_at, updated_at)
      VALUES (1, 'focus', 'Focus', 1, 'then', 'then')`).run();
    db.prepare(`INSERT INTO evidence (concept_id, depth, status, source, recorded_at, workspace_id)
      VALUES (1, 'medium', 'partial', 'self-report', 'then', ?)`).run(workspace.id);
    migrate(db);
    expect(db.prepare('SELECT workspace_id, concept_id FROM workspace_concepts').all())
      .toEqual([{ workspace_id: workspace.id, concept_id: 1 }]);
    expect(db.prepare('SELECT status, revision FROM evidence').get()).toEqual({ status: 'partial', revision: 1 });
  });

  it('refuses a database from a newer build', () => {
    const db = memoryDb();
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });

  it('rolls back a failing migration', () => {
    const db = memoryDb();
    const broken = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'broken', sql: 'CREATE TABLE ok (x); NOT SQL' }];
    expect(() => migrate(db, broken)).toThrow(`Migration ${MIGRATIONS.length + 1} (broken) failed`);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
  });
});

describe('workspaces', () => {
  it('validates and normalizes each kind of source', () => {
    expect(resolveWorkspaceSource({ kind: 'github', owner: ' Mengsig ', repo: 'Delve.git' })).toEqual({
      kind: 'github',
      name: 'Mengsig/Delve',
      source: 'mengsig/delve',
    });
    expect(resolveWorkspaceSource({ kind: 'topic', title: '  Chess   openings ' }).name).toBe('Chess openings');
    const repoPath = resolve('home', 'me', 'code', 'app');
    expect(resolveWorkspaceSource({ kind: 'git', path: repoPath + sep })).toMatchObject({ name: 'app', source: repoPath });
    expect(() => resolveWorkspaceSource({ kind: 'git', path: 'relative/dir' })).toThrow(/absolute path/);
    expect(() => resolveWorkspaceSource({ kind: 'github', owner: '-bad', repo: 'x' })).toThrow(/owner/);
    expect(() => resolveWorkspaceSource({ kind: 'github', owner: 'ok', repo: '..' })).toThrow(/repository name/);
    expect(() => resolveWorkspaceSource({ kind: 'topic', title: '   ' })).toThrow(/Name the topic/);
  });

  it('adds workspaces of every kind, makes the newest active and rejects duplicates', () => {
    const db = memoryDb();
    const repo = addWorkspace(db, { kind: 'git', path: '/srv/repo' });
    const gh = addWorkspace(db, { kind: 'github', owner: 'octo', repo: 'site' });
    const topic = addWorkspace(db, { kind: 'topic', title: 'Photography' });
    const list = listWorkspaces(db);
    expect(list.workspaces.map((w) => w.id).sort()).toEqual([repo.id, gh.id, topic.id].sort());
    expect(list.activeId).toBe(topic.id);
    expect(() => addWorkspace(db, { kind: 'github', owner: 'OCTO', repo: 'Site' })).toThrow(/already in your workspaces/);
  });

  it('switches the active workspace and rejects unknown ids', () => {
    const db = memoryDb();
    const first = addWorkspace(db, { kind: 'topic', title: 'Chess' });
    addWorkspace(db, { kind: 'topic', title: 'Networks' });
    const list = switchWorkspace(db, first.id);
    expect(list.activeId).toBe(first.id);
    expect(() => switchWorkspace(db, 'missing')).toThrow(/no longer exists/);
    expect(listWorkspaces(db).activeId).toBe(first.id);
  });

  it('persists workspaces and the active choice across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-db-'));
    try {
      const file = join(dir, 'nested', 'delve.sqlite');
      const db = openDatabase(file);
      const a = addWorkspace(db, { kind: 'topic', title: 'A' });
      addWorkspace(db, { kind: 'topic', title: 'B' });
      switchWorkspace(db, a.id);
      db.close();
      const reopened = openDatabase(file);
      const list = listWorkspaces(reopened);
      reopened.close();
      expect(list.workspaces).toHaveLength(2);
      expect(list.activeId).toBe(a.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects relative database paths', () => {
    expect(() => openDatabase('delve.sqlite')).toThrow(/absolute/);
  });
});
