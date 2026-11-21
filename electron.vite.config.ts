import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// The production CSP in index.html forbids inline scripts; Vite's dev server needs them for HMR.
function devCsp(): Plugin {
  return {
    name: 'delve-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws:");
    },
  };
}

export default defineConfig({
  main: {
    build: { outDir: 'out/main' },
  },
  preload: {
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: 'src/renderer',
    define: { __DELVE_VERSION__: JSON.stringify(version) },
    build: { outDir: 'out/renderer' },
    plugins: [react(), devCsp()],
  },
});
