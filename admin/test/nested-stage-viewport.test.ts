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

// Knowledge's ladder is the case with more than one stage open at a time: a
// folder browsed beyond the space root, the document opened from it, and that
// document's version history are three layers, and Back unwinds exactly one
// per press — the highest-priority owner first (docs/navigation.md §6).
const KNOWLEDGE_STAGES = [
  { id: 'knowledge:folder', label: 'Back to parent folder', priority: 11 },
  { id: 'knowledge:document', label: 'Back to space', priority: 12 },
  { id: 'knowledge:history', label: 'Back from version history', priority: 13 },
] as const

test('a knowledge folder, document and history stack as three layers Back unwinds one at a time', async () => {
  const harness = await mountPhoneNavigationViewport('/channels', { stages: KNOWLEDGE_STAGES })
  await harness.goTo('/channels/channel_a')
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)

  for (const stage of KNOWLEDGE_STAGES) {
    await harness.setStage(true, stage.id)
    await harness.paintFrame()
    await harness.paintFrame()
    await harness.flush(450)
    assert.equal(
      harness.layer('current')?.getAttribute('data-phone-navigation-route'),
      `stage:${stage.id}`,
      `${stage.id} is the top layer once opened`,
    )
  }
  assert.equal(
    harness.layer('underlay')?.getAttribute('data-phone-navigation-route'),
    'stage:knowledge:document',
    'the document is retained under the history',
  )

  // Unwind: the deepest registered owner answers Back each time, and the route
  // is never touched until every stage is closed.
  const unwound = ['stage:knowledge:document', 'stage:knowledge:folder', 'channels:channel']
  for (const [index, expected] of unwound.entries()) {
    const owner = KNOWLEDGE_STAGES[KNOWLEDGE_STAGES.length - 1 - index]!.id
    assert.equal(harness.backOwner(), `stage:${owner}`)
    await harness.pressBack()
    await harness.flush(450)
    assert.equal(harness.layer('current')?.getAttribute('data-phone-navigation-route'), expected)
    assert.equal(harness.locationLabel(), '/channels/channel_a', 'no stage press changes the route')
  }

  assert.equal(harness.container.querySelector('[data-stage="knowledge:folder"]'), null)
  assert.equal(
    harness.backOwner(),
    'route:/channels',
    'with the stages closed Back is the route parent',
  )
  await harness.unmount()
})
