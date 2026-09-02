import assert from 'node:assert/strict'
import test from 'node:test'
import { mountPhoneNavigationViewport } from './support/phone-navigation-viewport-harness'

// A column browser is an adopter of nested stages (docs/navigation.md §6): on
// the single layout column 0 is the page and every column beyond it is a real
// layer in the navigation stack, so a deeper column slides in like a route and
// Back unwinds exactly one level. Where no stack hosts stages — a split
// layout's detail column — the same component composes the multi-column track
// instead, and nothing is pushed.

const React = await import('react')
const { createElement: h } = React
const { ColumnBrowserColumn } = await import(
  '../src/components/shared/column-browser/ColumnBrowserColumn'
)
const { ColumnBrowserViewport } = await import(
  '../src/components/shared/column-browser/ColumnBrowserViewport'
)
const { NestedStageHostContext } = await import('../src/navigation/NestedStage')

type Fixture = {
  render: () => React.ReactNode
  setActiveColumn: (index: number) => void
}

// A two-column browser driven the way a page drives one: its own state says
// which column is active, and the detail column owns the unwind action.
const createFixture = ({ hosted }: { hosted: boolean }): Fixture => {
  const listeners = new Set<() => void>()
  let activeColumn = 0
  const publish = () => {
    for (const listener of listeners) listener()
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => activeColumn,
  }

  const Browser = () => {
    const active = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const columns = [
      h(
        ColumnBrowserColumn,
        { key: 'list', title: 'Tools' },
        h('div', { 'data-column': 'list' }, 'list'),
      ),
      h(
        ColumnBrowserColumn,
        {
          key: 'detail',
          onBack: () => {
            activeColumn = 0
            publish()
          },
          showBack: true,
          title: 'Detail',
        },
        h('div', { 'data-column': 'detail' }, 'detail'),
      ),
    ]
    const browser = h(ColumnBrowserViewport, { activeColumn: active, columns })
    // A split layout's detail column hosts no stages; the viewport sees that
    // through the same host context the framework uses.
    return hosted
      ? browser
      : h(NestedStageHostContext.Provider, { value: null }, browser)
  }

  return {
    render: () => h(Browser),
    setActiveColumn: (index: number) => {
      activeColumn = index
      publish()
    },
  }
}

const mountBrowser = async (options: { hosted: boolean }) => {
  const fixture = createFixture(options)
  const harness = await mountPhoneNavigationViewport('/channels', {
    renderDetail: fixture.render,
  })
  await harness.goTo('/channels/channel_a')
  await harness.flush(450)
  return { fixture, harness }
}

const stageLayer = (harness: { container: HTMLElement }): Element | null =>
  harness.container.querySelector('[data-phone-navigation-route="stage:column:1"]')

test('on single, activating column 1 pushes a stage layer that slides in over column 0', async () => {
  const { fixture, harness } = await mountBrowser({ hosted: true })
  assert.ok(harness.container.querySelector('[data-column="list"]'), 'column 0 is the page')
  assert.equal(stageLayer(harness), null, 'nothing is pushed while only column 0 is active')

  await harness.render(() => fixture.setActiveColumn(1))
  const viewport = harness.container.querySelector('[data-phone-navigation-viewport]')
  assert.equal(viewport?.getAttribute('data-phone-navigation-direction'), 'forward')
  assert.equal(
    harness.layer('incoming')?.getAttribute('data-phone-navigation-route'),
    'stage:column:1',
  )
  assert.ok(
    harness.layer('incoming')?.querySelector('[data-column="detail"]'),
    'the page renders the deeper column into its stage through the portal',
  )

  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)
  assert.equal(
    harness.layer('current')?.getAttribute('data-phone-navigation-route'),
    'stage:column:1',
  )
  assert.equal(
    harness.layer('underlay')?.getAttribute('data-phone-navigation-route'),
    'channels:channel',
  )
  assert.ok(
    harness.layer('underlay')?.querySelector('[data-column="list"]'),
    'column 0 stays mounted beneath',
  )
  await harness.unmount()
})

test('on single, the stage owns Back and its action unwinds exactly that column', async () => {
  const { fixture, harness } = await mountBrowser({ hosted: true })
  await harness.render(() => fixture.setActiveColumn(1))
  await harness.paintFrame()
  await harness.paintFrame()
  await harness.flush(450)

  const owner = harness.backOwner()
  assert.equal(owner?.id, 'stage:column:1', 'the stage is the registry’s active owner')
  assert.equal(owner?.label, 'Back from Detail', 'the column reported its own label')

  await harness.render(() => owner?.onBack())
  await harness.flush(450)
  assert.equal(
    harness.layer('current')?.getAttribute('data-phone-navigation-route'),
    'channels:channel',
  )
  assert.equal(stageLayer(harness), null, 'the stage layer is released')
  assert.ok(harness.container.querySelector('[data-column="list"]'), 'column 0 is current again')
  assert.equal(harness.backOwner(), null, 'no stage owns Back once it is unwound')
  assert.equal(harness.locationLabel(), '/channels/channel_a', 'the route never changed')
  await harness.unmount()
})

test('with no stack hosting stages, every column renders in the one track', async () => {
  const { fixture, harness } = await mountBrowser({ hosted: false })
  const track = harness.container.querySelector('[data-column-browser-track]')
  assert.ok(track, 'the columns are composed into one track')
  assert.ok(track?.querySelector('[data-column="list"]'))
  assert.ok(track?.querySelector('[data-column="detail"]'), 'no column is withheld')
  assert.match(
    track?.getAttribute('style') ?? '',
    /transition: transform var\(--nav-duration\) var\(--nav-easing\)/,
    'the track moves on the shared motion tokens',
  )

  await harness.render(() => fixture.setActiveColumn(1))
  await harness.flush(450)
  assert.equal(stageLayer(harness), null, 'a track never pushes a stage')
  assert.equal(harness.backOwner(), null, 'and never registers one')
  assert.equal(
    harness.layer('current')?.getAttribute('data-phone-navigation-route'),
    'channels:channel',
  )
  await harness.unmount()
})
