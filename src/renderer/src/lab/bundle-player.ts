import IsolatedWorker from './sandbox-worker?worker&inline';
import { viewSchema, type InstrumentView } from './view-contract';
import type { BundleConfig } from '../../../shared/lab-config';

export class BundlePlayer {
  private readonly worker: Worker;
  private timer?: number;
  private deadline = 0;
  private controls: string[] = [];
  private closed = false;

  constructor(config: BundleConfig, private render: (view: InstrumentView) => void, private fail: (reason: string) => void,
    worker = new IsolatedWorker()) {
    this.worker = worker;
    this.worker.onmessage = ({ data }: MessageEvent<unknown>) => this.receive(data);
    this.worker.onerror = () => this.stop('The isolated instrument could not run.');
    this.worker.onmessageerror = () => this.stop('The instrument returned unreadable output.');
    this.send({ config }, 3000);
  }

  private send(command: { config: BundleConfig } | { action: string }, timeout: number) {
    this.deadline = performance.now() + timeout;
    this.timer = window.setTimeout(() => this.stop('The instrument exceeded its time limit.'), timeout);
    this.worker.postMessage(command);
  }

  private receive(data: unknown) {
    if (this.closed) return;
    if (this.timer === undefined || !data || typeof data !== 'object' || !('view' in data)) {
      this.stop('The instrument stopped. Its program failed or exceeded a sandbox limit.');
      return;
    }
    if (performance.now() >= this.deadline) { this.stop('The instrument exceeded its time limit.'); return; }
    const result = viewSchema.safeParse(data.view);
    if (!result.success) { this.stop('The instrument returned an invalid view.'); return; }
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.controls = result.data.controls.map(control => control.id);
    this.render(result.data);
  }

  act(action: unknown) {
    if (typeof action !== 'string' || this.closed || this.timer !== undefined || !this.controls.includes(action)) return;
    this.send({ action }, 500);
  }

  private stop(reason: string) {
    this.close();
    this.fail(reason);
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.timer);
    this.worker.terminate();
  }
}
