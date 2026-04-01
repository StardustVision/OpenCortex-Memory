import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/cli.ts', 'src/scan.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node18',
  splitting: true,
  clean: true,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
  outExtension: () => ({ js: '.mjs' }),
});
