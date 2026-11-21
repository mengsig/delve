import assert from 'node:assert/strict';
import { app } from 'electron';
import { DomainError } from '../shared/errors';

export function installShutdown() {
  const controller = new AbortController();
  let cleanup: (() => Promise<void>) | undefined;
  let exitCode = 0;
  let drained = false;

  function quit(code = 0) {
    exitCode = Math.max(code, exitCode);
    app.quit();
  }

  if (process.platform === 'linux') {
    process.on('SIGINT', () => quit());
    process.on('SIGTERM', () => quit());
  }

  app.on('before-quit', event => {
    if (drained) return;
    event.preventDefault();
    if (controller.signal.aborted) return;
    controller.abort(new DomainError('APP_CLOSING', 'Delve is closing.'));
    void Promise.resolve().then(() => cleanup?.()).then(
      () => { drained = true; if (exitCode === 0) app.quit(); else app.exit(exitCode); },
      error => {
        console.error('[delve] shutdown failed', error);
        app.exit(1);
      },
    );
  });

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
