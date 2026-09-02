import assert from 'node:assert/strict'
import test from 'node:test'
import { mountPhoneNavigationViewport } from './support/phone-navigation-viewport-harness'

// A nested stage (docs/navigation.md §6) is a state-driven screen a page
// pushes over its own route. In the stack it is a layer like a route: it
// slides in, is retained under whatever is pushed over it, unwinds on Back,
// and its content stays rendered by the page through a portal.

test('activating a stage pushes a layer that slides in over the retained page', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')

  await harness.setStage(true)
  const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
  assert.equal(viewport?.getAttribute('data-phone-navigation-direction'), 'forward')
  assert.equal(harness.layer('incoming')?.getAttribute('data-phone-navigation-route'), 'stage:inspector')
  assert.equal(harness.layer('incoming')?.textContent, 'stage:inspector', 'the page renders the stage through its portal')
  assert.equal(harness.layer('outgoing')?.getAttribute('data-phone-navigation-route'), 'channels:channel')

  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'stage:inspector')
  assert.equal(harness.layer('underlay')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  assert.equal(harness.mounts()['channels-detail'], 1, 'the page beneath stays mounted')
  await harness.unmount()
})

test('closing a stage runs Back and releases its layer; the page beneath is current again', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)
  await harness.setStage(true)
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)

  await harness.setStage(false)
  const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
  assert.equal(viewport?.getAttribute('data-phone-navigation-direction'), 'back')
  assert.equal(harness.layer('outgoing')?.getAttribute('data-phone-navigation-route'), 'stage:inspector')
  assert.equal(
    harness.layer('outgoing')?.textContent,
    'stage:inspector',
    'the page keeps rendering the stage while it slides out',
  )
  assert.equal(harness.layer('incoming')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  assert.equal(harness.container.querySelector('[data-stage="inspector"]'), null, 'the stage layer is released')
  assert.equal(harness.currentPathname()?.textContent, 'screen:/channels/channel_a@/channels/channel_a')
  await harness.unmount()
})

test('the edge swipe closes a swipeable stage on top and the commit closes it without a second slide', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)
  await harness.setStage(true)
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)

  harness.touch('touchstart', 8, 300)
  harness.touch('touchmove', 40, 302)
  harness.touch('touchmove', 200, 304)
  await harness.flush()
  const top = harness.layer('current')
  assert.equal(top?.getAttribute('data-phone-navigation-route'), 'stage:inspector')
  assert.match(top?.getAttribute('style') ?? '', /translate3d\(49\.23%/)
  harness.touch('touchend', 300, 304)
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  assert.equal(harness.container.querySelector('[data-stage="inspector"]'), null)
  assert.equal(harness.locationLabel(), '/channels/channel_a', 'the route never changed: the swipe closed the stage')
  await harness.unmount()
})

test('a route pushed over an open stage retains it, and Back returns to the stage', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  await harness.goTo('/channels/channel_a')
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)
  await harness.setStage(true)
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)

  await harness.goTo('/channels/channel_a/info')
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  assert.equal(harness.layer('underlay')?.getAttribute('data-phone-navigation-route'), 'stage:inspector')

  await harness.historyBack()
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'stage:inspector')
  assert.equal(harness.layer('current')?.textContent, 'stage:inspector')
  await harness.unmount()
})
