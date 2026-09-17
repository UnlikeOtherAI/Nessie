import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { finderClickOpens } from '../src/components/features/knowledge/finder/FinderRow'

/**
 * One tap opens (browser-ui.md §7). The double-click gate existed so a
 * selection could be extended without opening five documents on the way;
 * removing the gate must not lose the modifier rule, and a double-click must
 * not open the same thing twice.
 */

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const click = (overrides: Partial<{
  ctrlKey: boolean
  detail: number
  metaKey: boolean
  shiftKey: boolean
}> = {}) => ({
  ctrlKey: false,
  detail: 1,
  metaKey: false,
  shiftKey: false,
  ...overrides,
})

test('a plain click opens any row', () => {
  assert.equal(finderClickOpens(click()), true)
})

test('a click carrying a selection modifier selects without opening', () => {
  assert.equal(finderClickOpens(click({ metaKey: true })), false)
  assert.equal(finderClickOpens(click({ ctrlKey: true })), false)
  assert.equal(finderClickOpens(click({ shiftKey: true })), false)
})

test('the second click of a double-click does not open again', () => {
  // The first click (detail 1) already opened; detail 2 is the same gesture.
  assert.equal(finderClickOpens(click({ detail: 2 })), false)
})

test('the gate is the modifier rule, not the row kind', () => {
  const row = readSource('../src/components/features/knowledge/finder/FinderRow.tsx')
  // The old gate opened on single click only for root rows and folders.
  assert.doesNotMatch(row, /variant === 'root' \|\| kind === 'folder'/)
  assert.match(row, /if \(onOpen && finderClickOpens\(event\)\) onOpen\(\)/)
  // No second open path: nothing binds dblclick to opening any more.
  assert.doesNotMatch(row, /onDoubleClick/)
})
