import { InstrumentProgram } from './interpreter';
import type { BundleConfig } from '../../../shared/lab-config';

let program: InstrumentProgram | undefined;

self.onmessage = async (event: MessageEvent<{ config: BundleConfig } | { action: string }>) => {
  try {
    if (self.origin !== 'null') throw new Error('An instrument requires an opaque origin.');
    if ('config' in event.data) {
      if (program) throw new Error('Instrument already opened.');
      program = await InstrumentProgram.load(event.data.config);
    }
    if (!program) throw new Error('No active instrument.');
    const action = 'action' in event.data ? event.data.action : '';
    self.postMessage({ view: program.step(action) });
  } catch {
    self.postMessage({ error: 'The instrument stopped. Its program failed or exceeded a sandbox limit.' });
  }
};
