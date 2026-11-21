import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { isIpcChannel, type DelveApi } from '../shared/ipc';

// The only bridge into the renderer: a typed invoke restricted to the channel map.
const api: DelveApi = {
  droppedPath: file => webUtils.getPathForFile(file),
  invoke(channel, request) {
    if (!isIpcChannel(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
    return ipcRenderer.invoke(channel, request);
  },
};

if (process.isMainFrame) contextBridge.exposeInMainWorld('delve', api);
