import { canConnect, type Link, type NetworkPorts } from '../../../shared/instruments/network';
import { element, type Send } from './dom';

type PortDirection = 'out' | 'in';

interface PortControl {
  id: string;
  direction: PortDirection;
  node: HTMLButtonElement;
}

interface Drag {
  fromPort: string;
  pointer: number;
  x: number;
  y: number;
  moved: boolean;
}

function connectGesture(
  control: PortControl, group: HTMLElement, select: (id: string | null) => void, connect: (to: string) => void,
): void {
  const { id, node } = control;
  let drag: Drag | null = null;
  let suppressClick = false;
  node.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    drag = { fromPort: id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener('pointermove', event => {
    if (drag?.pointer !== event.pointerId || drag.moved) return;
    if (Math.hypot(drag.x - event.clientX, drag.y - event.clientY) < 6) return;
    drag.moved = true;
    select(drag.fromPort);
  });
  node.addEventListener('pointerup', event => {
    if (drag?.pointer !== event.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
    if (!suppressClick) return;
    const target = node.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('[data-input-port]');
    if (target?.dataset.inputPort && !target.disabled && group.contains(target)) connect(target.dataset.inputPort);
    else select(null);
  });
  node.addEventListener('lostpointercapture', () => {
    if (drag?.moved) select(null);
    drag = null;
  });
  node.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) return;
    const selected = node.getAttribute('aria-pressed') === 'true' ? null : id;
    select(selected);
    if (selected) group.querySelector<HTMLButtonElement>('[data-input-port]:enabled')?.focus();
  });
}

function portControl(id: string, direction: PortDirection): PortControl {
  const node = element('button', 'port', element('span', 'small', direction === 'out' ? 'Output' : 'Input'), id);
  node.type = 'button';
  node.dataset.control = `port:${id}`;
  if (direction === 'in') node.dataset.inputPort = id;
  return { id, direction, node };
}

function station(label: string, ...controls: PortControl[]): HTMLElement {
  return element('div', 'unit station', element('strong', '', label), ...controls.map(control => control.node));
}

function bindPorts(group: HTMLElement, controls: PortControl[], ports: NetworkPorts, links: Link[], send: Send): void {
  const outputs = controls.filter(control => control.direction === 'out');
  const inputs = controls.filter(control => control.direction === 'in');
  let selected: string | null = null;

  function select(fromPort: string | null): void {
    selected = fromPort;
    for (const output of outputs) output.node.setAttribute('aria-pressed', String(output.id === selected));
    for (const input of inputs) {
      input.node.disabled = selected === null || !canConnect(ports, links, { fromPort: selected, toPort: input.id });
    }
  }

  function connect(toPort: string): void {
    const fromPort = selected;
    if (fromPort === null || !canConnect(ports, links, { fromPort, toPort })) return;
    outputs.find(output => output.id === fromPort)?.node.focus();
    select(null);
    send({ type: 'link.added', fromPort, toPort });
  }

  for (const output of outputs) {
    output.node.disabled = inputs.every(input => !canConnect(ports, links, { fromPort: output.id, toPort: input.id }));
    connectGesture(output, group, select, connect);
  }
  for (const input of inputs) input.node.addEventListener('click', () => connect(input.id));
  group.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || selected === null) return;
    const source = outputs.find(output => output.id === selected);
    select(null);
    source?.node.focus();
  });
  select(null);
}

export function topology(ports: NetworkPorts, links: Link[], send: Send): HTMLElement {
  const client = portControl(ports.clientPort, 'out');
  const proxyIn = portControl(ports.proxyInputPort, 'in');
  const proxyOut = portControl(ports.proxyOutputPort, 'out');
  const service = portControl(ports.servicePort, 'in');
  const group = element('div', 'steps topology', station('Client', client), station('Proxy', proxyIn, proxyOut),
    station('Service', service));
  bindPorts(group, [client, proxyIn, proxyOut, service], ports, links, send);
  return group;
}
