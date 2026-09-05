import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPhoneHistoryLedger,
  currentPhoneHistoryEntry,
  previousPhoneHistoryPath,
  recordPhoneHistory,
  resolvePhoneLedgerBackAction,
  resolvePhoneTabPress,
  resolvePhoneTabSelect,
} from '../src/navigation/phone-navigation-ledger'

const ledgerOf = (
  ...events: Array<['PUSH' | 'REPLACE' | 'POP', string, string]>
) => {
  const first = events[0]
  assert.ok(first, 'ledgerOf needs at least one event')
  let ledger = createPhoneHistoryLedger(first[1], first[2])
  for (const [action, key, path] of events.slice(1)) {
    ledger = recordPhoneHistory(ledger, action, key, path)
  }
  return ledger
}

test('a push appends and stores the full pathname+search+hash', () => {
  const ledger = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/channels/chan_a?thread=t1#composer'],
  )
  assert.deepEqual(ledger.entries.map((entry) => entry.key), ['k1', 'k2'])
  assert.equal(ledger.index, 1)
  assert.equal(currentPhoneHistoryEntry(ledger)?.path, '/channels/chan_a?thread=t1#composer')
  assert.equal(previousPhoneHistoryPath(ledger), '/channels')
})

test('re-notifying the same event is idempotent for PUSH, REPLACE and POP', () => {
  const pushed = ledgerOf(['PUSH', 'k1', '/channels'])
  assert.equal(recordPhoneHistory(pushed, 'PUSH', 'k1', '/channels'), pushed)

  const replaced = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['REPLACE', 'k2', '/projects'],
  )
  assert.equal(recordPhoneHistory(replaced, 'REPLACE', 'k2', '/projects'), replaced)

  const popped = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/channels/chan_a'],
    ['POP', 'k1', '/channels'],
  )
  assert.equal(recordPhoneHistory(popped, 'POP', 'k1', '/channels'), popped)
})

test('a known POP moves the index backward and forward without touching entries', () => {
  let ledger = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/channels/chan_a'],
    ['PUSH', 'k3', '/channels/chan_a/info'],
  )
  ledger = recordPhoneHistory(ledger, 'POP', 'k2', '/channels/chan_a')
  assert.equal(ledger.index, 1)
  assert.equal(ledger.entries.length, 3)
  ledger = recordPhoneHistory(ledger, 'POP', 'k1', '/channels')
  assert.equal(ledger.index, 0)
  // Forward again: same mechanism, index-only.
  ledger = recordPhoneHistory(ledger, 'POP', 'k3', '/channels/chan_a/info')
  assert.equal(ledger.index, 2)
  assert.equal(ledger.entries.length, 3)
})

test('a PUSH after Back truncates the abandoned forward entries', () => {
  let ledger = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/channels/chan_a'],
    ['POP', 'k1', '/channels'],
  )
  ledger = recordPhoneHistory(ledger, 'PUSH', 'k3', '/channels/chan_b')
  assert.deepEqual(ledger.entries.map((entry) => entry.key), ['k1', 'k3'])
  assert.equal(ledger.index, 1)
})

test('REPLACE rewrites the entry at the current index', () => {
  let ledger = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/channels/chan_a'],
  )
  ledger = recordPhoneHistory(ledger, 'REPLACE', 'k3', '/channels/chan_b')
  assert.deepEqual(ledger.entries.map((entry) => entry.key), ['k1', 'k3'])
  assert.equal(ledger.index, 1)
  assert.equal(currentPhoneHistoryEntry(ledger)?.path, '/channels/chan_b')
})

test('an unknown POP resets to a single current entry — no invented predecessor', () => {
  let ledger = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/channels/chan_a'],
  )
  // A restored session entry the ledger never saw cannot inherit adjacency:
  // splicing it behind the old current entry would fabricate a Back target.
  ledger = recordPhoneHistory(ledger, 'POP', 'restored', '/projects/proj_a')
  assert.deepEqual(ledger, {
    entries: [{ key: 'restored', path: '/projects/proj_a' }],
    index: 0,
  })
  assert.equal(previousPhoneHistoryPath(ledger), null)
  // Its Back decision therefore falls to the route metadata: a cold parent
  // replace, never a pop onto a fabricated entry.
  assert.deepEqual(resolvePhoneLedgerBackAction(ledger), {
    mode: 'replace',
    to: '/projects',
  })
})

test('a same-document URL state push mints its own entry so Back unwinds it', () => {
  let ledger = ledgerOf(['PUSH', 'k1', '/search'])
  ledger = recordPhoneHistory(ledger, 'PUSH', 'k2', '/search?query=nessie')
  assert.equal(ledger.entries.length, 2)
  ledger = recordPhoneHistory(ledger, 'POP', 'k1', '/search')
  assert.equal(ledger.index, 0)
  assert.equal(currentPhoneHistoryEntry(ledger)?.path, '/search')
})

test('route-level Back pops a parent predecessor, even with URL state on it', () => {
  const ledger = ledgerOf(
    ['PUSH', 'k1', '/channels?filter=unread'],
    ['PUSH', 'k2', '/channels/chan_a'],
  )
  // Parent comparison normalizes: `/channels?filter=unread` is the Channels
  // root, so Back pops real history instead of replacing.
  assert.deepEqual(resolvePhoneLedgerBackAction(ledger), {
    mode: 'pop',
    to: '/channels',
  })
})

test('route-level Back replaces a cold deep link with its semantic parent', () => {
  const ledger = ledgerOf(['PUSH', 'k1', '/projects/proj_a/board'])
  assert.deepEqual(resolvePhoneLedgerBackAction(ledger), {
    mode: 'replace',
    to: '/projects',
  })
})

test('route-level Back is null at a tab root', () => {
  const ledger = ledgerOf(['PUSH', 'k1', '/channels'])
  assert.equal(resolvePhoneLedgerBackAction(ledger), null)
})

test('reselecting the active tab: no-op at root, pop from a detail above it', () => {
  const atRoot = ledgerOf(['PUSH', 'k1', '/knowledge-base'])
  assert.deepEqual(resolvePhoneTabPress(atRoot), { type: 'none' })

  const aboveRoot = ledgerOf(
    ['PUSH', 'k1', '/knowledge-base'],
    ['PUSH', 'k2', '/knowledge-base/spaces/space_a'],
  )
  assert.deepEqual(resolvePhoneTabPress(aboveRoot), { type: 'pop' })
})

test('reselecting the active tab replaces when the root is not the entry behind', () => {
  // Arrived at a Knowledge detail from Channels: the root is not the previous
  // entry, so pop would leave the section — replace instead.
  const ledger = ledgerOf(
    ['PUSH', 'k1', '/channels'],
    ['PUSH', 'k2', '/knowledge-base/spaces/space_a'],
  )
  assert.deepEqual(resolvePhoneTabPress(ledger), {
    type: 'replace',
    root: '/knowledge-base',
  })
})

test('selecting another tab pushes its root; the active tab reselects', () => {
  const ledger = ledgerOf(['PUSH', 'k1', '/channels'])
  assert.deepEqual(resolvePhoneTabSelect(ledger, '/projects'), {
    type: 'push',
    root: '/projects',
  })
  assert.deepEqual(resolvePhoneTabSelect(ledger, '/channels'), { type: 'none' })
})

test('selecting the tab whose root carries URL state replaces, never duplicates', () => {
  // A cold restored location with query state on the root: reselecting that
  // tab must not stack a duplicate of itself.
  const ledger = ledgerOf(['POP', 'restored', '/channels?filter=unread'])
  assert.deepEqual(resolvePhoneTabSelect(ledger, '/channels'), { type: 'none' })
  // Standing on a detail reached straight from outside, reselect pops only
  // when the root is the entry behind; otherwise it replaces with the root.
  const fromDetail = ledgerOf(
    ['PUSH', 'k1', '/channels?filter=unread'],
    ['PUSH', 'k2', '/channels/chan_a'],
  )
  assert.deepEqual(resolvePhoneTabSelect(fromDetail, '/channels'), { type: 'pop' })
})
