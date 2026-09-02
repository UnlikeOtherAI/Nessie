import assert from 'node:assert/strict'
import test from 'node:test'
import { mountPhoneNavigationViewport } from './support/phone-navigation-viewport-harness'

// Interruption and visibility (docs/navigation.md §12): a navigation that
// lands mid-slide settles the running slide first; a hidden document never
// holds a half-finished pose.

test('a navigation arriving mid-slide settles the running slide before starting its own', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  await harness.goTo('/channels/channel_a', false)
  await harness.paintFrame()
  await harness.paintFrame()
  const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
  assert.equal(viewport?.getAttribute('data-phone-navigation-phase'), 'running')

  // Back lands while the push is still running.
  await harness.historyBack()
  // The push was settled (its entries committed) and the pop runs from a
  // clean stack: the detail leaves over the retained root.
  assert.equal(viewport?.getAttribute('data-phone-navigation-direction'), 'back')
  assert.equal(harness.layer('outgoing')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  assert.equal(harness.layer('incoming')?.getAttribute('data-phone-navigation-route'), 'root:channels:/channels')
  await harness.flush(450)
  assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'root:channels:/channels')
  assert.equal(harness.container.querySelectorAll('[data-phone-navigation-layer]').length, 1)
  await harness.unmount()
})

test('a slide started while the document is hidden commits at once', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  try {
    await harness.goTo('/channels/channel_a', false)
    await harness.paintFrame()
    await harness.paintFrame()
    await harness.flush(20)
    const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
    assert.equal(viewport?.getAttribute('data-phone-navigation-phase'), null, 'no slide is left running')
    assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  } finally {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor)
    else delete (document as { visibilityState?: unknown }).visibilityState
  }
  await harness.unmount()
})

test('hiding the document mid-slide finishes it', async () => {
  const harness = await mountPhoneNavigationViewport('/channels')
  await harness.goTo('/channels/channel_a', false)
  await harness.paintFrame()
  await harness.paintFrame()
  const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
  assert.equal(viewport?.getAttribute('data-phone-navigation-phase'), 'running')
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  try {
    await harness.render(() => { document.dispatchEvent(new window.Event('visibilitychange')) })
    assert.equal(viewport?.getAttribute('data-phone-navigation-phase'), null)
    assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), 'channels:channel')
  } finally {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor)
    else delete (document as { visibilityState?: unknown }).visibilityState
  }
  await harness.unmount()
})
