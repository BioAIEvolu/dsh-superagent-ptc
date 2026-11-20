/**
 * dsh-superagent-ptc browser client build.
 * Adapted from the MIT dsh-codeflow ModuleLoader recipe; no CSS loader is
 * needed because styles.ts is already a JavaScript string.
 */
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  external: ['react'],
  legalComments: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-superagent-ptc",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: ';return module.exports;}});' },
})

console.log('client bundle built: lib/client.js')
