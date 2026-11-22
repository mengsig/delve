import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ on: vi.fn(), quit: vi.fn(), exit: vi.fn() }));
vi.mock('electron', () => ({ app }));

import { installShutdown } from './shutdown';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, 'on').mockImplementation(() => process);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function beforeQuit() {
  const handler = app.on.mock.calls.find(([event]) => event === 'before-quit')?.[1];
  expect(handler).toBeTypeOf('function');
  const event = { preventDefault: vi.fn() };
  handler(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
}

describe('shutdown', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      it(`quits on ${signal} on ${platform}`, () => {
        vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
        installShutdown();
        const handler = vi.mocked(process.on).mock.calls.find(([name]) => name === signal)?.[1];
        expect(handler).toBeTypeOf('function');
        (handler as () => void)();
        expect(app.quit).toHaveBeenCalledOnce();
      });
    }
  }

  it('leaves signal handling to Windows', () => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
    installShutdown();
    expect(process.on).not.toHaveBeenCalledWith('SIGTERM', expect.anything());
    expect(process.on).not.toHaveBeenCalledWith('SIGINT', expect.anything());
  });

  it('quits when no cleanup was installed', async () => {
    const shutdown = installShutdown();
    beforeQuit();
    await vi.runAllTimersAsync();
    expect(shutdown.signal.aborted).toBe(true);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it('aborts and drains once before quitting', async () => {
    const shutdown = installShutdown();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    shutdown.setCleanup(cleanup);
    beforeQuit();
    beforeQuit();
    expect(shutdown.signal.aborted).toBe(true);
    await vi.runAllTimersAsync();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it('logs and exits nonzero when cleanup rejects', async () => {
    const shutdown = installShutdown();
    const failure = new Error('cleanup failed');
    shutdown.setCleanup(() => Promise.reject(failure));
    beforeQuit();
    await vi.runAllTimersAsync();
    expect(console.error).toHaveBeenCalledWith('[delve] shutdown failed', failure);
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('logs and exits nonzero when cleanup never settles', async () => {
    const shutdown = installShutdown();
    shutdown.setCleanup(() => new Promise(() => undefined));
    beforeQuit();
    await vi.runAllTimersAsync();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cleanup exceeded'));
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('preserves a requested nonzero exit code after draining', async () => {
    const shutdown = installShutdown();
    shutdown.quit(2);
    beforeQuit();
    await vi.runAllTimersAsync();
    expect(app.exit).toHaveBeenCalledWith(2);
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
