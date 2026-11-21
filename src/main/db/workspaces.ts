import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, normalize } from 'node:path';
import { WORKSPACE_KINDS, type AddWorkspaceInput, type Workspace, type WorkspaceKind, type WorkspaceList } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import { matchesDemo } from './demo-fixtures';
import { nowIso, transaction, type Db } from './connection';

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_TOPIC_LENGTH = 120;
export const ACTIVE_WORKSPACE_KEY = 'active_workspace_id';

interface WorkspaceRow {
  id: string;
  kind: string;
  name: string;
  source: string;
  created_at: string;
  last_opened_at: string | null;
}

interface ResolvedSource {
  kind: WorkspaceKind;
  name: string;
  source: string;
}

function invalid(message: string): DomainError {
  return new DomainError('INVALID_WORKSPACE', message);
}

/** Validates the user's input and derives the stored name and canonical source. */
export function resolveWorkspaceSource(input: AddWorkspaceInput): ResolvedSource {
  switch (input.kind) {
    case 'git': {
      const path = input.path.trim();
      if (!isAbsolute(path)) throw invalid('Choose a repository folder (an absolute path).');
      const source = normalize(path).replace(/[\\/]+$/, '') || normalize(path);
      return { kind: 'git', name: basename(source) || source, source };
    }
    case 'github': {
      const owner = input.owner.trim();
      const repo = input.repo.trim().replace(/\.git$/, '');
      if (!GITHUB_OWNER.test(owner)) throw invalid(`"${owner}" is not a valid GitHub owner.`);
      if (!GITHUB_REPO.test(repo) || repo === '.' || repo === '..') throw invalid(`"${repo}" is not a valid repository name.`);
      return { kind: 'github', name: `${owner}/${repo}`, source: `${owner}/${repo}`.toLowerCase() };
    }
    case 'topic': {
      const title = input.title.trim().replace(/\s+/g, ' ');
      if (title.length === 0) throw invalid('Name the topic you want to learn.');
      if (title.length > MAX_TOPIC_LENGTH) throw invalid(`Keep the topic under ${MAX_TOPIC_LENGTH} characters.`);
      return { kind: 'topic', name: title, source: title.toLowerCase() };
    }
  }
}

function toWorkspace(row: WorkspaceRow): Workspace {
  assert.ok((WORKSPACE_KINDS as readonly string[]).includes(row.kind), `unknown workspace kind ${row.kind}`);
  assert.ok(row.id.length > 0 && row.source.length > 0, 'workspace row is missing id or source');
  return {
    id: row.id,
    kind: row.kind as WorkspaceKind,
    name: row.name,
    source: row.source,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export function getWorkspace(db: Db, id: string): Workspace | null {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  return row ? toWorkspace(row) : null;
}

/** Adds a workspace and makes it active. Adding the same source twice is rejected. */
export function addWorkspace(db: Db, input: AddWorkspaceInput): Workspace {
  const resolved = resolveWorkspaceSource(input);
  return transaction(db, () => {
    const existing = db
      .prepare('SELECT name FROM workspaces WHERE kind = ? AND source = ?')
      .get(resolved.kind, resolved.source) as { name: string } | undefined;
    if (existing) throw new DomainError('DUPLICATE_WORKSPACE', `"${existing.name}" is already in your workspaces.`);
    const id = randomUUID();
    const now = nowIso();
    db.prepare('INSERT INTO workspaces (id, kind, name, source, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      resolved.kind,
      resolved.name,
      resolved.source,
      now,
      now,
    );
    setActive(db, id);
    const created = getWorkspace(db, id);
    assert.ok(created, 'inserted workspace must be readable');
    return created;
  });
}

function setActive(db: Db, id: string): void {
  db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    ACTIVE_WORKSPACE_KEY,
    id,
  );
}

/** Most recently opened first. The active id is null when nothing is selected or it was deleted. */
export function listWorkspaces(db: Db): WorkspaceList {
  const rows = db
    .prepare('SELECT * FROM workspaces ORDER BY last_opened_at IS NULL, last_opened_at DESC, rowid DESC')
    .all() as unknown as WorkspaceRow[];
  const workspaces = rows.map(toWorkspace);
  const active = db.prepare('SELECT value FROM app_state WHERE key = ?').get(ACTIVE_WORKSPACE_KEY) as { value: string } | undefined;
  const activeId = active && workspaces.some((w) => w.id === active.value) ? active.value : null;
  return { workspaces, activeId, hasUserWorkspace: workspaces.some(workspace => !matchesDemo(workspace)) };
}

export function isActiveWorkspace(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM app_state WHERE key = ? AND value = ?').get(ACTIVE_WORKSPACE_KEY, id) !== undefined;
}

export function switchWorkspace(db: Db, id: string): WorkspaceList {
  transaction(db, () => {
    const result = db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(nowIso(), id);
    if (result.changes === 0) throw new DomainError('WORKSPACE_NOT_FOUND', 'That workspace no longer exists.');
    assert.equal(result.changes, 1, 'workspace ids are unique');
    setActive(db, id);
  });
  const list = listWorkspaces(db);
  assert.equal(list.activeId, id, 'switched workspace must be active');
  return list;
}
