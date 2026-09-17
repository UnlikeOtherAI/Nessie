import assert from 'node:assert/strict'
import test from 'node:test'
import { columnTrackOffsetPx } from '../src/components/shared/column-browser/ColumnBrowserViewport'
import {
  clampColumnWidth,
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  parseFinderColumnWidths,
  readFinderColumnWidths,
  resolveFinderColumnWidth,
  withFinderColumnWidth,
} from '../src/components/features/knowledge/finder/finder-view'
import { getStoredJson, setStoredJson } from '../src/lib/storage'

/**
 * Per-slot column widths (browser-ui.md §2). The store is one JSON object in
 * localStorage keyed by position — root, virtual, depth:0, … — read back
 * through the clamp, migrated from the retired single-width cookie, and
 * tolerant of a store that throws (a private window must still render).
 */

const withLocalStorage = (stub: unknown, run: () => void): void => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: stub,
    writable: true,
  })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
}

test('a stored width is clamped back into range, so a hand edit cannot make a 4px column', () => {
  assert.equal(clampColumnWidth(4), MIN_COLUMN_WIDTH)
  assert.equal(clampColumnWidth(99_999), MAX_COLUMN_WIDTH)
  assert.deepEqual(
    parseFinderColumnWidths({ root: 4, 'depth:1': 99_999 }),
    { root: MIN_COLUMN_WIDTH, 'depth:1': MAX_COLUMN_WIDTH },
  )
})

test('the store keeps only bounded slots and real numbers', () => {
  assert.deepEqual(
    parseFinderColumnWidths({
      'depth:0': 400,
      'depth:12': 360,
      root: 320,
      virtual: 500,
      // A page or space id must never become a key: the map would grow one
      // entry per folder anybody ever opened.
      'space:abc': 400,
      'depth:abc': 400,
      'folder:123': 400,
      'depth:-1': 400,
      junk: 'wide',
      'depth:2': 'wide',
      'depth:3': Number.NaN,
      'depth:4': -50,
    }),
    { root: 320, virtual: 500, 'depth:0': 400, 'depth:12': 360 },
  )
  assert.deepEqual(parseFinderColumnWidths(null), {})
  assert.deepEqual(parseFinderColumnWidths('wide'), {})
  assert.deepEqual(parseFinderColumnWidths([320, 400]), {})
})

test('a slot resolves live drag, then stored width, then the legacy cookie width', () => {
  const legacy = 456
  // No stored value: the retired cookie's width is the starting point.
  assert.equal(resolveFinderColumnWidth({}, {}, legacy, 'depth:0'), legacy)
  // A stored slot wins over the cookie; other slots still fall back.
  assert.equal(resolveFinderColumnWidth({ 'depth:0': 380 }, {}, legacy, 'depth:0'), 380)
  assert.equal(resolveFinderColumnWidth({ 'depth:0': 380 }, {}, legacy, 'depth:1'), legacy)
  // An in-progress drag wins over both, committed or not.
  assert.equal(resolveFinderColumnWidth({ 'depth:0': 380 }, { 'depth:0': 512 }, legacy, 'depth:0'), 512)
  // Slots are independent: widening one column moves no other.
  assert.equal(resolveFinderColumnWidth({}, { root: 700 }, legacy, 'virtual'), legacy)
})

test('the commit write merges one slot into the stored map, clamped', () => {
  assert.deepEqual(
    withFinderColumnWidth({ root: 400 }, 'depth:2', 10_000),
    { root: 400, 'depth:2': MAX_COLUMN_WIDTH },
  )
})

test('the track offset is the sum of the widths before startIndex, not a multiple of one', () => {
  const widths = [320, 460, 380, 500]
  assert.equal(columnTrackOffsetPx(widths, 0), 0)
  assert.equal(columnTrackOffsetPx(widths, 1), 320)
  // Unequal columns: a shared-width multiply would read 640 here and drift.
  assert.equal(columnTrackOffsetPx(widths, 2), 780)
  assert.equal(columnTrackOffsetPx(widths, 3), 1160)
  assert.equal(columnTrackOffsetPx(widths, 4), 1660)
})

test('a throwing localStorage still renders: reads answer nothing, writes are lost quietly', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
  }
  withLocalStorage(throwing, () => {
    assert.equal(getStoredJson('nessie.admin.knowledgeColumnWidths'), null)
    assert.deepEqual(readFinderColumnWidths(), {})
    assert.doesNotThrow(() => setStoredJson('nessie.admin.knowledgeColumnWidths', { root: 400 }))
  })
})

test('a missing localStorage reads as the default, never a crash', () => {
  withLocalStorage(undefined, () => {
    assert.deepEqual(readFinderColumnWidths(), {})
    assert.equal(resolveFinderColumnWidth(readFinderColumnWidths(), {}, DEFAULT_COLUMN_WIDTH, 'root'), DEFAULT_COLUMN_WIDTH)
  })
})

test('a malformed stored document parses as an empty map', () => {
  const store = new Map<string, string>([
    ['nessie.admin.knowledgeColumnWidths', '{not json'],
  ])
  withLocalStorage({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }, () => {
    assert.deepEqual(readFinderColumnWidths(), {})
    store.set('nessie.admin.knowledgeColumnWidths', JSON.stringify({ root: 380, 'space:x': 999 }))
    assert.deepEqual(readFinderColumnWidths(), { root: 380 })
  })
})
