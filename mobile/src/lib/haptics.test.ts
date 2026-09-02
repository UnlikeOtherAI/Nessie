import assert from 'node:assert/strict'
import test from 'node:test'

import { hapticFeedbackFor, isHapticMessage } from './haptics'
import type { NativeShellMessage } from './native-shell-message'

test('isHapticMessage accepts only the haptic bridge type with a known kind', () => {
  assert.equal(isHapticMessage({ type: 'nessie:haptic', haptic: 'light' }), true)
  assert.equal(isHapticMessage({ type: 'nessie:haptic', haptic: 'warning' }), true)
  // Wrong type — a distinct bridge capability, never the generic presentation payload.
  assert.equal(isHapticMessage({ type: 'nessie:route', haptic: 'light' }), false)
  // Missing or unknown kind.
  assert.equal(isHapticMessage({ type: 'nessie:haptic' }), false)
  assert.equal(
    isHapticMessage({ type: 'nessie:haptic', haptic: 'extreme' } as unknown as NativeShellMessage),
    false,
  )
})

// The pure kind-to-family mapping expo-haptics' three functions key off of.
test('hapticFeedbackFor maps every bridge kind to exactly one expo-haptics family', () => {
  assert.deepEqual(hapticFeedbackFor('light'), { family: 'impact', style: 'Light' })
  assert.deepEqual(hapticFeedbackFor('medium'), { family: 'impact', style: 'Medium' })
  assert.deepEqual(hapticFeedbackFor('heavy'), { family: 'impact', style: 'Heavy' })
  assert.deepEqual(hapticFeedbackFor('selection'), { family: 'selection' })
  assert.deepEqual(hapticFeedbackFor('success'), { family: 'notification', outcome: 'Success' })
  assert.deepEqual(hapticFeedbackFor('warning'), { family: 'notification', outcome: 'Warning' })
  assert.deepEqual(hapticFeedbackFor('error'), { family: 'notification', outcome: 'Error' })
})
