import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyIpadKeyCommandAction,
  IPAD_KEY_COMMANDS,
  keyCommandModifierBitmask,
  resolveIpadKeyCommandAction,
  serializeIpadKeyCommandsForNative,
  type IpadKeyCommandAction,
  type IpadKeyCommandHandlers,
} from './ipad-key-commands'

const noopHandlers = (): IpadKeyCommandHandlers & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    selectTabIndex: (index) => calls.push(`selectTabIndex:${index}`),
    openSearch: () => calls.push('openSearch'),
    openCreationMenu: () => calls.push('openCreationMenu'),
    goBack: () => calls.push('goBack'),
    goForward: () => calls.push('goForward'),
    reload: () => calls.push('reload'),
  }
}

const perform = (action: IpadKeyCommandAction, activeIndex: number): string[] => {
  const handlers = noopHandlers()
  applyIpadKeyCommandAction(action, handlers, { activeIndex })
  return handlers.calls
}

test('the modifier bitmask matches the raw UIKeyModifierFlags values', () => {
  assert.equal(keyCommandModifierBitmask(['command']), 1 << 20)
  assert.equal(keyCommandModifierBitmask(['control']), 1 << 18)
  assert.equal(keyCommandModifierBitmask(['control', 'shift']), (1 << 18) | (1 << 17))
  assert.equal(keyCommandModifierBitmask([]), 0)
})

test('every serialized command carries a non-empty title and a command/control modifier', () => {
  const rows = serializeIpadKeyCommandsForNative()
  assert.equal(rows.length, IPAD_KEY_COMMANDS.length)
  for (const row of rows) {
    assert.ok(row.title.length > 0, `${row.id} has a title for the ⌘ overlay`)
    assert.ok(row.input.length > 0, `${row.id} has an input key`)
    // A bare printable key with no modifier would fire while typing; every
    // command must hold at least one modifier.
    assert.ok(row.modifierFlags > 0, `${row.id} requires a modifier`)
  }
})

test('command ids are unique, and (input, modifiers) pairs do not collide', () => {
  const ids = new Set<string>()
  const chords = new Set<string>()
  for (const command of IPAD_KEY_COMMANDS) {
    assert.ok(!ids.has(command.id), `duplicate id ${command.id}`)
    ids.add(command.id)
    const chord = `${command.input}:${keyCommandModifierBitmask(command.modifiers)}`
    assert.ok(!chords.has(chord), `two commands share the chord ${chord}`)
    chords.add(chord)
  }
})

test('a known id resolves to its action; an unknown id is ignored, not thrown', () => {
  assert.deepEqual(resolveIpadKeyCommandAction('search'), { kind: 'search' })
  assert.deepEqual(resolveIpadKeyCommandAction('tab-channels'), {
    kind: 'select-tab',
    tabKey: 'channels',
  })
  assert.equal(resolveIpadKeyCommandAction('a-future-command'), null)
})

test('⌘1–⌘4 select their destination by bar index', () => {
  assert.deepEqual(perform({ kind: 'select-tab', tabKey: 'channels' }, 2), ['selectTabIndex:0'])
  assert.deepEqual(perform({ kind: 'select-tab', tabKey: 'admin' }, 0), ['selectTabIndex:3'])
})

test('cycling forward wraps from the last destination back to the first', () => {
  // admin (bar 3) + next → channels (bar 0)
  assert.deepEqual(perform({ kind: 'cycle-tab', delta: 1 }, 3), ['selectTabIndex:0'])
})

test('cycling backward wraps from the first destination to the last', () => {
  // channels (bar 0) + prev → admin (bar 3)
  assert.deepEqual(perform({ kind: 'cycle-tab', delta: -1 }, 0), ['selectTabIndex:3'])
})

test('cycling never lands on Search, which is an overlay and not a destination', () => {
  // From every starting index, cycling in either direction stays in 0..3.
  for (let activeIndex = 0; activeIndex < 5; activeIndex += 1) {
    for (const delta of [1, -1] as const) {
      const calls = perform({ kind: 'cycle-tab', delta }, activeIndex)
      assert.equal(calls.length, 1)
      const index = Number(calls[0]?.split(':')[1])
      assert.ok(index >= 0 && index <= 3, `cycle from ${activeIndex} by ${delta} landed on ${index}`)
    }
  }
})

test('cycling from the Search overlay re-enters the destinations rather than doing nothing', () => {
  const forward = perform({ kind: 'cycle-tab', delta: 1 }, 4)
  assert.equal(forward.length, 1)
  assert.notEqual(forward[0], 'selectTabIndex:4')
})

test('the action verbs route to their handler and nothing else', () => {
  assert.deepEqual(perform({ kind: 'search' }, 0), ['openSearch'])
  assert.deepEqual(perform({ kind: 'create' }, 0), ['openCreationMenu'])
  assert.deepEqual(perform({ kind: 'back' }, 0), ['goBack'])
  assert.deepEqual(perform({ kind: 'forward' }, 0), ['goForward'])
  assert.deepEqual(perform({ kind: 'refresh' }, 0), ['reload'])
})
