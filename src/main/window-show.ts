import type { BrowserWindow } from 'electron';

export function showWhenReady(window: BrowserWindow): void {
  const showWindow = () => { if (!window.isDestroyed()) window.show(); };
  const showFallback = setTimeout(showWindow, 2000);
  window.once('ready-to-show', () => { clearTimeout(showFallback); showWindow(); });
  window.once('closed', () => clearTimeout(showFallback));
}
