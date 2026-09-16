// The Phase 3a acceptance criterion the bundle sizes alone cannot prove: the
// IronCalc chunk and the 1.9 MB wasm are reached only through a dynamic import,
// on a **production** build.
//
//   pnpm --filter @nessie/admin build && node admin/e2e/spreadsheet-shell/lazy-chunk.mjs
//
// `run.mjs` proves the same thing from a live network log, but only against the
// dev server. This one reads `admin/dist`, so a regression that only a
// production rollup can produce — a barrel re-export, an eager `import` added
// to a shared module, a `modulepreload` hint — fails here rather than in a
// 858 kB first paint on `/knowledge-base`.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { ADMIN_ROOT } from '../navigation/lib/config.mjs'

const dist = resolve(ADMIN_ROOT, 'dist')
const assets = resolve(dist, 'assets')
const files = readdirSync(assets)
const read = (file) => readFileSync(resolve(assets, file), 'utf8')

// Matched on the suffix, not the exact name: Phase 3b made
// `LiveSpreadsheetPane` the lazy entry point (the pane with the live lane
// wired into its seams), and the thing this file is about is the *boundary*,
// not which module sits on the far side of it.
const chunk = files.find((file) => /SpreadsheetPane-[\w-]+\.js$/.test(file))
assert.ok(chunk, 'no SpreadsheetPane chunk: the lazy() boundary is gone')
const wasm = files.find((file) => /^wasm_bg-.*\.wasm$/.test(file))
assert.ok(wasm, 'no wasm asset was emitted')

// The entry is the biggest `index-*.js`; the others are Vite's tiny shims.
const entryFile = files
  .filter((file) => /^index-.*\.js$/.test(file))
  .sort((left, right) => read(right).length - read(left).length)[0]
const entry = read(entryFile)
const chunkSource = read(chunk)
const html = readFileSync(resolve(dist, 'index.html'), 'utf8')

// `ic-worksheet-sheet-container` is IronCalc's and nothing else's, so it is the
// honest test of whether the widget got inlined into the app's first payload.
assert.equal(
  entry.includes('ic-worksheet-sheet-container'),
  false,
  `${entryFile} contains IronCalc: the widget is no longer behind lazy()`,
)
assert.ok(chunkSource.includes('ic-worksheet-sheet-container'), 'the chunk is not the widget')
assert.ok(entry.includes(chunk), 'the entry never references the chunk at all')
assert.equal(
  /import\s*\{[^}]*\}\s*from\s*["'][^"']*SpreadsheetPane/.test(entry),
  false,
  'the entry static-imports the chunk',
)

assert.equal(/wasm_bg-[\w-]+\.wasm/.test(entry), false, 'the entry references the wasm URL')
assert.ok(/wasm_bg-[\w-]+\.wasm/.test(chunkSource), 'the chunk does not reference the wasm')

// A `modulepreload` or `preload` hint would fetch both on the first paint,
// which is the same cost as not being lazy at all.
assert.equal(html.includes('SpreadsheetPane'), false, 'index.html preloads the chunk')
assert.equal(html.includes('.wasm'), false, 'index.html preloads the wasm')

const kb = (file) => Math.round(readFileSync(resolve(assets, file)).length / 1024)
console.log(
  `lazy chunk proof: ${chunk} ${kb(chunk)} kB + ${wasm} ${kb(wasm)} kB reached only by dynamic `
    + `import; entry ${entryFile} ${kb(entryFile)} kB carries neither`,
)
