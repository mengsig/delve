import { contextBridge, ipcRenderer } from 'electron';
import { isIpcChannel, type DelveApi } from '../shared/ipc';

// The only bridge into the renderer: a typed invoke restricted to the channel map.
const api: DelveApi = {
  invoke(channel, request) {
    if (!isIpcChannel(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
    return ipcRenderer.invoke(channel, request);
  },
};

contextBridge.exposeInMainWorld('delve', api);
