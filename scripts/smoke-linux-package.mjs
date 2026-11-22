import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

async function waitForDatabase(wal, signal) {
  while ((statSync(wal, { throwIfNoEntry: false })?.size ?? 0) <= 32) {
    await delay(25, undefined, { signal });
  }
}

async function smoke(executable) {
  const directory = mkdtempSync(join(tmpdir(), 'delve-package-smoke-'));
  const database = join(directory, 'delve.sqlite');
  const wal = database + '-wal';
  const child = spawn(executable, [], {
    env: { ...process.env, DELVE_USER_DATA_DIR: directory },
    stdio: 'inherit',
  });
  const exited = once(child, 'exit');
  const startup = new AbortController();
  try {
    await Promise.race([
      waitForDatabase(wal, AbortSignal.any([startup.signal, AbortSignal.timeout(15_000)])),
      exited.then(([code, signal]) => { throw new Error(`Delve exited during startup (${signal ?? code}).`); }),
    ]);
    assert.ok(child.kill('SIGTERM'), 'the packaged app must still be running');
    assert.deepEqual(await Promise.race([
      exited,
      delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Delve did not exit within 15 seconds of SIGTERM.'); }),
    ]), [0, null]);
    assert.ok(!existsSync(wal), 'SQLite must finish its WAL checkpoint before exit');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.ok(db.prepare('SELECT COUNT(*) AS total FROM workspaces').get().total > 0, 'demo workspaces must be seeded');
    } finally {
      db.close();
    }
  } finally {
    startup.abort();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.platform !== 'linux' || process.argv.length !== 3) {
  console.error('On Linux, run npm run test:linux-package -- <AppImage or unpacked executable>');
  process.exitCode = 1;
} else {
  await smoke(resolve(process.argv[2]));
  console.log('Packaged Delve started, handled SIGTERM, and closed its SQLite database.');
}
