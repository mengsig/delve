import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../shared/errors';
import { IPC_CHANNELS } from '../shared/ipc';
import { upsertConcept } from './db/concepts';
import { openDatabase } from './db/connection';
import { recordEvidence } from './db/evidence';
import { addWorkspace } from './db/workspaces';
import { graphHandlers } from './graph-ipc';
import { dispatch, registerIpc, type IpcHandlers, type IpcRegistrar } from './ipc';

const workspace = { id: '0b0f5f56-1d3c-4a5e-9a51-3c8f4c2f3e10', kind: 'topic', name: 'Chess', source: 'chess', createdAt: 'now', lastOpenedAt: null } as const;

function unexpected(): never { throw new Error('Unexpected repository request'); }

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    'workspaces:list': () => ({ workspaces: [workspace], activeId: workspace.id }),
    'workspaces:add': () => workspace,
    'workspaces:switch': () => ({ workspaces: [workspace], activeId: workspace.id }),
    'workspaces:pick-folder': () => null,
    'providers:detect': () => [],
    'tutor:preview-topic': () => { throw new Error('Unexpected topic preview'); },
    'tutor:preview': () => { throw new Error('Unexpected tutor preview'); },
    'tutor:run': () => { throw new Error('Unexpected tutor turn'); },
    'tutor:cancel': () => false,
    'reader:start-topic': () => { throw new Error('Unexpected topic request'); },
    'reader:lesson': () => { throw new Error('Unexpected lesson request'); },
    'reader:message': () => { throw new Error('Unexpected message request'); },
    'reader:answer': () => { throw new Error('Unexpected answer request'); },
    'graph:read': ({ workspaceId }) => ({ workspaceId, concepts: [], edges: [], evidence: [], snapshot: null, demo: false }),
    'progress:read': () => [],
    'evidence:reset': () => false,
    'lab:open': () => { throw new Error('Unexpected activity'); },
    'lab:input': () => { throw new Error('Unexpected activity input'); },
    'lab:close': () => false,
    'repo:stage': unexpected, 'repo:attach': unexpected, 'repo:files': unexpected, 'repo:preview': unexpected, 'repo:generate': unexpected, 'repo:cancel': unexpected,
    'repo:changes': unexpected, 'repo:history': unexpected, 'repo:detail': unexpected, 'repo:saved': unexpected, 'learn:pending': unexpected, 'learn:resolve': unexpected,
    ...overrides,
  };
}

describe('dispatch', () => {
  it('validates requests before reaching the handler', async () => {
    const add = vi.fn(() => workspace);
    const h = handlers({ 'workspaces:add': add });
    expect(await dispatch(h, 'workspaces:add', { kind: 'topic', title: 'Chess' })).toEqual({ ok: true, value: workspace });
    const bad = await dispatch(h, 'workspaces:add', { kind: 'shell', command: 'rm -rf /' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    const extra = await dispatch(h, 'workspaces:add', { kind: 'topic', title: 'x', path: '/etc' });
    expect(extra).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await dispatch(h, 'workspaces:switch', { id: 'not-a-uuid' })).toMatchObject({ ok: false });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('returns domain errors as-is and hides internal ones', async () => {
    const domain = handlers({ 'workspaces:list': () => { throw new DomainError('NOPE', 'Visible reason.'); } });
    expect(await dispatch(domain, 'workspaces:list', null)).toEqual({ ok: false, error: { code: 'NOPE', message: 'Visible reason.' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const internal = handlers({ 'workspaces:list': () => { throw new Error('secret /home/path'); } });
    const result = await dispatch(internal, 'workspaces:list', null);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe('explorer IPC', () => {
  it('rejects malformed history filters, cursors and detail refs', async () => {
    const history = vi.fn<IpcHandlers['repo:history']>();
    const detail = vi.fn<IpcHandlers['repo:detail']>();
    const h = handlers({ 'repo:history': history, 'repo:detail': detail });
    const workspaceId = workspace.id;
    const invalid = { ok: false, error: { code: 'INVALID_REQUEST' } };
    for (const cursor of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
      expect(await dispatch(h, 'repo:history', { workspaceId, cursor })).toMatchObject(invalid);
    }
    expect(await dispatch(h, 'repo:history', { workspaceId, cursor: 0, branch: 'main\0other' })).toMatchObject(invalid);
    expect(await dispatch(h, 'repo:history', { workspaceId, cursor: 0, kind: 'anything' })).toMatchObject(invalid);
    expect(await dispatch(h, 'repo:history', { workspaceId, cursor: 0, search: '   ' })).toMatchObject(invalid);
    expect(await dispatch(h, 'repo:history', { workspaceId, cursor: 4, refreshSnapshot: true })).toMatchObject(invalid);
    expect(await dispatch(h, 'repo:detail', { workspaceId, kind: 'commit', ref: 'HEAD~1' })).toMatchObject(invalid);
    expect(await dispatch(h, 'repo:detail', { workspaceId, kind: 'pr', ref: '0' })).toMatchObject(invalid);
    expect(history).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });
});

describe('graph IPC', () => {
  it('validates graph, coverage and evidence reset requests before dispatch', async () => {
    const read = vi.fn<IpcHandlers['graph:read']>();
    const reset = vi.fn<IpcHandlers['evidence:reset']>();
    const coverage = vi.fn<IpcHandlers['progress:read']>();
    const h = handlers({ 'graph:read': read, 'evidence:reset': reset, 'progress:read': coverage });
    const invalid = { ok: false, error: { code: 'INVALID_REQUEST' } };
    expect(await dispatch(h, 'graph:read', { workspaceId: 'invalid' })).toMatchObject(invalid);
    expect(await dispatch(h, 'graph:read', { workspaceId: workspace.id, source: 'anything' })).toMatchObject(invalid);
    expect(await dispatch(h, 'progress:read', { workspaceId: workspace.id })).toMatchObject(invalid);
    for (const conceptId of [0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(await dispatch(h, 'evidence:reset', { workspaceId: workspace.id, conceptId, depth: 'medium' })).toMatchObject(invalid);
    }
    expect(await dispatch(h, 'evidence:reset', { workspaceId: workspace.id, conceptId: 1, depth: 'other' })).toMatchObject(invalid);
    expect(await dispatch(h, 'evidence:reset', { workspaceId: workspace.id, conceptId: 1, depth: 'high', all: true })).toMatchObject(invalid);
    expect(read).not.toHaveBeenCalled();
    expect(coverage).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('reads coverage and resets only exact evidence owned by the requesting workspace', async () => {
    const db = openDatabase(':memory:');
    try {
      const origin = addWorkspace(db, { kind: 'topic', title: 'Origin' });
      const linked = addWorkspace(db, { kind: 'topic', title: 'Linked' });
      const input = { key: 'queue', title: 'Queue', portable: true };
      const concept = upsertConcept(db, { ...input, workspaceId: origin.id });
      upsertConcept(db, { ...input, workspaceId: linked.id });
      recordEvidence(db, { conceptId: concept.id, depth: 'medium', status: 'demonstrated', source: 'check', workspaceId: origin.id });
      const h = handlers(graphHandlers(db));
      expect(await dispatch(h, 'progress:read', null)).toEqual({
        ok: true,
        value: [origin, linked].map(({ id }) => ({ workspaceId: id, total: 1, known: { high: 0, medium: 1, low: 0 } })),
      });
      const reset = { workspaceId: origin.id, conceptId: concept.id, depth: 'medium' };
      expect(await dispatch(h, 'evidence:reset', { ...reset, workspaceId: linked.id })).toMatchObject({
        ok: false, error: { code: 'SCOPE_MISMATCH' },
      });
      expect(await dispatch(h, 'graph:read', { workspaceId: linked.id })).toMatchObject({
        ok: true, value: { evidence: [{ workspaceId: origin.id, workspaceName: 'Origin' }] },
      });
      expect(await dispatch(h, 'evidence:reset', reset)).toEqual({ ok: true, value: true });
      expect(await dispatch(h, 'evidence:reset', reset)).toEqual({ ok: true, value: false });
      expect(await dispatch(h, 'graph:read', { workspaceId: linked.id })).toMatchObject({ ok: true, value: { evidence: [] } });
      expect(await dispatch(h, 'graph:read', { workspaceId: workspace.id })).toMatchObject({
        ok: false, error: { code: 'WORKSPACE_NOT_FOUND' },
      });
    } finally {
      db.close();
    }
  });
});

describe('registerIpc', () => {
  it('registers every channel and refuses untrusted frames', async () => {
    const listeners = new Map<string, Parameters<IpcRegistrar['handle']>[1]>();
    registerIpc({ handle: (channel, listener) => listeners.set(channel, listener) }, handlers(), (url) => url.startsWith('app://delve/'));
    expect([...listeners.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    const list = listeners.get('workspaces:list')!;
    expect(await list({ senderFrame: { url: 'app://delve/index.html', parent: null } }, null)).toMatchObject({ ok: true });
    expect(await list({ senderFrame: { url: 'https://evil.example/', parent: null } }, null)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await list({ senderFrame: { url: 'app://delve/index.html', parent: {} } }, null)).toMatchObject({ ok: false });
    expect(await list({ senderFrame: { url: 'app://instrument/stage', parent: {} } }, null)).toMatchObject({ ok: false });
    expect(await list({ senderFrame: null }, null)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
