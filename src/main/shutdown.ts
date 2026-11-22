import assert from 'node:assert/strict';
import { app } from 'electron';
import { DomainError } from '../shared/errors';

const DRAIN_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 8_000;

export function installShutdown() {
  console.error(`[delve] main started (pid ${process.pid})`);
  const controller = new AbortController();
  let cleanup: (() => Promise<void>) | undefined;
  let exitCode = 0;
  let drained = false;

  function quit(code = 0) {
    exitCode = Math.max(code, exitCode);
    app.quit();
  }

  if (process.platform === 'linux' || process.platform === 'darwin') {
    // Electron startup can replace earlier signal handlers.
    app.on('ready', () => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => { console.error(`[delve] received ${signal}`); quit(); });
      }
    });
  }

  app.on('before-quit', event => {
    if (drained) return;
    event.preventDefault();
    if (controller.signal.aborted) return;
    console.error('[delve] before-quit: draining');
    controller.abort(new DomainError('APP_CLOSING', 'Delve is closing.'));
    const timeout = setTimeout(() => {
      console.error(`[delve] shutdown failed: cleanup exceeded ${DRAIN_TIMEOUT_MS}ms`);
      app.exit(1);
    }, DRAIN_TIMEOUT_MS);
    void Promise.resolve().then(() => cleanup?.()).then(
      () => { console.error('[delve] drain done'); drained = true; if (exitCode === 0) app.quit(); else app.exit(exitCode); },
      error => {
        console.error('[delve] shutdown failed', error);
        app.exit(1);
      },
    ).finally(() => clearTimeout(timeout));
  });
  app.on('quit', (_event, code) => { console.error(`[delve] exit ${code}`); });

  return {
    signal: controller.signal,
    setCleanup(callback: () => Promise<void>) {
      assert.equal(cleanup, undefined, 'shutdown cleanup may only be installed once');
      assert.ok(!controller.signal.aborted, 'cannot acquire resources during shutdown');
      cleanup = callback;
    },
    quit,
  };
}
