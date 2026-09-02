import assert from 'node:assert/strict'
import test from 'node:test'
import { mountPhoneNavigationViewport } from './support/phone-navigation-viewport-harness'

// A cold start (docs/navigation/overview.md §8) lands on a screen with no stack
// beneath it. The stack seeds the registry's parent chain as render-only
// layers so Back and the edge swipe reveal what a real navigation would have.

test('a cold deep link mounts its parent beneath it, rendered from the seed', async () => {
  const harness = await mountPhoneNavigationViewport('/channels/channel_a', { seed: true })
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  const underlay = harness.layer('underlay')
  assert.equal(underlay?.getAttribute('data-phone-navigation-route'), 'root:channels:/channels')
  assert.equal(underlay?.textContent, 'seeded:/channels')
  assert.equal(underlay?.hasAttribute('inert'), true, 'a seeded layer is inert beneath the landed screen')
  await harness.unmount()
})

test('the edge swipe reveals the seeded parent and Back replaces onto it', async () => {
  const harness = await mountPhoneNavigationViewport('/channels/channel_a', { seed: true })
  harness.touch('touchstart', 8, 300)
  harness.touch('touchmove', 40, 302)
  harness.touch('touchmove', 300, 304)
  await harness.flush()
  assert.match(harness.layer('underlay')?.getAttribute('style') ?? '', /translate3d\(/)
  harness.touch('touchend', 340, 304)
  await harness.flush(450)
  assert.equal(harness.locationLabel(), '/channels')
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'root:channels:/channels')
  // The route's own commit replaced the seeded content with the real page.
  assert.equal(harness.layer('current')?.textContent, 'screen:/channels@/channels')
  await harness.unmount()
})

test('without a seed a cold start is a single layer, as before', async () => {
  const harness = await mountPhoneNavigationViewport('/channels/channel_a')
  assert.equal(harness.container.querySelectorAll('[data-phone-navigation-layer]').length, 1)
  await harness.unmount()
})
