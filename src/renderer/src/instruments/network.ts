import type { PackConfig, PackState } from '../../../shared/instruments';
import type { Link } from '../../../shared/instruments/network';
import { button, element, header, type PackView, type Send } from './dom';
import { topology } from './ports';

type NetworkConfig = Extract<PackConfig, { pack: 'network-builder@1' }>;
type NetworkState = Extract<PackState, { pack: 'network-builder@1' }>;

const receipts = {
  disconnected: 'The request could not reach the service.',
  direct: 'The request reached the service directly, bypassing the proxy.',
  'via-proxy': 'The request reached the service through the proxy.',
};

function wiring(links: Link[], send: Send): HTMLElement {
  if (links.length === 0) return element('p', 'small', 'No links connected.');
  return element('ul', 'links', ...links.map(link => {
    const { fromPort, toPort } = link;
    const remove = button('Remove', `remove:${fromPort}`, () => send({ type: 'link.removed', fromPort, toPort }), 'reset');
    remove.setAttribute('aria-label', `Remove link from ${fromPort} to ${toPort}`);
    return element('li', 'row', element('span', '', `${fromPort} → ${toPort}`), remove);
  }));
}

export function renderNetwork(config: NetworkConfig, state: NetworkState, send: Send): PackView {
  const { links, testedRoute } = state;
  return {
    before: [
      header(' Network instrument', 'SIMULATED PORTS'),
      element('h2', '', 'Route through the proxy.'),
      element('p', 'small', 'Drag from an output to an input, or activate an output and then an available input.'),
      topology(config.parameters, links, send),
      wiring(links, send),
      element('div', 'controls ctrl',
        button('Test path', 'test', () => send({ type: 'test' }), 'bright'),
        button('Reset', 'reset', () => send({ type: 'reset' }), 'reset'),
      ),
    ],
    receipt: testedRoute ? receipts[testedRoute] : 'Test the path to trace the simulated request.',
  };
}
