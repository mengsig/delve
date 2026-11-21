import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeShimDir, makeTempDir, request, setupRunner } from './test-helpers';

describe('ProviderRunner failures', () => {
  let binDir: string;

  beforeAll(async () => {
    binDir = await makeShimDir();
  });

  const setup = (env: NodeJS.ProcessEnv = {}) => setupRunner(binDir, env);
  const counterIn = async (): Promise<string> => path.join(await makeTempDir('cnt'), 'n');

  it('fails with PROVIDER_INVALID_OUTPUT after bounded retries', async () => {
    const counter = await counterIn();
    const { runner } = await setup({ FAKE_PROVIDER_MODE: 'invalid', FAKE_PROVIDER_COUNTER: counter });
    await expect(runner.run(request({ maxRetries: 2 }))).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(await readFile(counter, 'utf8')).toBe('3');
  });

  it('allows at most 3 retries and refuses retry or timeout values that would not bound the run', async () => {
    const counter = await counterIn();
    const { runner } = await setup({ FAKE_PROVIDER_MODE: 'invalid', FAKE_PROVIDER_COUNTER: counter });
    await expect(runner.run(request({ maxRetries: 3 }))).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(await readFile(counter, 'utf8')).toBe('4');
    for (const maxRetries of [99, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => runner.run(request({ maxRetries, cacheKey: `r${maxRetries}` }))).toThrow(/maxRetries/);
    }
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => runner.run(request({ timeoutMs, cacheKey: `t${timeoutMs}` }))).toThrow(/timeoutMs/);
    }
    expect(await readFile(counter, 'utf8')).toBe('4');
  });

  it('succeeds on retry after a transient failure', async () => {
    const counter = await counterIn();
    const { runner } = await setup({ FAKE_PROVIDER_MODE: 'fail-once', FAKE_PROVIDER_COUNTER: counter });
    const res = await runner.run(request());
    expect(res.attempts).toBe(2);
    expect(res.value.answer).toBe('42');
  });

  it.each([
    ['auth', 'PROVIDER_AUTH', /not signed in/],
    ['quota', 'PROVIDER_QUOTA', /will not retry/],
  ])('%s errors are clear and not retried', async (mode, code, message) => {
    const counter = await counterIn();
    const { runner } = await setup({ FAKE_PROVIDER_MODE: mode, FAKE_PROVIDER_COUNTER: counter });
    await expect(runner.run(request({ maxRetries: 3 }))).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
    expect(await readFile(counter, 'utf8')).toBe('1');
  });

  it('times out quickly with PROVIDER_TIMEOUT and does not retry', async () => {
    const counter = await counterIn();
    const { runner, tempRoot } = await setup({ FAKE_PROVIDER_MODE: 'hang', FAKE_PROVIDER_COUNTER: counter });
    await expect(runner.run(request({ timeoutMs: 300, maxRetries: 3 }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(await readFile(counter, 'utf8')).toBe('1');
    expect(await readdir(tempRoot)).toEqual([]);
  }, 10_000);

  it('an AbortSignal rejects with PROVIDER_CANCELLED', async () => {
    const { runner } = await setup({ FAKE_PROVIDER_MODE: 'hang' });
    const controller = new AbortController();
    const second = runner.run(request({ cacheKey: 'k2', timeoutMs: 30_000, signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);
    await expect(second).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
  }, 15_000);
});
