import { beforeEach, describe, expect, it, vi } from 'vitest';

const { windows, showMessageBox, createWindow } = vi.hoisted(() => ({
  windows: vi.fn(), showMessageBox: vi.fn(), createWindow: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(function () { return createWindow(); }, { getAllWindows: windows }),
  dialog: { showMessageBox },
}));

import { showErrorDialog } from './error-dialog';

beforeEach(() => {
  vi.resetAllMocks();
  windows.mockReturnValue([]);
});

describe('error dialogs', () => {
  it('uses an existing window and passes the shutdown signal to the dialog', async () => {
    const owner = { isDestroyed: () => false, destroy: vi.fn() };
    windows.mockReturnValue([owner]);
    showMessageBox.mockResolvedValue({ response: 0 });
    const controller = new AbortController();
    await showErrorDialog({ message: 'failure' }, controller.signal);
    expect(showMessageBox).toHaveBeenCalledWith(owner, { message: 'failure', signal: controller.signal });
    expect(owner.destroy).not.toHaveBeenCalled();
  });

  it('closes a temporary owner when shutdown aborts the dialog', async () => {
    const owner = { isDestroyed: () => false, destroy: vi.fn() };
    createWindow.mockReturnValue(owner);
    const controller = new AbortController();
    showMessageBox.mockImplementation((_owner, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }));
    const pending = showErrorDialog({ message: 'failure' }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(owner.destroy).toHaveBeenCalledOnce();
  });

  it('propagates dialog errors and does not show a dialog after shutdown', async () => {
    const owner = { isDestroyed: () => false, destroy: vi.fn() };
    createWindow.mockReturnValue(owner);
    showMessageBox.mockRejectedValue(new Error('dialog failed'));
    await expect(showErrorDialog({ message: 'failure' }, new AbortController().signal)).rejects.toThrow('dialog failed');
    expect(owner.destroy).toHaveBeenCalledOnce();
    await showErrorDialog({ message: 'failure' }, AbortSignal.abort());
    expect(showMessageBox).toHaveBeenCalledOnce();
  });
});
