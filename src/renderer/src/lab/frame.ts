import { mountPack } from '../instruments/view';
import '../instruments/guest.css';
import { mountCustomView } from './frame-view';
import type { PackConfig, PackState } from '../../../shared/instruments';
import { BundlePlayer } from './bundle-player';
import type { BundleConfig } from '../../../shared/lab-config';

export type StageContent = { config: PackConfig; state: PackState } | { program: BundleConfig } | { action: string };

function connect(event: MessageEvent) {
  if (event.source !== parent || parent === window || event.ports.length !== 1) return;
  const session: unknown = event.data?.session;
  const port = event.ports[0];
  const root = document.querySelector('main');
  if (!port || !root || typeof session !== 'string' || session.length !== 36) return;
  window.removeEventListener('message', connect);
  let player: BundlePlayer | undefined;
  let seq = 0;
  let pending = false;
  let height = 0;
  const input = (value: unknown) => {
    if (pending) return;
    pending = true;
    port.postMessage(JSON.stringify({ session, kind: 'input', seq: ++seq, input: value }));
  };
  const update = (data: StageContent) => {
    if ('program' in data) {
      const { program } = data;
      player = new BundlePlayer(program, view => {
        pending = false;
        mountCustomView(root, program.parameters.title, view, input);
      }, reason => port.postMessage(JSON.stringify({ session, kind: 'failed', reason })));
    } else if ('action' in data) {
      player?.act(data.action);
    } else {
      pending = false;
      mountPack(root, data.config, data.state, input);
    }
  };
  port.onmessage = ({ data }: MessageEvent<StageContent>) => {
    try { update(data); } catch {
      player?.close();
      port.postMessage(JSON.stringify({ session, kind: 'failed', reason: 'The instrument could not display its view.' }));
    }
  };
  window.addEventListener('pagehide', () => player?.close(), { once: true });
  new ResizeObserver(() => {
    const next = Math.ceil(document.body.getBoundingClientRect().height) + 2;
    if (next === height || next < 80) return;
    height = next;
    port.postMessage(JSON.stringify({ session, kind: 'layout', height: Math.min(1600, height) }));
  }).observe(document.body);
  port.postMessage(JSON.stringify({ session, kind: 'ready' }));
}
window.addEventListener('message', connect);
