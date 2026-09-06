import assert from 'node:assert/strict'
import test from 'node:test'

import {
  publishScreenBar,
  resetScreenBars,
  sameScreenBar,
  screenBarFor,
  setLayerFallback,
  unpublishScreenBar,
  type ScreenBar,
} from '../src/navigation/screen-bar'

const bar = (title: string, backLabel: string | null = null): ScreenBar => ({
  actions: [],
  back: backLabel === null ? null : { label: backLabel, onBack: () => undefined },
  title,
})

const CHANNEL = 'channels:2:channels:channel'

test('a layer holds a stack of publishers, and the topmost one is the bar', () => {
  resetScreenBars()
  // The exact shape of `/channels/:id/info`: the channel's own header and a
  // full-screen overlay drawn over it, both in one layer. Keyed as a slot,
  // last-writer-wins would put the channel's title over the info screen.
  publishScreenBar(CHANNEL, 'channel-header', bar('#design', 'Channels'))
  publishScreenBar(CHANNEL, 'info-overlay', bar('Conversation info', 'Back'))
  assert.equal(screenBarFor(CHANNEL)?.title, 'Conversation info')

  unpublishScreenBar(CHANNEL, 'info-overlay')
  assert.equal(screenBarFor(CHANNEL)?.title, '#design')
})

test('a re-publish updates in place and never climbs over the overlay above it', () => {
  resetScreenBars()
  publishScreenBar(CHANNEL, 'channel-header', bar('#design', 'Channels'))
  publishScreenBar(CHANNEL, 'info-overlay', bar('Conversation info', 'Back'))

  // The channel header re-renders constantly under an open overlay — presence,
  // unread counts, call state. A publisher that removed and re-appended itself
  // would take the top and put the channel's title back over the info screen.
  publishScreenBar(CHANNEL, 'channel-header', bar('#design (2 unread)', 'Channels'))
  assert.equal(screenBarFor(CHANNEL)?.title, 'Conversation info')

  unpublishScreenBar(CHANNEL, 'info-overlay')
  assert.equal(screenBarFor(CHANNEL)?.title, '#design (2 unread)')
})

test('a re-publish replaces the handlers even when nothing visible changed', () => {
  resetScreenBars()
  let ran = 'none'
  publishScreenBar(CHANNEL, 'h', { actions: [], back: { label: 'Channels', onBack: () => { ran = 'first' } }, title: '#design' })
  publishScreenBar(CHANNEL, 'h', { actions: [], back: { label: 'Channels', onBack: () => { ran = 'second' } }, title: '#design' })
  screenBarFor(CHANNEL)?.back?.onBack()
  // Identical to look at, so no notification is posted — but the closure is
  // this render's, not the first one's.
  assert.equal(ran, 'second')
})

test('bars are keyed by layer, so a channel and its info route do not collide', () => {
  resetScreenBars()
  // Both are `channels:channel` by the classifier's key and both are alive in
  // the stack; only the depth in `layerKey` tells them apart.
  publishScreenBar('channels:2:channels:channel', 'a', bar('#design', 'Channels'))
  publishScreenBar('channels:3:channels:channel', 'b', bar('Members', 'Conversation info'))
  assert.equal(screenBarFor('channels:2:channels:channel')?.title, '#design')
  assert.equal(screenBarFor('channels:3:channels:channel')?.title, 'Members')
})

test('a stage fallback shows only while nothing in the layer has published', () => {
  resetScreenBars()
  const stage = 'dashboards:2:stage:dashboard:add-widget'
  setLayerFallback(stage, bar('Add widget', 'Back to dashboard'))
  assert.equal(screenBarFor(stage)?.title, 'Add widget')

  // A stage that does draw a header wins: its children publish before the
  // stage's own effect runs, which is exactly why this is a fallback and not
  // an ordinary publish.
  publishScreenBar(stage, 'panel-header', bar('Widgets', 'Back'))
  assert.equal(screenBarFor(stage)?.title, 'Widgets')

  unpublishScreenBar(stage, 'panel-header')
  assert.equal(screenBarFor(stage)?.title, 'Add widget')
  setLayerFallback(stage, null)
  assert.equal(screenBarFor(stage), null)
})

test('an unknown or absent layer has no bar rather than a stale one', () => {
  resetScreenBars()
  publishScreenBar(CHANNEL, 'h', bar('#design', 'Channels'))
  assert.equal(screenBarFor('channels:0:root:channels:/channels'), null)
  assert.equal(screenBarFor(null), null)
  unpublishScreenBar(CHANNEL, 'h')
  assert.equal(screenBarFor(CHANNEL), null)
})

test('sameScreenBar compares what is drawn, not the handlers behind it', () => {
  const left = bar('#design', 'Channels')
  assert.equal(sameScreenBar(left, bar('#design', 'Channels')), true)
  assert.equal(sameScreenBar(left, bar('#design', 'Back')), false)
  assert.equal(sameScreenBar(left, bar('#release', 'Channels')), false)
  assert.equal(sameScreenBar(left, bar('#design')), false)
  assert.equal(sameScreenBar(null, left), false)
  assert.equal(sameScreenBar(null, null), true)
})
