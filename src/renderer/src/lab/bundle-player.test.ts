import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleConfig } from '../../../shared/lab-config';
import { BundlePlayer } from './bundle-player';

class SilentWorker {
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage?: (e: { data: unknown }) => void;
}
const config: BundleConfig = { pack: 'bundle@1', parameters: { title: 'Practice', initial: '' },
  bundle: { apiVersion: 'delve.view/1', entry: 'step', sha256: '0'.repeat(64), source: 'function step() {}' } };

describe('external instrument watchdog', () => {
  let worker: SilentWorker;
  beforeEach(() => {
    vi.useFakeTimers();
    worker = new SilentWorker();
    vi.stubGlobal('window', globalThis);

  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('terminates a worker which never finishes initialization', () => {
    const failed = vi.fn();
    new BundlePlayer(config, vi.fn(), failed, worker as unknown as Worker);
    vi.advanceTimersByTime(3001);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(expect.stringContaining('time limit'));
  });

  it('only sends offered actions, allows one pending view and terminates a stalled step', () => {
    const render = vi.fn();
    const failed = vi.fn();
    const player = new BundlePlayer(config, render, failed, worker as unknown as Worker);
    worker.onmessage!({ data: { view: { text: 'Board', controls: [{ id: 'move', label: 'Move' }], marks: [] } } });
    player.act('recordEvidence');
    expect(worker.postMessage).toHaveBeenCalledOnce();
    player.act('move');
    player.act('move');
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(501);
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.onmessage!({ data: { view: { text: 'Late', controls: [], marks: [] } } });
    expect(render).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
  });
});
