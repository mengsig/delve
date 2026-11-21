import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectProviders } from './detect';
import { runCaptured } from './process';
import { FAKE_SCRIPT, makeShimDir, makeTempDir, request, setupRunner, shimEnv } from './test-helpers';

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
  for (let i = 0; i < 60 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 60 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(file, 'utf8'));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  return pid;
}

const temp = async (name: string): Promise<string> => path.join(await makeTempDir(name), name);

describe('ProviderRunner shared-run cancellation', () => {
  let binDir: string;
  beforeAll(async () => {
    binDir = await makeShimDir();
  });

  it.each(['first', 'second'] as const)('lets the %s of two de-duplicated callers cancel while the other completes', async (which) => {
    const counter = await temp('cnt');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_DELAY_MS: '800', FAKE_PROVIDER_COUNTER: counter });
    const quitter = new AbortController();
    const first = runner.run(request(which === 'first' ? { signal: quitter.signal } : {}));
    const second = runner.run(request(which === 'second' ? { signal: quitter.signal } : {}));
    const [cancelled, kept] = which === 'first' ? [first, second] : [second, first];
    setTimeout(() => quitter.abort(), 150);
    await expect(cancelled).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await expect(kept).resolves.toMatchObject({ value: { answer: '42' }, attempts: 1 });
    expect(await readFile(counter, 'utf8')).toBe('1');
  }, 10_000);

  it('rejects an already-aborted caller at once without starting or disturbing a run', async () => {
    const counter = await temp('cnt');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_DELAY_MS: '300', FAKE_PROVIDER_COUNTER: counter });
    const running = runner.run(request());
    await expect(runner.run(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await expect(running).resolves.toMatchObject({ value: { answer: '42' } });
    expect(await readFile(counter, 'utf8')).toBe('1');
  }, 10_000);

  it('terminates the shared CLI when every live caller cancels', async () => {
    const [counter, selfPid] = [await temp('cnt'), await temp('pid')];
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'hang', FAKE_PROVIDER_COUNTER: counter, FAKE_PROVIDER_SELF_PID: selfPid });
    const [a, b] = [new AbortController(), new AbortController()];
    const runA = runner.run(request({ signal: a.signal, timeoutMs: 30_000 }));
    const runB = runner.run(request({ signal: b.signal, timeoutMs: 30_000 }));
    const cliPid = await readPid(selfPid);
    a.abort();
    await expect(runA).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(isAlive(cliPid)).toBe(true);
    b.abort();
    await expect(runB).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(await waitUntilDead(cliPid)).toBe(true);
    expect(await readFile(counter, 'utf8')).toBe('1');
  }, 10_000);

  it('rejects each of three callers on its own abort while the shared CLI keeps running for the rest', async () => {
    const [counter, selfPid] = [await temp('cnt'), await temp('pid')];
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_DELAY_MS: '1200', FAKE_PROVIDER_COUNTER: counter, FAKE_PROVIDER_SELF_PID: selfPid });
    const [a, b] = [new AbortController(), new AbortController()];
    const runA = runner.run(request({ signal: a.signal }));
    const runB = runner.run(request({ signal: b.signal }));
    const runC = runner.run(request());
    const cliPid = await readPid(selfPid);
    b.abort();
    await expect(runB).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(isAlive(cliPid)).toBe(true);
    a.abort();
    await expect(runA).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    expect(isAlive(cliPid)).toBe(true);
    await expect(runC).resolves.toMatchObject({ value: { answer: '42' }, attempts: 1 });
    expect(await readFile(counter, 'utf8')).toBe('1');
  }, 10_000);
});

describe('ProviderRunner process tree and auth', () => {
  let binDir: string;
  beforeAll(async () => {
    binDir = await makeShimDir();
  });

  it('settles promptly when a descendant still holds the pipes after the CLI exits', async () => {
    const pidFile = await temp('pid');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'orphan', FAKE_PROVIDER_CHILD_PID: pidFile });
    const started = Date.now();
    const run = runner.run(request());
    const descendant = await readPid(pidFile);
    try {
      await expect(run).resolves.toMatchObject({ value: { answer: '42' } });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      // Leftovers after a normal exit are a documented limit; this test owns and stops its own one.
      if (isAlive(descendant)) process.kill(descendant, 'SIGKILL');
    }
    expect(await waitUntilDead(descendant)).toBe(true);
  }, 10_000);

  it('kills the CLI and a pipe-holding descendant on timeout', async () => {
    const [pidFile, selfPid] = [await temp('pid'), await temp('self')];
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'orphan-hang', FAKE_PROVIDER_CHILD_PID: pidFile, FAKE_PROVIDER_SELF_PID: selfPid });
    await expect(runner.run(request({ timeoutMs: 500 }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(await waitUntilDead(await readPid(selfPid))).toBe(true);
    expect(await waitUntilDead(await readPid(pidFile))).toBe(true);
  }, 10_000);

  it('force-kills a CLI and descendant that ignore SIGTERM and keep writing, within the grace', async () => {
    const [pidFile, selfPid] = [await temp('pid'), await temp('self')];
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'ignore-term', FAKE_PROVIDER_CHILD_PID: pidFile, FAKE_PROVIDER_SELF_PID: selfPid });
    const started = Date.now();
    await expect(runner.run(request({ timeoutMs: 400 }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await waitUntilDead(await readPid(selfPid))).toBe(true);
    expect(await waitUntilDead(await readPid(pidFile))).toBe(true);
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
    const statuses = await detectProviders({ env: shimEnv(binDir, { FAKE_PROVIDER_MODE: 'api-key' }) });
    expect(statuses.map((s) => s.state)).toEqual(['api-key', 'api-key']);
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_MODE: 'api-key', FAKE_PROVIDER_COUNTER: counter });
    await expect(runner.run(request())).rejects.toMatchObject({ code: 'PROVIDER_AUTH', message: expect.stringMatching(/API key/) });
    await expect(runner.run(request({ provider: 'codex', cacheKey: 'k2' }))).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(existsSync(counter)).toBe(false);
  });
});
