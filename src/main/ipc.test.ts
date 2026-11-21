import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../shared/errors';
import { IPC_CHANNELS } from '../shared/ipc';
import { dispatch, registerIpc, type IpcHandlers, type IpcRegistrar } from './ipc';

const workspace = { id: '0b0f5f56-1d3c-4a5e-9a51-3c8f4c2f3e10', kind: 'topic', name: 'Chess', source: 'chess', createdAt: 'now', lastOpenedAt: null } as const;

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    'workspaces:list': () => ({ workspaces: [workspace], activeId: workspace.id }),
    'workspaces:add': () => workspace,
    'workspaces:switch': () => ({ workspaces: [workspace], activeId: workspace.id }),
    'workspaces:pick-folder': () => null,
    'providers:detect': () => [],
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

describe('registerIpc', () => {
  it('registers every channel and refuses untrusted frames', async () => {
    const listeners = new Map<string, Parameters<IpcRegistrar['handle']>[1]>();
    registerIpc({ handle: (channel, listener) => listeners.set(channel, listener) }, handlers(), (url) => url.startsWith('app://delve/'));
    expect([...listeners.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
    const list = listeners.get('workspaces:list')!;
    expect(await list({ senderFrame: { url: 'app://delve/index.html' } }, null)).toMatchObject({ ok: true });
    expect(await list({ senderFrame: { url: 'https://evil.example/' } }, null)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await list({ senderFrame: null }, null)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
