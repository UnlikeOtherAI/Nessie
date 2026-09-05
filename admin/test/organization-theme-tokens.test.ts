import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { THEME_TOKENS } from '@nessie/schemas'

/**
 * The derivation and the stylesheet must declare the same tokens.
 *
 * Adding a token to the built-in themes without a rule in
 * `organization-theme.ts` would leave an organisation palette rendering it as
 * the `@property` registration's `initial-value: #000000` — black, silently, on
 * whichever surface used it. This turns that into a failing build.
 */
const styles = readFileSync(
  fileURLToPath(new URL('../src/styles.css', import.meta.url)),
  'utf8',
)

const tokensIn = (selector: string): Set<string> => {
  const start = styles.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} not found in styles.css`)
  const block = styles.slice(start, styles.indexOf('\n}', start))
  return new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]!))
}

test('THEME_TOKENS is exactly what a [data-theme] block redeclares', () => {
  const declared = tokensIn('[data-theme="midnight"]')
  const derived = new Set<string>(THEME_TOKENS)

  const missing = [...declared].filter((token) => !derived.has(token))
  const extra = [...derived].filter((token) => !declared.has(token))

  assert.deepEqual(missing, [], `styles.css declares tokens the derivation has no rule for: ${missing}`)
  assert.deepEqual(extra, [], `the derivation emits tokens no theme block declares: ${extra}`)
})

test('every built-in theme block declares the same set', () => {
  const expected = new Set<string>(THEME_TOKENS)
  for (const theme of [
    'midnight', 'daylight', 'forest', 'ocean', 'sunset', 'rose', 'graphite', 'sandstone', 'contrast',
  ]) {
    assert.deepEqual(tokensIn(`[data-theme="${theme}"]`), expected, `[data-theme="${theme}"]`)
  }
})
