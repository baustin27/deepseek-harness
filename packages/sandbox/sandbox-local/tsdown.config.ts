import { defineConfig } from 'tsdown'

/** Build the local sandbox provider and the loader-compatible host-access entry. */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    'developer-host-access': 'lib/types/developer-host-access.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
