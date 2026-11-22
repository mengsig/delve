import { layoutGraph, type LayoutInput } from './map-layout';

self.onmessage = (event: MessageEvent<LayoutInput>) => {
  self.postMessage(layoutGraph(event.data));
};
