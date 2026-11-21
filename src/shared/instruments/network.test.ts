import { describe, expect, it } from 'vitest';
import { initialState, packContracts, packSchema, transition } from './index';

const ports = { clientPort: 'c.out', proxyInputPort: 'p.in', proxyOutputPort: 'p.out', servicePort: 's.in' };
const firstHop = { fromPort: ports.clientPort, toPort: ports.proxyInputPort };
const secondHop = { fromPort: ports.proxyOutputPort, toPort: ports.servicePort };
const bypass = { fromPort: ports.clientPort, toPort: ports.servicePort };
const config = packSchema.parse({
  pack: 'network-builder@1',
  parameters: { ...ports, initialLinks: [firstHop] },
});

describe('network builder', () => {
  it('traces a host-verified proxy route and clears the result after editing', () => {
    const initial = initialState(config);
    const linked = transition(config, initial, { type: 'link.added', ...secondHop });
    const tested = transition(config, linked.state, { type: 'test' });
    expect(linked.assessment).toBeUndefined();
    expect(tested).toMatchObject({
      state: { links: [firstHop, secondHop], testedRoute: 'via-proxy' },
      assessment: { status: 'demonstrated' },
    });
    const removed = transition(config, tested.state, { type: 'link.removed', ...firstHop });
    expect(removed.state).toMatchObject({ testedRoute: null });
    expect(transition(config, removed.state, { type: 'test' })).toMatchObject({
      state: { testedRoute: 'disconnected' }, assessment: { status: 'partial' },
    });
    expect(transition(config, removed.state, { type: 'reset' })).toEqual({ state: initial });
  });

  it('reports a direct route as bypassing the proxy', () => {
    const direct = packSchema.parse({ ...config, parameters: { ...ports, initialLinks: [bypass] } });
    expect(transition(direct, initialState(direct), { type: 'test' })).toMatchObject({
      state: { testedRoute: 'direct' }, assessment: { status: 'partial' },
    });
  });

  it('checks link direction, identity and occupancy at both boundaries', () => {
    const state = initialState(config);
    expect(() => transition(config, state, { type: 'link.added', ...firstHop })).toThrow();
    expect(() => transition(config, state, { type: 'link.added', ...bypass })).toThrow();
    expect(() => transition(config, state, { type: 'link.added', fromPort: 'unknown', toPort: ports.servicePort })).toThrow();
    expect(() => transition(config, state, { type: 'link.added', fromPort: ports.proxyInputPort, toPort: ports.clientPort }))
      .toThrow();
    expect(() => transition(config, state, { type: 'link.removed', ...secondHop })).toThrow();
    expect(packSchema.safeParse({ ...config, parameters: { ...ports, initialLinks: [firstHop, bypass] } }).success)
      .toBe(false);
    expect(packSchema.safeParse({ ...config, parameters: { ...ports, proxyInputPort: ports.servicePort, initialLinks: [] } }).success)
      .toBe(false);
    expect(packContracts['network-builder@1'].inputSchema.safeParse({ type: 'test', route: 'via-proxy' }).success)
      .toBe(false);
  });
});

it('requires a learner-added hop before a fully connected seed can demonstrate the route', () => {
  const supplied = packSchema.parse({ ...config, parameters: { ...ports, initialLinks: [firstHop, secondHop] } });
  const start = initialState(supplied);
  expect(transition(supplied, start, { type: 'test' }).assessment?.status).toBe('practice');
  const broken = transition(supplied, start, { type: 'link.removed', ...secondHop }).state;
  const rebuilt = transition(supplied, broken, { type: 'link.added', ...secondHop }).state;
  expect(transition(supplied, rebuilt, { type: 'test' }).assessment?.status).toBe('demonstrated');
  const reset = transition(supplied, rebuilt, { type: 'reset' }).state;
  expect(transition(supplied, reset, { type: 'test' }).assessment?.status).toBe('practice');
});
