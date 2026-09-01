import assert from 'node:assert/strict'
import test from 'node:test'
import { allowsNativeBackForwardGestures } from './webview-back-gesture'

test('phones never get the native back/forward gesture', () => {
  // iPhone portrait and landscape.
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 393, heightDp: 852 }), false)
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 852, heightDp: 393 }), false)
  // Android phone portrait and landscape.
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 412, heightDp: 915 }), false)
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 915, heightDp: 412 }), false)
})

test('tablets keep the native gesture only when both dimensions pass 600', () => {
  // iPad portrait and landscape.
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 820, heightDp: 1180 }), true)
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 1180, heightDp: 820 }), true)
  // Android tablet.
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 800, heightDp: 1280 }), true)
  // Exactly at the threshold counts as tablet.
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 600, heightDp: 600 }), true)
})

test('one phone-sized dimension is enough to disable the native gesture', () => {
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 599, heightDp: 1200 }), false)
  assert.equal(allowsNativeBackForwardGestures({ widthDp: 1200, heightDp: 599 }), false)
})
