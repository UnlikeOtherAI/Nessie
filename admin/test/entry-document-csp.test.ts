// The entry document may not carry an inline script, and the theme it paints
// with must be the one the person picked.
//
// `infrastructure/docker/admin-nginx.conf` serves this origin with an enforcing
// `script-src 'self' 'wasm-unsafe-eval'` — no 'unsafe-inline', no nonce. An
// inline <script> in index.html therefore runs in dev and is *refused* in
// production, with nothing louder than a console line to say so. That is what
// happened to the pre-paint theme block: for two weeks every production reload
// painted the bare `:root` palette (the purple one) and repainted in the
// person's own theme once ThemeProvider mounted. The nginx comment asserted the
// invariant; nothing checked it. This does.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { THEME_IDS } from '../src/lib/theme-storage.js'

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(adminRoot, '..')

const entryDocument = fs.readFileSync(path.join(adminRoot, 'index.html'), 'utf8')
const bootScript = fs.readFileSync(path.join(adminRoot, 'public/boot-theme.js'), 'utf8')
const adminConf = fs.readFileSync(
  path.join(repoRoot, 'infrastructure/docker/admin-nginx.conf'),
  'utf8',
)

const scriptTags = [...entryDocument.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag)

test('the entry document carries no inline script for the CSP to refuse', () => {
  const inline = scriptTags.filter((tag) => !/\ssrc\s*=/.test(tag))
  assert.deepEqual(
    inline,
    [],
    'admin/index.html gained an inline <script>. Production refuses it under ' +
      "`script-src 'self'` — move it to a file under admin/public/ and load it " +
      "with a blocking <script src>, rather than adding 'unsafe-inline' to the CSP.",
  )
})

test('the pre-paint script is loaded same-origin, classic and blocking', () => {
  const boot = scriptTags.find((tag) => tag.includes('/boot-theme.js'))
  assert.ok(boot, 'admin/index.html no longer loads /boot-theme.js before the first paint')
  // A module script is deferred, and an async/defer classic one is too: any of
  // the three loses the race with the first paint, which is the only race this
  // file exists to win.
  assert.doesNotMatch(boot, /type\s*=\s*["']module["']/, '/boot-theme.js must not be a module')
  assert.doesNotMatch(boot, /\s(?:defer|async)\b/, '/boot-theme.js must not defer')
  // Same origin, so `script-src 'self'` covers it.
  assert.match(boot, /src\s*=\s*["']\/boot-theme\.js["']/)
})

test("the CSP still refuses inline script, which is why the file exists", () => {
  const policy = /set\s+\$csp\s+"([^"]+)"/.exec(adminConf)
  assert.ok(policy, 'admin-nginx.conf no longer defines the CSP as `set $csp "…"`')
  const scriptSrc = policy[1]
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'))
  assert.ok(scriptSrc, 'the admin CSP has no script-src directive')
  assert.doesNotMatch(
    scriptSrc,
    /'unsafe-inline'/,
    "the admin `script-src` gained 'unsafe-inline' — the session-token origin that also " +
      'renders email HTML is the last one that should have it',
  )
})

test('the pre-paint script is revalidated, never heuristically cached', () => {
  // Unfingerprinted, like index.html: without an explicit no-cache a browser
  // may hold it for days, pairing a fresh index.html with a stale idea of the
  // person's theme — the flash this whole arrangement removes.
  const location = /location\s*=\s*\/boot-theme\.js\s*\{([^}]+)\}/.exec(adminConf)
  assert.ok(location, 'admin-nginx.conf no longer gives /boot-theme.js a location of its own')
  assert.match(location[1], /add_header\s+Cache-Control\s+"no-cache"/)
})

test('the pre-paint theme list is the full set of concrete themes', () => {
  // The script cannot import THEME_IDS — it runs before the bundle exists — so
  // it restates them. A theme missing from its list paints as `nessie` for one
  // frame and then jumps, which is the bug in miniature.
  const listed = /var themes = \[([^\]]+)\]/.exec(bootScript)
  assert.ok(listed, 'boot-theme.js no longer declares its `themes` array')
  const themes = [...listed[1].matchAll(/'([^']+)'/g)].map(([, id]) => id)
  // `organization` is painted from the cached CSS on its own branch, and
  // `system` is a question rather than a palette.
  const concrete = THEME_IDS.filter((id) => id !== 'organization' && id !== 'system')
  assert.deepEqual([...themes].sort(), [...concrete].sort())
})
