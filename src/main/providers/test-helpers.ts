import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ProviderId } from '../../shared/domain';
import { ProviderRunner, type RunRequest } from './runner';
import { detectProviders } from './detect';

export const FAKE_SCRIPT = path.resolve(__dirname, '../../../tests/fixtures/fake-cli/fake-provider.mjs');
export const answerSchema = z.object({ answer: z.string() });
export const answerJsonSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `delve-test-${prefix}-`));
}

/** Creates a bin dir with `claude` and `codex` shims that exec the fake provider script. */
export async function makeShimDir(): Promise<string> {
  const dir = await makeTempDir('bin');
  for (const name of ['claude', 'codex']) {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\nFAKE_PROVIDER_NAME=${name} exec "${process.execPath}" "${FAKE_SCRIPT}" "$@"\n`);
    await chmod(file, 0o755);
  }
  return dir;
}

export type Answer = { answer: string };

export const request = (over: Partial<RunRequest<Answer>> = {}): RunRequest<Answer> => ({
  provider: 'claude', prompt: 'SECRET PROMPT', schema: answerSchema, jsonSchema: answerJsonSchema,
  cacheKey: 'k1', ...over,
});

export async function setupRunner(binDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ runner: ProviderRunner; tempRoot: string }> {
  const tempRoot = await makeTempDir('root');
  const childEnv = { PATH: `${binDir}:${process.env.PATH ?? ''}`, ...env };
  const runner = new ProviderRunner({
    resolveProvider: async (id: ProviderId) => {
      const status = (await detectProviders({ env: childEnv })).find((s) => s.id === id);
      if (!status) throw new Error(`no status for ${id}`);
      return status;
    },
    env: childEnv, tempRoot, killGraceMs: 200, retryBackoffMs: 10,
  });
  return { runner, tempRoot };
}
