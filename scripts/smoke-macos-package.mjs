import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, globSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function smoke(executable, logFd) {
  const child = spawn(executable, [], { stdio: ['ignore', logFd, logFd] });
  const exited = once(child, 'exit');
  try {
    const earlyExit = await Promise.race([exited, delay(10_000, null, { ref: false })]);
    if (earlyExit !== null) {
      const [code, signal] = earlyExit;
      throw new Error(`Delve exited during startup (${signal ?? code}).`);
    }

    assert.ok(child.kill('SIGTERM'), 'Delve must still be running when SIGTERM is sent');
    const shutdown = await Promise.race([exited, delay(15_000, null, { ref: false })]);
    assert.notEqual(shutdown, null, 'Delve did not exit within 15 seconds of SIGTERM');
    assert.deepEqual(shutdown, [0, null], 'Delve must exit cleanly after SIGTERM');
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      if (!child.kill('SIGKILL')) console.error(`Could not send SIGKILL to Delve (PID ${child.pid}).`);
      await Promise.race([exited, delay(1_000, undefined, { ref: false })])
        .finally(() => child.unref());
    }
  }
}

const bundles = globSync('release/*/mac*/Delve.app');
assert.equal(bundles.length, 1, `Expected one packaged Delve.app, found ${bundles.length}`);
const bundle = bundles[0];
const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
execFileSync('codesign', ['--verify', '--strict', framework], { stdio: 'inherit' });

const log = 'mac-launch.log';
const logFd = openSync(log, 'w');
try {
  await smoke(join(bundle, 'Contents/MacOS/Delve'), logFd);
} catch (error) {
  console.error(readFileSync(log, 'utf8'));
  throw error;
} finally {
  closeSync(logFd);
}
console.log('Packaged Delve started and exited cleanly after SIGTERM.');
