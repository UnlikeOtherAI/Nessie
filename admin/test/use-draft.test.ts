import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import type { UseDraftOptions, UseDraftResult } from '../src/navigation/useDraft.js'

type DraftHarness<T> = {
  current: () => UseDraftResult<T>
  /** Runs a state-changing call inside React's act(), as a real event would. */
  run: (body: (draft: UseDraftResult<T>) => void | Promise<void>) => Promise<void>
  rerender: (key: string | null) => Promise<void>
  storage: Storage
  unmount: () => Promise<void>
  tick: (ms: number) => Promise<void>
}

// One jsdom + React root per case, torn down in the harness's `unmount`; the
// admin suite runs with `--experimental-test-isolation=none`, so the globals
// have to be restored or the next file inherits this DOM.
const mountDraft = async <T,>(
  initialKey: string | null,
  options: UseDraftOptions<T>,
  seed?: Record<string, unknown>,
): Promise<DraftHarness<T>> => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://app.example/',
  })
  const values = {
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    window: dom.window,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  for (const [key, value] of Object.entries(seed ?? {})) {
    dom.window.localStorage.setItem(key, JSON.stringify(value))
  }

  const React = await import('react')
  const { act, createElement: h } = React
  const { createRoot } = await import('react-dom/client')
  const { useDraft } = await import('../src/navigation/useDraft.js')
  ;(globalThis as typeof globalThis & { React: typeof React }).React = React

  let latest: UseDraftResult<T> | null = null
  const Probe = ({ draftKey }: { draftKey: string | null }) => {
    latest = useDraft<T>(draftKey, options)
    return null
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(h(Probe, { draftKey: initialKey })))

  return {
    current: () => {
      assert.ok(latest, 'the draft hook has not rendered')
      return latest
    },
    rerender: async (key: string | null) => {
      await act(async () => root.render(h(Probe, { draftKey: key })))
    },
    run: async (body) => {
      await act(async () => {
        assert.ok(latest, 'the draft hook has not rendered')
        await body(latest)
      })
    },
    storage: dom.window.localStorage,
    tick: async (ms: number) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
      })
    },
    unmount: async () => {
      await act(async () => root.unmount())
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as Record<string, unknown>)[key]
      }
    },
  }
}

test('a present draft is restored on mount and a fresh key starts empty', async () => {
  const harness = await mountDraft<{ text: string }>(
    'draft:composer:channel-1',
    { initial: { text: '' }, local: { debounceMs: 5 } },
    { 'draft:composer:channel-1': { text: 'half a thought' } },
  )
  try {
    assert.equal(harness.current().draft.text, 'half a thought')
    assert.equal(harness.current().restored, true)
  } finally {
    await harness.unmount()
  }
})

test('a reviver-rejected stored draft is removed instead of reaching UI state', async () => {
  const key = 'draft:composer:unsafe'
  const harness = await mountDraft<{ text: string }>(
    key,
    {
      initial: { text: '' },
      revive: () => null,
    },
    { [key]: { text: 'unsafe persisted value' } },
  )
  try {
    assert.equal(harness.current().draft.text, '')
    assert.equal(harness.current().restored, false)
    assert.equal(harness.storage.getItem(key), null)
  } finally {
    await harness.unmount()
  }
})

test('the local lane debounces and a key change never leaks the outgoing draft', async () => {
  const harness = await mountDraft<{ text: string }>('draft:composer:channel-1', {
    initial: { text: '' },
    local: { debounceMs: 20 },
  })
  try {
    await harness.tick(0)
    await harness.run((draft) => draft.setDraft({ text: 'for channel one' }))
    // Still inside the debounce window: nothing written yet.
    assert.equal(harness.storage.getItem('draft:composer:channel-1'), null)
    await harness.tick(40)
    assert.equal(
      harness.storage.getItem('draft:composer:channel-1'),
      JSON.stringify({ text: 'for channel one' }),
    )

    await harness.rerender('draft:composer:channel-2')
    // The reset-on-channel-change leak: channel two must open empty and
    // channel one must keep its own words.
    assert.equal(harness.current().draft.text, '')
    assert.equal(harness.current().restored, false)
    assert.equal(
      harness.storage.getItem('draft:composer:channel-1'),
      JSON.stringify({ text: 'for channel one' }),
    )

    await harness.rerender('draft:composer:channel-1')
    assert.equal(harness.current().draft.text, 'for channel one')
    assert.equal(harness.current().restored, true)
  } finally {
    await harness.unmount()
  }
})

test('the server lane saves once per distinct payload and clear() forgets the draft', async () => {
  const saved: string[] = []
  const harness = await mountDraft<{ text: string }>('draft:task:task-9', {
    initial: { text: '' },
    local: { debounceMs: 5 },
    server: {
      debounceMs: 15,
      save: async (draft) => {
        saved.push(draft.text)
      },
    },
  })
  try {
    await harness.tick(0)
    await harness.run((draft) => draft.setDraft({ text: 'first' }))
    await harness.tick(40)
    assert.deepEqual(saved, ['first'])

    // Signature diff: an identical value re-set does not save twice.
    await harness.run((draft) => draft.setDraft({ text: 'first' }))
    await harness.tick(40)
    assert.deepEqual(saved, ['first'])

    await harness.run((draft) => draft.setDraft({ text: 'second' }))
    await harness.run((draft) => draft.flush())
    assert.deepEqual(saved, ['first', 'second'])

    await harness.tick(0)
    await harness.run((draft) => draft.clear())
    await harness.tick(20)
    assert.equal(harness.storage.getItem('draft:task:task-9'), null)
    assert.equal(harness.current().draft.text, '')
    assert.equal(harness.current().restored, false)
  } finally {
    await harness.unmount()
  }
})

test('a payload the server rejected is surfaced, kept locally, and never auto-retried', async () => {
  const attempts: string[] = []
  const harness = await mountDraft<{ text: string }>('draft:dashboard:dash-3', {
    initial: { text: '' },
    local: { debounceMs: 5 },
    server: {
      debounceMs: 15,
      save: async (draft) => {
        attempts.push(draft.text)
        if (draft.text === 'rejected') {
          throw new Error('Someone else edited this dashboard.')
        }
      },
    },
  })
  try {
    await harness.tick(0)
    await harness.run((draft) => draft.setDraft({ text: 'rejected' }))
    await harness.tick(40)
    assert.deepEqual(attempts, ['rejected'])
    assert.equal(harness.current().saveError, 'Someone else edited this dashboard.')
    // The draft survives the rejection — that is what makes leaving safe.
    assert.equal(
      harness.storage.getItem('draft:dashboard:dash-3'),
      JSON.stringify({ text: 'rejected' }),
    )

    // Re-rendering and re-scheduling the same payload does not re-send it.
    await harness.run((draft) => draft.setDraft({ text: 'rejected' }))
    await harness.tick(40)
    assert.deepEqual(attempts, ['rejected'])

    // A changed payload clears the block and saves.
    await harness.run((draft) => draft.setDraft({ text: 'repaired' }))
    await harness.tick(40)
    assert.deepEqual(attempts, ['rejected', 'repaired'])
    assert.equal(harness.current().saveError, null)
  } finally {
    await harness.unmount()
  }
})

test('a store that throws (private mode, quota) degrades to an in-memory draft', async () => {
  const harness = await mountDraft<{ text: string }>('draft:composer:channel-x', {
    initial: { text: '' },
    local: { debounceMs: 5 },
  })
  try {
    const storage = harness.storage as Storage & { setItem: Storage['setItem'] }
    const original = storage.setItem.bind(storage)
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      value: () => {
        throw new Error('QuotaExceededError')
      },
    })
    await harness.tick(0)
    await harness.run((draft) => draft.setDraft({ text: 'typed anyway' }))
    await harness.tick(20)
    assert.equal(harness.current().draft.text, 'typed anyway')
    Object.defineProperty(storage, 'setItem', { configurable: true, value: original })
  } finally {
    await harness.unmount()
  }
})
