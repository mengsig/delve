import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectProviders } from './detect';
import { runCaptured } from './process';
import { FAKE_SCRIPT, makeShimDir, makeTempDir, request, setupRunner } from './test-helpers';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}

describe.skipIf(process.platform === 'win32')('ProviderRunner shared-run cancellation', () => {
  let binDir: string;
  beforeAll(async () => {
    binDir = await makeShimDir();
  });
  const temp = async (name: string): Promise<string> => path.join(await makeTempDir(name), name);

  it('lets one de-duplicated caller cancel without affecting the other', async () => {
    const counter = await temp('cnt');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_DELAY_MS: '600', FAKE_PROVIDER_COUNTER: counter });
    const quitter = new AbortController();
    const kept = runner.run(request());
    const cancelled = runner.run(request({ signal: quitter.signal }));
    setTimeout(() => quitter.abort(), 100);
    await expect(cancelled).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await expect(kept).resolves.toMatchObject({ value: { answer: '42' } });
    expect(await readFile(counter, 'utf8')).toBe('1');
  });

  it('rejects an already-aborted caller at once and stops the run when every caller cancels', async () => {
    const counter = await temp('cnt');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'hang', FAKE_PROVIDER_COUNTER: counter });
    const first = new AbortController();
    const running = runner.run(request({ signal: first.signal, timeoutMs: 30_000 }));
    await expect(runner.run(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    setTimeout(() => first.abort(), 200);
    await expect(running).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(runner.cancel('k1')).toBe(false);
  }, 10_000);

});

describe.skipIf(process.platform === 'win32')('ProviderRunner process tree and auth', () => {
  let binDir: string;
  beforeAll(async () => {
    binDir = await makeShimDir();
  });
  const temp = async (name: string): Promise<string> => path.join(await makeTempDir(name), name);

  it('settles and reaps a descendant that keeps the output pipes open after the CLI exits', async () => {
    const pidFile = await temp('pid');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'orphan', FAKE_PROVIDER_CHILD_PID: pidFile });
    const started = Date.now();
    await expect(runner.run(request())).resolves.toMatchObject({ value: { answer: '42' } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitUntilDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 10_000);

  it('kills the whole process tree on timeout', async () => {
    const pidFile = await temp('pid');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'orphan-hang', FAKE_PROVIDER_CHILD_PID: pidFile });
    await expect(runner.run(request({ timeoutMs: 300 }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(existsSync(pidFile)).toBe(true);
    expect(await waitUntilDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
  }, 10_000);

  it('stops a CLI that floods output and ignores SIGTERM, within the kill grace', async () => {
    const started = Date.now();
    const run = runCaptured({
      provider: 'claude', bin: process.execPath, args: [FAKE_SCRIPT], cwd: process.cwd(),
      env: { ...process.env, FAKE_PROVIDER_MODE: 'flood' }, stdin: 'go', timeoutMs: 10_000,
      maxBytes: 1024 * 1024, signal: new AbortController().signal, killGraceMs: 200,
    });
    await expect(run).rejects.toMatchObject({ code: 'PROVIDER_FAILED', message: expect.stringMatching(/output exceeded/) });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('refuses API-key logins before running anything', async () => {
    const counter = await temp('cnt');
    const statuses = await detectProviders({ env: { PATH: binDir, FAKE_PROVIDER_MODE: 'api-key' } });
    expect(statuses.map((s) => s.state)).toEqual(['api-key', 'api-key']);
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'api-key', FAKE_PROVIDER_COUNTER: counter });
    await expect(runner.run(request())).rejects.toMatchObject({ code: 'PROVIDER_AUTH', message: expect.stringMatching(/API key/) });
    await expect(runner.run(request({ provider: 'codex', cacheKey: 'k2' }))).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(existsSync(counter)).toBe(false);
  });
});
