import type { PackConfig, PackState } from '../../../shared/instruments';
import { button, element, header, type PackView, type Send } from './dom';

type LeaseConfig = Extract<PackConfig, { pack: 'lease-handoff@1' }>;
type LeaseState = Extract<PackState, { pack: 'lease-handoff@1' }>;

function unit(label: string, status: string, off = false): HTMLElement {
  return element('div', off ? 'unit off' : 'unit', element('strong', '', label), element('small', '', status));
}

function leaseSteps(generation: number, expired: boolean): HTMLElement {
  const from = String(generation).padStart(2, '0');
  const to = String(generation + 1).padStart(2, '0');
  const wires = [element('span', 'wire'), element('span', 'wire')] as const;
  for (const wire of wires) wire.setAttribute('aria-hidden', 'true');
  return element('div', 'steps',
    unit('Worker A', `gen ${from} · ${expired ? 'expired' : 'active'}`, expired),
    wires[0],
    unit('Lease store', `active: ${expired ? to : from}`),
    wires[1],
    unit('Worker B', expired ? `gen ${to} · active` : 'waiting', !expired),
  );
}

function leaseControls(expired: boolean, decided: boolean, send: Send): HTMLElement {
  if (!expired) return element('div', 'controls',
    button('Advance one tick →', 'advance', () => send({ type: 'advance' }), 'bright'));
  if (decided) return element('div', 'controls', element('span', 'small', 'Observation sent to your field notes ✓'));
  return element('div', 'controls',
    button('Accept A’s write', 'accept', () => send({ type: 'accept' })),
    button('Reject A’s write', 'reject', () => send({ type: 'reject' }), 'bright'),
  );
}

export function renderLease(config: LeaseConfig, state: LeaseState, send: Send): PackView {
  const { taskId, initialGeneration, deadlineTicks } = config.parameters;
  const { tick, decision } = state;
  const expired = tick === deadlineTicks;
  const decided = decision !== null;
  const heading = decided ? 'Inspect the write.' : expired ? 'A late result arrives.' : 'Watch a lease change hands.';
  const ticks = deadlineTicks === 3 ? 'three ticks' : deadlineTicks === 1 ? 'one tick' : `${deadlineTicks} ticks`;
  const description = expired
    ? `Worker B owns generation ${initialGeneration + 1}. A returns with generation ${initialGeneration}.`
    : `Worker A owns this task for ${ticks}. Advance the clock.`;
  const meter = element('div', 'meter');
  meter.setAttribute('aria-hidden', 'true');
  for (let index = 0; index <= deadlineTicks; index++) {
    meter.append(element('b', index <= tick ? 'on' : ''));
  }
  let receipt = `Clock ${tick}/${deadlineTicks} · ${expired ? 'Decide what the writer should do.' : 'A has not reported yet.'}`;
  if (decision === 'accept') receipt = 'Observed: the stale payload overwrote B’s slot.';
  if (decision === 'reject') receipt = 'Observed: the stale payload was rejected. B can still publish.';
  return {
    before: [
      header(' Dispatch instrument', `TASK / ${taskId} \u00a0 T+${tick}`),
      element('h2', '', heading),
      element('p', 'small', description),
      leaseSteps(initialGeneration, expired),
      meter,
    ],
    receipt,
    after: [element('div', 'foot', leaseControls(expired, decided, send),
      button('Start over', 'reset', () => send({ type: 'reset' }), 'reset'))],
  };
}
