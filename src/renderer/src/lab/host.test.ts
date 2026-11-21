import { afterEach, expect, it, vi } from 'vitest';
import { InstrumentHost } from './host';

vi.mock('../api', () => ({ call: vi.fn().mockResolvedValue(true) }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('reports startup failure if a ready instrument never supplies a layout', async () => {
  vi.useFakeTimers();
  const port = { onmessage: null as null | ((event: { data: string }) => void), onmessageerror: null,
    postMessage: vi.fn(), close: vi.fn() };
  const frame = { style: {}, setAttribute: vi.fn(), remove: vi.fn(), contentWindow: { postMessage: vi.fn() } };
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', { createElement: () => frame });
  vi.stubGlobal('MessageChannel', class { port1 = port; port2 = { close: vi.fn() }; });
  const failure = vi.fn();
  const ready = vi.fn();
  const session = 'b0ba3189-ef7a-4323-9c81-f4c35026d273';
  const opening = { session, manifest: { config: { pack: 'bundle@1' } }, state: null } as unknown as ConstructorParameters<typeof InstrumentHost>[2];
  new InstrumentHost({ replaceChildren: vi.fn() } as unknown as HTMLElement, 'Activity', opening,
    { onFailure: failure, onReady: ready, onUse: vi.fn(), onLesson: vi.fn() });
  expect(port.onmessage).not.toBeNull();
  port.onmessage!({ data: JSON.stringify({ session, kind: 'ready' }) });
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(failure).toHaveBeenCalledWith('The instrument did not start.');
  expect(frame.remove).toHaveBeenCalledOnce();
});
