import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'out/instrument',
    emptyOutDir: true,
    lib: {
      entry: resolve('src/renderer/src/lab/frame.ts'),
      name: 'DelveInstrument',
      formats: ['iife'],
      fileName: () => 'stage.js',
      cssFileName: 'stage',
    },
  },
});
