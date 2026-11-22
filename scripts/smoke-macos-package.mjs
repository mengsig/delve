import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, globSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function smoke(executable, logFd, env = process.env, startupMarker = '[delve] main ready') {
  const child = spawn(executable, ['-ApplePersistenceIgnoreState', 'YES'], { env, stdio: ['ignore', logFd, logFd] });
  const exited = once(child, 'exit');
  try {
    const earlyExit = await Promise.race([exited, delay(10_000, null, { ref: false })]);
    if (earlyExit !== null) {
      const [code, signal] = earlyExit;
      throw new Error(`Delve exited during startup (${signal ?? code}).`);
    }
    assert.ok(readFileSync('mac-launch.log', 'utf8').includes(startupMarker), `Delve did not reach ${startupMarker}`);

    assert.ok(child.kill('SIGTERM'), 'Delve must still be running when SIGTERM is sent');
    const shutdown = await Promise.race([exited, delay(15_000, null, { ref: false })]);
    assert.notEqual(shutdown, null, 'Delve did not exit within 15 seconds of SIGTERM');
    assert.deepEqual(shutdown, [0, null], 'Delve must exit cleanly after SIGTERM');
    assert.ok(readFileSync('mac-launch.log', 'utf8').includes('[delve] received SIGTERM'), 'Delve did not handle SIGTERM');
  } catch (error) {
    console.error(`Delve process tree at failure (app PID ${child.pid ?? 'unknown'}):`);
    try {
      const listing = execFileSync('ps', ['-axo', 'pid,ppid,stat,command'], { encoding: 'utf8', timeout: 5000 });
      const lines = listing.trimEnd().split('\n');
      const family = new Set([child.pid]);
      const processes = lines.slice(1).map(line => ({ line, ids: line.trim().split(/\s+/, 3).slice(0, 2).map(Number) }));
      let size;
      do {
        size = family.size;
        for (const { ids: [pid, parent] } of processes) if (family.has(parent)) family.add(pid);
      } while (family.size !== size);
      console.error([lines[0], ...processes.filter(({ ids: [pid] }) => family.has(pid)).map(({ line }) => line)].join('\n'));
    } catch (diagnosticError) {
      console.error('Could not list processes:', diagnosticError);
    }
    throw error;
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
const executable = join(bundle, 'Contents/MacOS/Delve');
const directory = mkdtempSync(join(tmpdir(), 'delve-mac-smoke-'));
try {
  for (const failure of [false, true]) {
    const data = join(directory, failure ? 'failure' : 'data');
    mkdirSync(data);
    if (failure) mkdirSync(join(data, 'delve.sqlite'));
    const logFd = openSync(log, 'w');
    try {
      await smoke(executable, logFd, { ...process.env, DELVE_USER_DATA_DIR: data },
        failure ? '[delve] error dialog open' : '[delve] main ready');
    } catch (error) {
      console.error('Delve stdout and stderr:\n' + readFileSync(log, 'utf8'));
      throw error;
    } finally {
      closeSync(logFd);
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log('Packaged Delve exited cleanly after SIGTERM during normal startup and a startup error dialog.');
