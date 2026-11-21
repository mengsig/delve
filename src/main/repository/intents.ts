import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workspace } from '../../shared/domain';
import { DomainError } from '../../shared/errors';
import type { LearnIntent } from '../../shared/repository';
import type { Db } from '../db/connection';
import { isDemoWorkspace } from '../db/demo';
import { addWorkspace, getWorkspace, listWorkspaces, resolveWorkspaceSource, switchWorkspace } from '../db/workspaces';
import { commitRef, prRef } from './schemas';

function invalidLink() { return new DomainError('INVALID_LINK', 'Expected a workspace and one commit, PR number, or proposed-work reference.'); }

export function parseIntent(link: string): LearnIntent {
  if (link.length > 2048 || !URL.canParse(link)) throw invalidLink();
  const url = new URL(link);
  if (url.protocol !== 'delve:' || url.host !== 'learn' || url.password || url.username || url.hash || !['', '/'].includes(url.pathname)) throw invalidLink();
  const params = url.searchParams;
  const workspace = params.get('workspace');
  const kind = (['commit', 'pr', 'proposed'] as const).find(key => params.has(key));
  if (!workspace || !kind || params.size !== 2) throw invalidLink();
  const ref = params.get(kind) ?? '';
  if (!z.uuid().safeParse(workspace).success) {
    const parts = workspace.split('/');
    if (parts.length !== 2) throw invalidLink();
    const canonical = resolveWorkspaceSource({ kind: 'github', owner: parts[0]!, repo: parts[1]! });
    if (workspace.toLowerCase() !== canonical.source) throw invalidLink();
  }
  if (kind === 'commit' && !commitRef.safeParse(ref).success) throw invalidLink();
  if (kind === 'pr' && !prRef.safeParse(ref).success) throw invalidLink();
  if (kind === 'proposed' && !/^[\p{L}\p{N}._:/@+-]{1,200}$/u.test(ref)) throw invalidLink();
  return { id: randomUUID(), workspace, kind, ref };
}

function importWorkspace(db: Db, intent: LearnIntent): Workspace {
  const name = intent.workspace.toLowerCase();
  const existing = getWorkspace(db, name) ?? listWorkspaces(db).workspaces.find(w => w.kind === 'github' && w.source === name);
  if (existing) {
    if (existing.kind === 'topic' || isDemoWorkspace(db, existing.id)) throw new DomainError('INVALID_LINK', 'Choose a repository workspace for this link.');
    switchWorkspace(db, existing.id);
    return existing;
  }
  const [owner, repo] = name.split('/');
  if (!owner || !repo) throw new DomainError('WORKSPACE_NOT_FOUND', 'The linked workspace is not on this device.');
  return addWorkspace(db, { kind: 'github', owner, repo });
}

export class LearnInbox {
  private readonly pending: LearnIntent[] = [];

  receive(link: string): void {
    const intent = parseIntent(link);
    if (this.pending.length >= 16) throw new DomainError('INBOX_FULL', 'Review the pending learn links before opening another.');
    this.pending.push(intent);
  }

  peek(): LearnIntent | null { return this.pending[0] ?? null; }

  preview(db: Db): LearnIntent | null {
    const intent = this.peek();
    if (!intent) return null;
    const workspace = getWorkspace(db, intent.workspace.toLowerCase());
    return workspace ? { ...intent, name: workspace.name, source: workspace.source } : intent;
  }

  resolve(db: Db, id: string, accept: boolean): Workspace | null {
    const intent = this.peek();
    if (!intent || intent.id !== id) throw new DomainError('STALE_LINK', 'That learn link has already been handled.');
    const workspace = accept ? importWorkspace(db, intent) : null;
    assert.equal(this.pending.shift(), intent);
    assert.equal(workspace !== null, accept);
    return workspace;
  }
}
