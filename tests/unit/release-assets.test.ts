import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const script = resolve('scripts/collect-release-assets.sh');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'delve-release-'));
  directories.push(root);
  const input = join(root, 'download', '0.1.0');
  mkdirSync(input, { recursive: true });
  return { root, input, output: join(root, 'assets') };
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'linux')('release asset collection', () => {
  it('flattens nested platform artifacts and writes verifiable checksums', () => {
    const { root, input, output } = fixture();
    const names = ['Delve.AppImage', 'Delve.deb', 'Delve.dmg', 'Delve-setup.exe'];
    for (const name of names) writeFileSync(join(input, name), name);
    execFileSync(script, [join(root, 'download'), output]);
    const lines = readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(names.length);
    for (const name of names) expect(lines.some(line => line.endsWith(`  ${name}`))).toBe(true);
  });

  it('rejects incomplete release artifacts', () => {
    const { root, input, output } = fixture();
    writeFileSync(join(input, 'Delve.AppImage'), 'app');
    const result = spawnSync(script, [join(root, 'download'), output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing release asset');
  });
});
