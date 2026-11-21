import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

const IS_WINDOWS = process.platform === 'win32';

// Same layout as an npm cmd-shim, so Windows runs exercise resolveCommand.
function npmCmdShim(entry: string): string {
  return `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\${entry}" %*\r\n`;
}

/** Creates a bin dir with `claude` and `codex` launchers that run the fake provider script. */
export async function makeShimDir(): Promise<string> {
  const dir = await makeTempDir('bin');
  for (const name of ['claude', 'codex']) {
    if (IS_WINDOWS) {
      const entry = `${name}-entry.mjs`;
      const setName = `process.env.FAKE_PROVIDER_NAME = ${JSON.stringify(name)};\n`;
      await writeFile(path.join(dir, entry), `${setName}await import(${JSON.stringify(pathToFileURL(FAKE_SCRIPT).href)});\n`);
      await writeFile(path.join(dir, `${name}.cmd`), npmCmdShim(entry));
      continue;
    }
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\nFAKE_PROVIDER_NAME=${name} exec "${process.execPath}" "${FAKE_SCRIPT}" "$@"\n`);
    await chmod(file, 0o755);
  }
  return dir;
}

/** Environment that finds the launchers in binDir (and, on Windows, node and the system root). */
export function shimEnv(binDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (!IS_WINDOWS) return { PATH: binDir, ...extra };
  const PATH = [binDir, path.dirname(process.execPath)].join(path.delimiter);
  return { PATH, SystemRoot: process.env['SystemRoot'], ...extra };
}

export type Answer = { answer: string };

export const request = (over: Partial<RunRequest<Answer>> = {}): RunRequest<Answer> => ({
  provider: 'claude', prompt: 'SECRET PROMPT', schema: answerSchema, jsonSchema: answerJsonSchema,
  cacheKey: 'k1', ...over,
});

export async function setupRunner(binDir: string, env: NodeJS.ProcessEnv = {}, root?: string): Promise<{ runner: ProviderRunner; tempRoot: string }> {
  const tempRoot = root ?? await makeTempDir('root');
  const childEnv = shimEnv(binDir, env);
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
