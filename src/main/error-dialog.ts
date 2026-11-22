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
