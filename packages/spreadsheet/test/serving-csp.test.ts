// The browser engine is WebAssembly, so the header that serves the admin is
// part of whether a workbook opens at all.
//
// `admin/src/components/features/knowledge/spreadsheet/workbook-engine.ts`
// compiles `@ironcalc/wasm/wasm_bg.wasm` with
// `WebAssembly.instantiateStreaming`. Under a bare `script-src 'self'` every
// engine refuses to compile WebAssembly, and the pane renders "The spreadsheet
// engine could not start" — on the web app and, because the Tauri shells load
// the hosted admin with `security.csp: null`, on macOS and Windows with it.
//
// The nginx comment used to argue *for* tightening this directive, so the
// invariant is asserted rather than left to a reader. `infrastructure/` is in
// `GLOBAL_PREFIXES` (scripts/ci-scope.mjs), so editing the conf forces a full
// CI run and this test is part of it.
//
// docs/standards/spreadsheets.md §"Serving it: the admin CSP must carry
// `'wasm-unsafe-eval'`"

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const adminConf = path.join(repoRoot, 'infrastructure/docker/admin-nginx.conf')

/** The `script-src` directive out of the conf's single `set $csp "…";` line. */
const adminScriptSrc = (): string => {
  const conf = fs.readFileSync(adminConf, 'utf8')
  const policy = /set\s+\$csp\s+"([^"]+)"/.exec(conf)
  assert.ok(policy, 'admin-nginx.conf no longer defines the CSP as `set $csp "…"`')
  const directive = policy[1]
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'))
  assert.ok(directive, 'the admin CSP has no script-src directive')
  return directive
}

describe('admin CSP', () => {
  it("lets the spreadsheet engine compile: script-src carries 'wasm-unsafe-eval'", () => {
    assert.match(
      adminScriptSrc(),
      /'wasm-unsafe-eval'/,
      "the admin `script-src` dropped 'wasm-unsafe-eval' — every workbook fails to open with " +
        '"The spreadsheet engine could not start"',
    )
  })

  it("grants WebAssembly only: script-src never carries bare 'unsafe-eval'", () => {
    // `'unsafe-eval'` would also re-open eval()/new Function() on JavaScript,
    // on the one origin holding session tokens and rendering email HTML. The
    // leading quote is what keeps this off `'wasm-unsafe-eval'`, where the
    // token is preceded by `wasm-` rather than by the quote.
    assert.doesNotMatch(
      adminScriptSrc(),
      /'unsafe-eval'/,
      "the admin `script-src` gained 'unsafe-eval'; WebAssembly needs only 'wasm-unsafe-eval'",
    )
  })
})
