import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitSource } from './source-process';

it('runs Git without reading the user global configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delve-git-config-'));
  try {
    await writeFile(join(home, '.gitconfig'), '[delve]\n  sentinel = must-not-load\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    const result = await gitSource(['config', '--global', '--list']);
    expect(result.status, result.diagnostic).toBe(0);
    expect(result.output.toString('utf8')).toBe('');
    expect(result.truncated).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
