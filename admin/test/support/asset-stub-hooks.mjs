// Node module-customization hooks that stand in for Vite's asset handling, so
// a component that imports a stylesheet or a `?url` asset can be imported in a
// `node --test` run. IronCalc's own vitest setup does the equivalent through
// vitest's asset transform; node has no such transform, so this is it.
//
// Registered from the test that needs it (`register()` before a dynamic
// import), not from the package's test script: it only ever intercepts `.css`
// and `?url` specifiers, and no other suite should have to think about it.
import { createRequire } from 'node:module'

const PREFIX = 'nessie-asset:'
const require = createRequire(import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css') || specifier.includes('?url')) {
    return { format: 'module', shortCircuit: true, url: `${PREFIX}${specifier}` }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (!url.startsWith(PREFIX)) return next(url, context)
  const specifier = url.slice(PREFIX.length)
  if (specifier.endsWith('.css')) {
    // Vite returns nothing useful from a side-effect stylesheet import either.
    return { format: 'module', shortCircuit: true, source: 'export default undefined' }
  }
  // `wasm_bg.wasm?url` is a URL in the browser and the engine fetches it. Under
  // node there is nothing to fetch, so the stub hands over the real bytes:
  // wasm-bindgen's `init` takes a BufferSource on exactly the same path, so the
  // engine under test is the published 0.8.4 wasm, not a fake.
  const file = require.resolve(specifier.replace(/\?url$/, ''))
  return {
    format: 'module',
    shortCircuit: true,
    source: [
      "import { readFileSync } from 'node:fs'",
      `export default readFileSync(${JSON.stringify(file)})`,
    ].join('\n'),
  }
}
