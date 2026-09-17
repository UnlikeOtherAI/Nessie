import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_CREATION_ACTION_SIZE,
  NATIVE_CREATION_OPTIONS,
  NATIVE_CREATION_OPTION_COLORS,
  nativeCreationMenuMetrics,
  shouldDismissNativeCreationMenu,
} from './native-creation-menu'

test('every creation row paints the web create menu hue pair, not the theme accent', () => {
  // Mirrored from `.create-menu-icon-<kind>` in admin/src/styles.css: the badge
  // is the hue washed over the sheet at the web's own percentage, the glyph a
  // darker shade of that hue. Message stays on the theme accent and is never
  // a row, so it has no pair here.
  assert.deepEqual(NATIVE_CREATION_OPTION_COLORS, {
    project: { glyph: '#a96400', wash: '#d98600', washOpacity: 0.19 },
    channel: { glyph: '#258143', wash: '#3ba55c', washOpacity: 0.19 },
    agent: { glyph: '#5b3ed6', wash: '#7a5af8', washOpacity: 0.18 },
  })
  for (const option of NATIVE_CREATION_OPTIONS) {
    assert.ok(
      NATIVE_CREATION_OPTION_COLORS[option.action],
      `${option.action} has a colour pair`,
    )
  }
})

test('the phone sheet offers Agent last, directly above the Message button', () => {
  assert.deepEqual(
    NATIVE_CREATION_OPTIONS.map((option) => option.action),
    ['project', 'channel', 'agent'],
  )
  // Message is the morphing compose button, never a row in the list.
  assert.equal(
    NATIVE_CREATION_OPTIONS.some((option) => (option.action as string) === 'message'),
    false,
  )
  assert.deepEqual(NATIVE_CREATION_OPTIONS.at(-1), {
    accessibilityLabel: 'Create agent',
    action: 'agent',
    description: 'Design a new agent',
    icon: 'smart-toy',
    title: 'Agent',
  })
})

test('a creation sheet stays open until an external menu dismissal arrives', () => {
  assert.equal(shouldDismissNativeCreationMenu({
    creationOpen: true,
    dismissVersion: 0,
    previousDismissVersion: 0,
  }), false)
  assert.equal(shouldDismissNativeCreationMenu({
    creationOpen: true,
    dismissVersion: 1,
    previousDismissVersion: 0,
  }), true)
  assert.equal(shouldDismissNativeCreationMenu({
    creationOpen: false,
    dismissVersion: 1,
    previousDismissVersion: 0,
  }), false)
})

test('the creation control lays out inside whichever lane it is given', () => {
  // A phone's lane is the whole screen: the compose circle stands 18pt above
  // the tab bar, and the Message row it becomes spans the sheet's inner width.
  assert.deepEqual(nativeCreationMenuMetrics({ bottom: 83, left: 16, right: 16 }, 393), {
    collapsedBottom: 101,
    collapsedRight: 22,
    expandedBottom: 99,
    expandedRight: 24,
    messageActionWidth: 345,
    sheetBottom: 91,
  })
  // An iPad's lane is its pinned list column, so the same control lands
  // against the column's own trailing edge rather than the window's.
  assert.deepEqual(nativeCreationMenuMetrics({ bottom: 24, left: 16, right: 764 }, 1024), {
    collapsedBottom: 42,
    collapsedRight: 770,
    expandedBottom: 40,
    expandedRight: 772,
    messageActionWidth: 228,
    sheetBottom: 32,
  })
  // A lane narrower than the compose circle keeps the circle's size rather
  // than collapsing the Message row to nothing.
  assert.equal(
    nativeCreationMenuMetrics({ bottom: 0, left: 16, right: 940 }, 1024).messageActionWidth,
    NATIVE_CREATION_ACTION_SIZE,
  )
})
