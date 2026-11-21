import { z } from 'zod';
import type { Assessment } from './assessment';

const pack = z.literal('network-builder@1');
const port = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,23}$/);
const linkSchema = z.strictObject({ fromPort: port, toPort: port });
const linksSchema = z.array(linkSchema).max(2);
export type Link = z.infer<typeof linkSchema>;

const portsSchema = z.strictObject({
  clientPort: port,
  proxyInputPort: port,
  proxyOutputPort: port,
  servicePort: port,
});

export type NetworkPorts = z.infer<typeof portsSchema>;

export function canConnect(ports: NetworkPorts, links: readonly Link[], link: Link): boolean {
  const { clientPort, proxyInputPort, proxyOutputPort, servicePort } = ports;
  const { fromPort, toPort } = link;
  const allowed = (fromPort === clientPort && (toPort === proxyInputPort || toPort === servicePort))
    || (fromPort === proxyOutputPort && toPort === servicePort);
  return allowed && links.every(link => link.fromPort !== fromPort && link.toPort !== toPort);
}

function validLinks(ports: NetworkPorts, links: readonly Link[]): boolean {
  return links.every((link, index) => canConnect(ports, links.slice(0, index), link));
}

const networkParametersSchema = portsSchema.extend({ initialLinks: linksSchema })
  .refine(ports => new Set([ports.clientPort, ports.proxyInputPort, ports.proxyOutputPort, ports.servicePort]).size === 4, {
    message: 'The four simulated ports must have distinct IDs',
  })
  .refine(ports => validLinks(ports, ports.initialLinks), {
    path: ['initialLinks'],
    message: 'Initial links must connect available output and input ports',
  });

export const networkConfigSchema = z.strictObject({ pack, parameters: networkParametersSchema });

const route = z.enum(['disconnected', 'direct', 'via-proxy']);
export const networkStateSchema = z.strictObject({ pack, links: linksSchema, testedRoute: route.nullable(), addedLink: z.boolean() });

export const networkInputSchema = z.discriminatedUnion('type', [
  linkSchema.extend({ type: z.literal(['link.added', 'link.removed']) }),
  z.strictObject({ type: z.literal(['test', 'reset']) }),
]);

type NetworkConfig = z.infer<typeof networkConfigSchema>;
type NetworkState = z.infer<typeof networkStateSchema>;
type Route = z.infer<typeof route>;

export const networkDefaults = networkConfigSchema.parse({
  pack: 'network-builder@1',
  parameters: {
    clientPort: 'client.out',
    proxyInputPort: 'proxy.in',
    proxyOutputPort: 'proxy.out',
    servicePort: 'service.in',
    initialLinks: [],
  },
});

export function initialNetwork(config: NetworkConfig): NetworkState {
  return { pack: config.pack, links: config.parameters.initialLinks.map(link => ({ ...link })), testedRoute: null, addedLink: false };
}

function traceRoute(ports: NetworkPorts, links: readonly Link[]): Route {
  const firstHop = links.find(link => link.fromPort === ports.clientPort);
  if (firstHop?.toPort === ports.servicePort) return 'direct';
  const secondHop = links.find(link => link.fromPort === ports.proxyOutputPort);
  if (firstHop?.toPort === ports.proxyInputPort && secondHop?.toPort === ports.servicePort) return 'via-proxy';
  return 'disconnected';
}

function assessRoute(route: Route, addedLink: boolean): Assessment {
  if (route === 'via-proxy' && !addedLink) return {
    status: 'practice',
    observation: 'The supplied topology already routed the request through the proxy.',
    action: 'Disconnect a hop, predict the result, then rebuild the route.',
    reason: 'Testing the starting topology shows where its links lead.',
  };
  if (route === 'via-proxy') return {
    status: 'demonstrated',
    observation: 'The simulated request reached the service through the proxy.',
    action: 'Remove one link and trace where the request stops.',
    reason: 'Both hops are connected in the requested order.',
  };
  return {
    status: 'partial',
    observation: route === 'direct'
      ? 'The simulated request reached the service directly.'
      : 'The simulated request could not reach the service.',
    action: 'Connect the client to the proxy, then the proxy to the service.',
    reason: route === 'direct'
      ? 'The link bypassed the proxy.'
      : 'The links do not form a complete path from the client to the service.',
  };
}

export function transitionNetwork(config: NetworkConfig, state: NetworkState, raw: unknown) {
  const ports = config.parameters;
  const input = networkInputSchema.parse(raw);
  if (!validLinks(ports, state.links)) throw new Error('Invalid links in network state');
  if (state.testedRoute !== null && state.testedRoute !== traceRoute(ports, state.links)) {
    throw new Error('Test result does not match the simulated links');
  }
  switch (input.type) {
    case 'reset': return { state: initialNetwork(config) };
    case 'test': {
      const testedRoute = traceRoute(ports, state.links);
      return { state: { ...state, testedRoute }, assessment: assessRoute(testedRoute, state.addedLink) };
    }
    case 'link.added': {
      const { fromPort, toPort } = input;
      if (!canConnect(ports, state.links, input)) throw new Error('Those ports cannot be connected');
      return { state: { ...state, links: [...state.links, { fromPort, toPort }], testedRoute: null, addedLink: true } };
    }
    case 'link.removed': {
      const links = state.links.filter(link => link.fromPort !== input.fromPort || link.toPort !== input.toPort);
      if (links.length === state.links.length) throw new Error('That link does not exist');
      return { state: { ...state, links, testedRoute: null } };
    }
  }
}
