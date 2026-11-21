import { beforeAll, describe, expect, it } from 'vitest';
import { detectProviders, parseClaudeAuth, parseCodexAuth, type ExecResult } from './detect';
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

const ok = (stdout: string, code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr, failure: null });
const claude = (fields: Record<string, unknown>) => parseClaudeAuth(ok(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', ...fields })));

describe('subscription versus API-key sign-in', () => {
  let binDirForModes: string;
  beforeAll(async () => {
    binDirForModes = await makeShimDir();
  });

  it('accepts a claude.ai subscription login and a subscription OAuth token', () => {
    expect(claude({ authMethod: 'claude.ai', subscriptionType: 'max' })).toMatchObject({ state: 'signed-in' });
    expect(claude({ authMethod: 'oauth_token', subscriptionType: 'pro' })).toMatchObject({ state: 'signed-in' });
  });

  it('reports Claude API-key logins, including keys the CLI stored, as not signed in with a subscription', () => {
    for (const fields of [
      { authMethod: 'api_key', apiKeySource: '/login managed key' },
      { authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' },
      { authMethod: 'claude.ai', apiKeySource: '/login managed key' },
      { authMethod: 'third_party', apiProvider: 'bedrock' },
    ]) {
      const auth = claude(fields);
      expect(auth.state).toBe('api-key');
      expect(auth.detail).toMatch(/^not signed in with a subscription/);
    }
    expect(claude({ authMethod: 'oauth_token' })).toMatchObject({ state: 'unknown' });
    expect(parseClaudeAuth(ok('{"loggedIn":false,"authMethod":"none"}'))).toMatchObject({ state: 'signed-out' });
    expect(parseClaudeAuth(ok('not json'))).toMatchObject({ state: 'unknown' });
  });

  it('separates a Codex ChatGPT login from a stored API key', () => {
    expect(parseCodexAuth(ok('Logged in using ChatGPT\n'))).toMatchObject({ state: 'signed-in' });
    const key = parseCodexAuth(ok('Logged in using an API key - sk-proj-***\n'));
    expect(key.state).toBe('api-key');
    expect(key.detail).toMatch(/^not signed in with a subscription/);
    expect(parseCodexAuth(ok('', 1, 'Not logged in\n'))).toMatchObject({ state: 'signed-out' });
    expect(parseCodexAuth(ok('something else'))).toMatchObject({ state: 'unknown' });
  });

  it('detects both auth modes for each provider through the CLIs themselves', async () => {
    const subscription = await detectProviders({ env: shimEnv(binDirForModes, {}) });
    const apiKey = await detectProviders({ env: shimEnv(binDirForModes, { FAKE_PROVIDER_MODE: 'api-key' }) });
    expect(subscription.map((s) => [s.id, s.state])).toEqual([['claude', 'signed-in'], ['codex', 'signed-in']]);
    expect(apiKey.map((s) => [s.id, s.state])).toEqual([['claude', 'api-key'], ['codex', 'api-key']]);
  });
});
