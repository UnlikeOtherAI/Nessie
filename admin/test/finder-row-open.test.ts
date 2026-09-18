import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  finderClickOpens,
  finderRowOpenGesture,
} from '../src/components/features/knowledge/finder/FinderRow'

/**
 * Which tap opens a row (browser-ui.md §7).
 *
 * One tap on the web and on a phone: the double-click gate existed so a
 * selection could be extended without opening five documents on the way, and
 * removing it must not lose the modifier rule. Two taps on the desktop shell,
 * for documents only, because there the open is a window of its own and the
 * first tap has to be allowed to mean "this one".
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

test('on the double-tap gesture the first click only selects', () => {
  assert.equal(finderClickOpens(click({ detail: 1 }), 'double'), false)
  assert.equal(finderClickOpens(click({ detail: 2 }), 'double'), true)
})

test('a third click does not open a second window', () => {
  assert.equal(finderClickOpens(click({ detail: 3 }), 'double'), false)
})

test('the modifier rule outranks the gesture', () => {
  // Cmd-double-clicking through a selection must extend it, not open six
  // windows on the way.
  assert.equal(finderClickOpens(click({ detail: 2, metaKey: true }), 'double'), false)
  assert.equal(finderClickOpens(click({ detail: 2, shiftKey: true }), 'double'), false)
})

test('only a document asks for two taps, and only on the desktop', () => {
  for (const kind of ['document', 'file', 'spreadsheet'] as const) {
    assert.equal(finderRowOpenGesture(kind, true), 'double')
    assert.equal(finderRowOpenGesture(kind, false), 'single')
  }
  // A folder, a space and the root's rows move the browser rather than open
  // anything, so they keep one tap on every platform — the way macOS Finder's
  // own columns view works.
  for (const kind of ['folder', 'space', 'virtual', 'link'] as const) {
    assert.equal(finderRowOpenGesture(kind, true), 'single')
    assert.equal(finderRowOpenGesture(kind, false), 'single')
  }
  assert.equal(finderRowOpenGesture(undefined, true), 'single')
})

test('the gate is the modifier rule and the gesture, not the row kind', () => {
  const row = readSource('../src/components/features/knowledge/finder/FinderRow.tsx')
  // The original gate opened on single click only for root rows and folders.
  assert.doesNotMatch(row, /variant === 'root' \|\| kind === 'folder'/)
  assert.match(row, /if \(onOpen && finderClickOpens\(event, opensOn\)\) onOpen\(\)/)
  // The gesture is still decided by one click handler reading `detail`. A
  // `dblclick` listener beside it would fire *after* that handler has already
  // seen detail 2, so the same double-tap would open twice.
  assert.doesNotMatch(row, /onDoubleClick/)
})
