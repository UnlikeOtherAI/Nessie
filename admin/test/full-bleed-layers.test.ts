import assert from 'node:assert/strict'
import test from 'node:test'

import {
  holdNativeChromeSuspended,
  nativeChromeSuspended,
  subscribeNativeChromeSuspended,
} from '../src/navigation/full-bleed-layers'

/**
 * The iPad shell draws its creation control over the list column the web
 * publishes, and native chrome cannot see a web overlay. Over a full-screen
 * browser the `+` was a button for a column that was no longer on screen.
 */
// The admin suite runs without test isolation, so these read the count's
// edges rather than assuming the module starts at zero.
test('a full-bleed layer suspends the native chrome, and releasing restores it', () => {
  const before = nativeChromeSuspended()
  const release = holdNativeChromeSuspended()
  assert.equal(nativeChromeSuspended(), true)
  release()
  assert.equal(nativeChromeSuspended(), before)
})

test('nested layers keep the chrome suspended until the last one goes', () => {
  const before = nativeChromeSuspended()
  const outer = holdNativeChromeSuspended()
  const inner = holdNativeChromeSuspended()
  inner()
  assert.equal(nativeChromeSuspended(), true, 'a dialog closing must not un-suspend its host')
  outer()
  assert.equal(nativeChromeSuspended(), before)
})

test('releasing twice does not drop somebody else’s layer', () => {
  const before = nativeChromeSuspended()
  const first = holdNativeChromeSuspended()
  first()
  first()
  const second = holdNativeChromeSuspended()
  assert.equal(nativeChromeSuspended(), true)
  second()
  assert.equal(nativeChromeSuspended(), before)
})

test('subscribers are told on both edges', () => {
  const seen: boolean[] = []
  const unsubscribe = subscribeNativeChromeSuspended((suspended) => seen.push(suspended))
  const release = holdNativeChromeSuspended()
  release()
  unsubscribe()
  holdNativeChromeSuspended()()
  assert.deepEqual(seen, [true, false], 'an unsubscribed listener must stop hearing')
})
