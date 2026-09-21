import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTokenRows,
  decideTokenKey,
  exactOptionMatch,
  type TokenInputOption,
  type TokenInputToken,
  type TokenKeyState,
} from '../src/components/primitives/token-input-keys.js'

/**
 * The token field's key table (ui.md §5.7), one row per case. The component
 * applies whatever `decideTokenKey` answers, so this table is the behaviour.
 */

const OPTIONS: TokenInputOption[] = [
  { id: 'bug', label: 'Bug' },
  { id: 'perf', label: 'Performance' },
  { id: 'ux', label: 'UX' },
  { id: 'linear', label: 'Linear-owned', disabled: true, title: 'Linear owns this label' },
]

const state = (overrides: Partial<TokenKeyState> = {}): TokenKeyState => {
  const tokens: TokenInputToken[] = overrides.tokens ?? [{ id: 'bug', label: 'Bug' }]
  const query = overrides.query ?? ''
  const canCreate = overrides.canCreate ?? true
  const options = overrides.options ?? OPTIONS
  return {
    activeIndex: null,
    highlightedTokenId: null,
    open: true,
    ...overrides,
    canCreate,
    options,
    query,
    rows: overrides.rows
      ?? buildTokenRows({ canCreate, options, query, selectedIds: tokens.map((token) => token.id) }),
    tokens,
  }
}

test('rows list every option, chosen ones first and marked, in the options’ own order', () => {
  const rows = buildTokenRows({ canCreate: true, options: OPTIONS, query: '', selectedIds: ['ux', 'bug'] })
  assert.deepEqual(
    rows.map((row) => (row.kind === 'option' ? `${row.option.id}:${row.selected}` : 'create')),
    ['bug:true', 'ux:true', 'perf:false', 'linear:false'],
  )
})

test('typing filters by case-insensitive substring', () => {
  const rows = buildTokenRows({ canCreate: false, options: OPTIONS, query: 'U', selectedIds: [] })
  assert.deepEqual(rows.map((row) => row.kind === 'option' && row.option.id), ['bug', 'ux'])
})

test('the create row is last when something matches and first when nothing does', () => {
  const some = buildTokenRows({ canCreate: true, options: OPTIONS, query: 'perf', selectedIds: [] })
  assert.deepEqual(some.map((row) => row.kind), ['option', 'create'])
  assert.deepEqual(some.at(-1), { kind: 'create', text: 'perf' })

  const none = buildTokenRows({ canCreate: true, options: OPTIONS, query: '  Flaky ', selectedIds: [] })
  assert.deepEqual(none, [{ kind: 'create', text: 'Flaky' }])
})

test('no create row for an exact (normalised) match, empty text, or when creation is off', () => {
  for (const query of ['bug', ' BUG ', '']) {
    const rows = buildTokenRows({ canCreate: true, options: OPTIONS, query, selectedIds: [] })
    assert.ok(rows.every((row) => row.kind === 'option'), `query ${JSON.stringify(query)}`)
  }
  const off = buildTokenRows({ canCreate: false, options: OPTIONS, query: 'zzz', selectedIds: [] })
  assert.deepEqual(off, [])
  assert.equal(exactOptionMatch(OPTIONS, ' ux ')?.id, 'ux')
})

test('ArrowDown and ArrowUp move the active row, wrapping at both ends', () => {
  const s = state()
  const last = s.rows.length - 1
  assert.deepEqual(decideTokenKey('ArrowDown', s).action, { type: 'move', activeIndex: 0 })
  assert.deepEqual(decideTokenKey('ArrowUp', s).action, { type: 'move', activeIndex: last })
  assert.deepEqual(decideTokenKey('ArrowDown', state({ activeIndex: 1 })).action, { type: 'move', activeIndex: 2 })
  assert.deepEqual(decideTokenKey('ArrowDown', state({ activeIndex: last })).action, { type: 'move', activeIndex: 0 })
  assert.deepEqual(decideTokenKey('ArrowUp', state({ activeIndex: 0 })).action, { type: 'move', activeIndex: last })
  assert.equal(decideTokenKey('ArrowDown', s).preventDefault, true)
})

test('an arrow on a closed field opens it on the first or last row', () => {
  assert.deepEqual(decideTokenKey('ArrowDown', state({ open: false })).action, { type: 'open', activeIndex: 0 })
  const closed = state({ open: false })
  assert.deepEqual(decideTokenKey('ArrowUp', closed).action, { type: 'open', activeIndex: closed.rows.length - 1 })
})

test('Enter selects the active row — toggling a chosen one off', () => {
  // rows: bug (chosen), perf, ux, linear
  assert.deepEqual(decideTokenKey('Enter', state({ activeIndex: 1 })).action, { type: 'toggle', id: 'perf' })
  assert.deepEqual(decideTokenKey('Enter', state({ activeIndex: 0 })).action, { type: 'toggle', id: 'bug' })
  assert.equal(decideTokenKey('Enter', state({ activeIndex: 1 })).preventDefault, true)
})

test('Enter on a disabled row does nothing, and never submits the form', () => {
  const decision = decideTokenKey('Enter', state({ activeIndex: 3 }))
  assert.deepEqual(decision.action, { type: 'none' })
  assert.equal(decision.preventDefault, true)
})

test('Enter on the active create row creates', () => {
  const s = state({ query: 'perfo', activeIndex: 1 })
  assert.equal(s.rows[1]?.kind, 'create')
  assert.deepEqual(decideTokenKey('Enter', s).action, { type: 'create', text: 'perfo' })
})

test('Enter with no active row and no exact match creates the typed text', () => {
  assert.deepEqual(decideTokenKey('Enter', state({ query: ' flaky ' })).action, { type: 'create', text: 'flaky' })
})

test('Enter with no active row and an exact match selects it (never toggles it off)', () => {
  assert.deepEqual(decideTokenKey('Enter', state({ query: 'ux' })).action, { type: 'add', id: 'ux' })
  assert.deepEqual(decideTokenKey('Enter', state({ query: 'BUG' })).action, { type: 'add', id: 'bug' })
})

test('Enter with no active row, no text, or creation off, does nothing', () => {
  assert.deepEqual(decideTokenKey('Enter', state()).action, { type: 'none' })
  assert.deepEqual(decideTokenKey('Enter', state({ canCreate: false, query: 'flaky' })).action, { type: 'none' })
})

test('a comma behaves exactly as Enter, and is never typed', () => {
  for (const s of [state({ activeIndex: 1 }), state({ query: 'flaky' }), state({ query: 'ux' }), state()]) {
    const comma = decideTokenKey(',', s)
    assert.deepEqual(comma, decideTokenKey('Enter', s))
    assert.equal(comma.preventDefault, true)
  }
})

test('Backspace on an empty input highlights the last pill, and a second press removes it', () => {
  const tokens = [{ id: 'bug', label: 'Bug' }, { id: 'ux', label: 'UX' }]
  const first = decideTokenKey('Backspace', state({ tokens }))
  assert.deepEqual(first.action, { type: 'highlight-token', id: 'ux' })
  const second = decideTokenKey('Backspace', state({ tokens, highlightedTokenId: 'ux' }))
  assert.deepEqual(second.action, { type: 'remove-token', id: 'ux' })
})

test('Backspace with text edits the text; with no pills it does nothing', () => {
  assert.deepEqual(decideTokenKey('Backspace', state({ query: 'pe' })), {
    action: { type: 'none' },
    preventDefault: false,
    stopPropagation: false,
  })
  assert.deepEqual(decideTokenKey('Backspace', state({ tokens: [] })).action, { type: 'none' })
})

test('Backspace skips a pill the viewer may not remove', () => {
  const tokens = [{ id: 'bug', label: 'Bug' }, { id: 'linear', label: 'Linear-owned', removable: false }]
  assert.deepEqual(decideTokenKey('Backspace', state({ tokens })).action, { type: 'highlight-token', id: 'bug' })
  assert.deepEqual(
    decideTokenKey('Backspace', state({ tokens: [tokens[1]!] })).action,
    { type: 'none' },
  )
})

test('Escape closes an open list and stops there; on a closed list it reaches the dialog', () => {
  assert.deepEqual(decideTokenKey('Escape', state()), {
    action: { type: 'close' },
    preventDefault: true,
    stopPropagation: true,
  })
  assert.deepEqual(decideTokenKey('Escape', state({ open: false })), {
    action: { type: 'none' },
    preventDefault: false,
    stopPropagation: false,
  })
})

test('Tab closes the list and still moves focus on', () => {
  assert.deepEqual(decideTokenKey('Tab', state()), {
    action: { type: 'close' },
    preventDefault: false,
    stopPropagation: false,
  })
  assert.deepEqual(decideTokenKey('Tab', state({ open: false })).action, { type: 'none' })
})

test('any other key is left to the input', () => {
  for (const key of ['a', 'ArrowLeft', 'Home', ' ']) {
    assert.deepEqual(decideTokenKey(key, state()), {
      action: { type: 'none' },
      preventDefault: false,
      stopPropagation: false,
    })
  }
})
