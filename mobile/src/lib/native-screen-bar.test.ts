import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nativeScreenBarDisabledIndices,
  nativeScreenBarSheetLabels,
  partitionNativeScreenBarActions,
} from './native-screen-bar'
import type { NativeScreenBarAction } from './native-shell-layout'

const action = (overrides: Partial<NativeScreenBarAction>): NativeScreenBarAction => ({
  checked: null,
  disabled: false,
  id: 'id',
  items: null,
  kind: 'button',
  label: 'Label',
  primary: false,
  priority: 10,
  selected: false,
  tone: null,
  ...overrides,
})

test('the bar keeps the primary action and sheets the rest, highest priority first', () => {
  const { overflow, primary } = partitionNativeScreenBarActions([
    action({ id: 'star', label: 'Star', priority: 20 }),
    action({ id: 'save', label: 'Save', primary: true, priority: 100 }),
    action({ id: 'settings', label: 'Settings', priority: 60 }),
  ])
  assert.equal(primary?.id, 'save')
  // The web header sheds its lowest-priority actions to overflow first, so the
  // highest priority reads first here too.
  assert.deepEqual(overflow.map((entry) => entry.id), ['settings', 'star'])
})

test('nothing is ever dropped — every action reaches the bar or the sheet', () => {
  const actions = [
    action({ id: 'a', priority: 1 }),
    action({ id: 'b', primary: true, priority: 2 }),
    action({ id: 'c', disabled: true, priority: 3 }),
    action({ id: 'd', kind: 'menu', items: [], priority: 4 }),
  ]
  const { overflow, primary } = partitionNativeScreenBarActions(actions)
  const reachable = new Set([...(primary ? [primary.id] : []), ...overflow.map((e) => e.id)])
  assert.deepEqual([...reachable].sort(), ['a', 'b', 'c', 'd'])
})

test('a disabled primary action does not claim the bar slot and stays reachable', () => {
  // A control that vanishes when it cannot be used is a control nobody can
  // find; it belongs in the sheet, greyed, not gone.
  const { overflow, primary } = partitionNativeScreenBarActions([
    action({ disabled: true, id: 'save', primary: true, priority: 100 }),
  ])
  assert.equal(primary, null)
  assert.deepEqual(overflow.map((entry) => entry.id), ['save'])
  assert.deepEqual(nativeScreenBarDisabledIndices(overflow), [0])
})

test('the sheet lists labels, marks a checked toggle, and always offers Cancel', () => {
  const labels = nativeScreenBarSheetLabels([
    action({ checked: true, id: 'notify', kind: 'toggle', label: 'Notifications' }),
    action({ id: 'archive', label: 'Archive' }),
  ])
  assert.deepEqual(labels, ['✓ Notifications', 'Archive', 'Cancel'])
})

test('an empty action list leaves the bar with nothing to draw', () => {
  const { overflow, primary } = partitionNativeScreenBarActions([])
  assert.equal(primary, null)
  assert.deepEqual(overflow, [])
  assert.deepEqual(nativeScreenBarSheetLabels([]), ['Cancel'])
})
