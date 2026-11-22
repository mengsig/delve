import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';

export async function showErrorDialog(options: MessageBoxOptions, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const existing = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
  const owner = existing ?? new BrowserWindow({ width: 480, height: 240, title: options.title, show: true });
  try {
    const shown = dialog.showMessageBox(owner, { ...options, signal });
    console.error('[delve] error dialog open');
    await shown;
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (!existing && !owner.isDestroyed()) owner.destroy();
  }
}

export async function reportStartupFailure(message: string, shutdown: {
  signal: AbortSignal; setExitCode: (code: number) => void; quit: (code: number) => void;
}): Promise<void> {
  shutdown.setExitCode(1);
  try {
    await showErrorDialog({ type: 'error', title: 'Delve could not start', message }, shutdown.signal);
  } catch (error) {
    console.error('[delve] could not show startup error', error);
  }
  if (!shutdown.signal.aborted) shutdown.quit(1);
}
