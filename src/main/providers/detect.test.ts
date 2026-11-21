import { beforeAll, describe, expect, it } from 'vitest';
import { detectProviders } from './detect';
import { makeShimDir, shimEnv } from './test-helpers';

describe('detectProviders', () => {
  let binDir: string;
  beforeAll(async () => {
    binDir = await makeShimDir();
  });

  it('reports not-found for both providers with an empty PATH', async () => {
    const result = await detectProviders({ env: { PATH: '' } });
    expect(result.map((s) => [s.id, s.state, s.detail])).toEqual([
      ['claude', 'not-found', 'not found on PATH'],
      ['codex', 'not-found', 'not found on PATH'],
    ]);
  });

  it('reports signed-in with version and no personal fields', async () => {
    const result = await detectProviders({ env: shimEnv(binDir) });
    expect(result.map((s) => s.state)).toEqual(['signed-in', 'signed-in']);
    expect(result[0]?.detail).toContain('claude.ai');
    expect(result[0]?.version).toBe('fake-claude 1.0.0');
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(['detail', 'id', 'path', 'state', 'version']);
  });

  it('reports signed-out', async () => {
    const result = await detectProviders({ env: shimEnv(binDir, { FAKE_PROVIDER_MODE: 'signed-out' }) });
    expect(result.map((s) => s.state)).toEqual(['signed-out', 'signed-out']);
  });
});
