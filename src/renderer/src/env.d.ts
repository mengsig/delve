/// <reference types="vite/client" />
import type { DelveApi } from '../../shared/ipc';

declare global {
  interface Window {
    delve: DelveApi;
  }
}
