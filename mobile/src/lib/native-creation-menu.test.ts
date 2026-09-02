import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_CREATION_OPTIONS,
  shouldDismissNativeCreationMenu,
} from './native-creation-menu'

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
