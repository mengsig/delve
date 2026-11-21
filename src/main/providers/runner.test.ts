import { readFile, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProviderRunner } from './runner';
import { answerJsonSchema, makeShimDir, makeTempDir, request, setupRunner } from './test-helpers';

describe('ProviderRunner', () => {
  let binDir: string;

  beforeAll(async () => {
    binDir = await makeShimDir();
  });

  const setup = (env: NodeJS.ProcessEnv = {}) => setupRunner(binDir, env);

  it('parses and validates claude output; argv fixed, prompt on stdin, cwd empty then removed', async () => {
    const record = path.join(await makeTempDir('rec'), 'rec.json');
    const { runner, tempRoot } = await setup({ FAKE_PROVIDER_RECORD: record, ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', CODEX_API_KEY: 'z', ANTHROPIC_AUTH_TOKEN: 't' });
    const res = await runner.run(request({ model: 'sonnet' }));
    expect(res).toMatchObject({ value: { answer: '42' }, provider: 'claude', model: 'sonnet', attempts: 1 });
    const rec = JSON.parse(await readFile(record, 'utf8'));
    expect(rec.argv).toEqual([
      '-p', '--output-format', 'json', '--json-schema', JSON.stringify(answerJsonSchema), '--tools', '',
      '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
      '--model', 'sonnet',
    ]);
    expect(rec.stdin).toBe('SECRET PROMPT');
    expect(rec.argv.join(' ')).not.toContain('SECRET');
    expect(rec.cwdEntries).toEqual([]);
    expect(rec.cwd).toContain('delve-run-');
    await expect(stat(rec.cwd)).rejects.toThrow();
    expect(await readdir(tempRoot)).toEqual([]);
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      expect(rec.envKeys).not.toContain(key);
    }
  });

  it('runs codex with schema and last-message files from a symlinked temporary root', async () => {
    const record = path.join(await makeTempDir('rec'), 'rec.json');
    const alias = path.join(await makeTempDir('alias'), 'temporary');
    await symlink(await makeTempDir('actual'), alias, 'junction');
    const { runner } = await setupRunner(binDir, { FAKE_PROVIDER_RECORD: record }, alias);
    const res = await runner.run(request({ provider: 'codex' }));
    expect(res.value).toEqual({ answer: '42' });
    const rec = JSON.parse(await readFile(record, 'utf8'));
    expect(rec.argv.slice(0, 2)).toEqual(['exec', '--sandbox']);
    expect(rec.argv.at(-1)).toBe('-');
    expect(rec.argv[rec.argv.indexOf('--cd') + 1]).toBe(rec.cwd);
    expect(rec.cwdEntries).toEqual([]);
  });

  it('reports PROVIDER_NOT_FOUND when the CLI is missing', async () => {
    const runner = new ProviderRunner({
      resolveProvider: async (id) => ({ id, state: 'not-found', path: null, version: null, detail: 'not found on PATH' }),
    });
    await expect(runner.run(request())).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
  });

  it('de-duplicates concurrent runs with the same cacheKey', async () => {
    const counter = path.join(await makeTempDir('cnt'), 'n');
    const { runner } = await setup({ FAKE_PROVIDER_COUNTER: counter });
    const a = runner.run(request());
    const b = runner.run(request());
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(await readFile(counter, 'utf8')).toBe('1');
  });
});
