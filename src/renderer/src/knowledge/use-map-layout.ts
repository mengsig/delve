import { useEffect, useState, type RefObject } from 'react';
import type { LayoutInput, MapLayout } from './map-layout';

interface LayoutResult { input: LayoutInput; layout?: MapLayout; error?: string }

export function useMapLayout(input: LayoutInput): LayoutResult | null {
  const [result, setResult] = useState<LayoutResult | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    const fail = () => setResult({ input, error: 'Could not lay out the knowledge map. Try reopening Knowledge.' });
    worker.onmessage = (event: MessageEvent<MapLayout>) => {
      const { points, areas } = event.data;
      if (!Array.isArray(points) || points.length !== input.concepts.length || !Array.isArray(areas)) {
        fail();
        return;
      }
      setResult({ input, layout: event.data });
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.postMessage(input);
    return () => worker.terminate();
  }, [input]);
  return result?.input === input ? result : null;
}

export function useCanvasSize(canvas: RefObject<HTMLCanvasElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(old => old.width === width && old.height === height ? old : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [canvas]);
  return size;
}
