import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showWhenReady } from './window-show';

function makeWindow() {
  const window = Object.assign(new EventEmitter(), { show: vi.fn(), isDestroyed: vi.fn(() => false) });
  showWhenReady(window as unknown as BrowserWindow);
  return window;
}

describe('showWhenReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows on ready and cancels the fallback', () => {
    const window = makeWindow();
    vi.advanceTimersByTime(1999);
    expect(window.show).not.toHaveBeenCalled();
    window.emit('ready-to-show');
    expect(window.show).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(window.show).toHaveBeenCalledOnce();
  });

  it('shows at the fallback deadline when ready is delayed', () => {
    const window = makeWindow();
    vi.advanceTimersByTime(1999);
    expect(window.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(window.show).toHaveBeenCalledOnce();
    window.emit('ready-to-show');
    expect(window.show).toHaveBeenCalledTimes(2);
  });

  it('cancels the fallback on close', () => {
    const window = makeWindow();
    window.emit('closed');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(window.show).not.toHaveBeenCalled();
  });

  it.each(['ready-to-show', 'fallback'])('does not show a destroyed window on %s', trigger => {
    const window = makeWindow();
    window.isDestroyed.mockReturnValue(true);
    if (trigger === 'fallback') vi.advanceTimersByTime(2000);
    else window.emit(trigger);
    expect(window.isDestroyed).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });
});
