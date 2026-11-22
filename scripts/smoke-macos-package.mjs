import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smoke } from './macos-smoke-process.mjs';

const bundles = globSync('release/*/mac*/Delve.app');
assert.equal(bundles.length, 1, `Expected one packaged Delve.app, found ${bundles.length}`);
const bundle = bundles[0];
const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
execFileSync('codesign', ['--verify', '--strict', framework], { stdio: 'inherit' });

const executable = join(bundle, 'Contents/MacOS/Delve');
const directory = mkdtempSync(join(tmpdir(), 'delve-mac-smoke-'));
try {
  for (const failure of [false, true]) {
    const data = join(directory, failure ? 'failure' : 'data');
    mkdirSync(data);
    if (failure) mkdirSync(join(data, 'delve.sqlite'));
    await smoke(executable, 'mac-launch.log', { ...process.env, DELVE_USER_DATA_DIR: data },
      failure ? '[delve] error dialog open' : '[delve] main ready', failure ? 1 : 0);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log('Packaged Delve exited with the expected codes after SIGTERM during normal startup and a startup error dialog.');
