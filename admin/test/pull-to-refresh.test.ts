import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  FEED_MARKER,
  PULL_THRESHOLD_PX,
  createPullGesture,
  scrollerCanRefresh,
} from '../src/navigation/pull-to-refresh'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('a pull arms only from the top, rubber-bands, and refreshes past the threshold', () => {
  const gesture = createPullGesture()
  gesture.start(100, 40)
  assert.equal(gesture.move(300), null, 'not at the top: no pull')
  assert.equal(gesture.end(), 'cancel')

  gesture.start(100, 0)
  assert.equal(gesture.move(60), 0, 'an upward drag is not a pull')
  assert.equal(gesture.move(100 + PULL_THRESHOLD_PX), PULL_THRESHOLD_PX / 2, 'travel is half the finger')
  assert.equal(gesture.end(), 'cancel')

  gesture.start(100, 0)
  gesture.move(100 + PULL_THRESHOLD_PX * 2)
  assert.equal(gesture.end(), 'refresh')
  assert.equal(gesture.end(), 'cancel', 'ended gestures do not repeat')
})

test('a scroller holding a message feed never offers the gesture', () => {
  const { window } = new JSDOM(`<div id="a"><p>list</p></div><div id="b"><div ${FEED_MARKER}></div></div>`)
  assert.equal(scrollerCanRefresh(window.document.getElementById('a')!), true)
  assert.equal(scrollerCanRefresh(window.document.getElementById('b')!), false)
  assert.match(source('../src/components/features/channels/ChannelMessageFeed.tsx'), /className="admin-chat-feed" data-message-feed/)
})

test('only a Root or Detail page scroller wires the gesture, and it asks the shell for the one full refresh', () => {
  const layer = source('../src/layouts/admin-shell/PhoneNavigationLayer.tsx')
  assert.match(layer, /type === 'root' \|\| type === 'detail'/)
  assert.match(layer, /usePullToRefresh\(\{ enabled: offersRefresh\(pathname\)/)
  const hook = source('../src/navigation/pull-to-refresh.ts')
  assert.match(hook, /isReactNativeWebView\(\)/)
  assert.match(hook, /requestNativeFullRefresh\(\)/)
  assert.doesNotMatch(hook, /location\.reload/)
})
