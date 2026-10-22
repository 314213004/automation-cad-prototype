import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/extension.ts'),
      formats: ['iife'],
      name: 'AutomationCadExtension',
      fileName: () => 'extension.js'
    },
    rollupOptions: {
      output: {
        assetFileNames: '[name][extname]',
        inlineDynamicImports: true
      }
    },
    assetsInlineLimit: 0
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        assetFileNames: '[name][extname]'
      }
    }
  }
});
