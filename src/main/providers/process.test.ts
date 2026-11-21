import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCaptured } from './process';

function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait so both children exit before libuv next reaps; it then reaps them in one batch.
  }
}

describe('runCaptured process identity', () => {
  afterEach(() => vi.restoreAllMocks());

  // libuv reaps every exited child before dispatching any exit callback, so in the first callback a
  // later child is already reaped yet still looks running. Cancelling it there must signal nothing.
  it.skipIf(process.platform === 'win32')('never signals a CLI reaped in the same batch as another child', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();
    const other = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    other.on('exit', () => controller.abort());
    const run = runCaptured({
      provider: 'claude', bin: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: { ...process.env },
      stdin: 'go', timeoutMs: 10_000, maxBytes: 1024 * 1024, signal: controller.signal, killGraceMs: 200,
    });
    blockEventLoop(1_500);
    await expect(run).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(controller.signal.aborted).toBe(true);
    expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
  }, 10_000);
});
