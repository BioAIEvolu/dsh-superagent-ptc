import { defineConfig } from 'tsdown'

// Host ESM is emitted as lib/host.mjs. The browser client is built separately
// by scripts/build-client.mjs because DSH expects a ModuleLoader CJS wrapper.
export default defineConfig({
  entry: { host: 'src/host/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  dts: false,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
