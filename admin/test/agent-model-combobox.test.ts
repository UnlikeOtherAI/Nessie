import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import { openOverlayIn } from './support/overlay-host'
import { stubResizeObserver } from './support/resize-observer-stub'

/**
 * The agent designer's model picker.
 *
 * Two things a person told us were wrong here, and both are about their own
 * choice surviving a glance at the list: a Ledger catalogue runs to hundreds
 * of models, so the handful they pay for themselves has to lead it rather than
 * sit under everything; and clicking the field used to blank it back to
 * "Search models…", which reads as having thrown their selection away.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/agents/designer/agent-1',
})
stubResizeObserver(dom.window as unknown as Window & typeof globalThis)
// jsdom implements no scrolling, and the list scrolls its active row into view
// on every open. A no-op is enough: which row that is gets asserted from the DOM.
dom.window.Element.prototype.scrollIntoView = () => undefined

const React = await import('react')
const { act, createElement: h, useState } = React
const { createRoot } = await import('react-dom/client')
const { ModelCombobox } = await import(
  '../src/components/features/agents/designer/ModelCombobox.js'
)
type ModelOption = Parameters<typeof ModelCombobox>[0]['options'][number]

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: dom.window,
}

const installDom = () => {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

// The catalogue arrives Ledger-first, which is the order the server sends and
// the order every other reader of it depends on.
const OPTIONS: ModelOption[] = [
  {
    description: 'OpenAI flagship.',
    displayName: 'GPT-5.2',
    model: 'gpt-5.2',
    provider: 'openai',
    providerDisplayName: 'OpenAI',
    source: 'ledger',
  },
  {
    displayName: 'GPT-5 mini',
    model: 'gpt-5-mini',
    provider: 'openai',
    providerDisplayName: 'OpenAI',
    source: 'ledger',
  },
  {
    displayName: 'GPT-5 Codex',
    model: 'gpt-5-codex',
    provider: 'subscription/openai_codex',
    providerDisplayName: 'ChatGPT Codex',
    source: 'subscription',
  },
  {
    displayName: 'Grok 4',
    model: 'grok-4',
    provider: 'subscription/xai_grok',
    providerDisplayName: 'Grok (SuperGrok)',
    source: 'subscription',
  },
]

const mount = async (options: ModelOption[] = OPTIONS) => {
  const restoreDom = installDom()
  const picked: ModelOption[] = []
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  // Controlled by its owner, exactly as the designer form holds it: the picker
  // reports a choice and renders whatever comes back.
  const Harness = () => {
    const [value, setValue] = useState<ModelOption | null>(options[0] ?? null)
    return h(ModelCombobox, {
      emptyLabel: 'No models match that search',
      id: 'agent-model',
      onSelect: (option: ModelOption) => {
        picked.push(option)
        setValue(option)
      },
      options,
      placeholder: 'Search models…',
      value,
    })
  }

  await act(async () => {
    root.render(h(Harness))
  })

  const input = (): HTMLInputElement => {
    const found = container.querySelector('#agent-model')
    assert.ok(found instanceof dom.window.HTMLInputElement, 'the combobox rendered')
    return found as unknown as HTMLInputElement
  }

  const press = async (element: Element): Promise<void> => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
    })
  }

  return {
    close: async () => {
      await act(async () => { root.unmount() })
      container.remove()
      restoreDom()
    },
    input,
    // Every row and heading in the open list, in the order a person reads them.
    lines: (): string[] =>
      [...openOverlayIn(dom.window.document).querySelectorAll('div')]
        .filter((node) => node.children.length === 0 && node.textContent?.trim())
        .map((node) => node.textContent?.trim() ?? ''),
    open: async () => { await press(input()) },
    picked,
    row: (label: string): Element => {
      const found = [...openOverlayIn(dom.window.document).querySelectorAll('[role="option"]')]
        .find((node) => node.querySelector('div')?.textContent?.trim() === label)
      assert.ok(found, `no "${label}" row in the list`)
      return found
    },
    press,
  }
}

test('a person’s own subscriptions lead the list, under a heading of their own', async () => {
  const picker = await mount()
  try {
    await picker.open()
    const lines = picker.lines()
    assert.deepEqual(lines.slice(0, 6), [
      'Your subscriptions',
      'ChatGPT Codex',
      'GPT-5 Codex',
      'gpt-5-codex',
      'Grok (SuperGrok)',
      'Grok 4',
    ])
    // The catalogue underneath says whose money it spends, which it only has to
    // do once there is a section above it.
    assert.ok(lines.indexOf('Ledger models') > lines.indexOf('Your subscriptions'))
    assert.ok(lines.indexOf('GPT-5.2') > lines.indexOf('Ledger models'))
  } finally {
    await picker.close()
  }
})

test('a deployment with no linked subscriptions gets no section headings at all', async () => {
  const picker = await mount(OPTIONS.filter((option) => option.source === 'ledger'))
  try {
    await picker.open()
    const lines = picker.lines()
    assert.equal(lines.includes('Your subscriptions'), false)
    assert.equal(lines.includes('Ledger models'), false)
    assert.deepEqual(lines.slice(0, 3), ['OpenAI', 'GPT-5.2', 'gpt-5.2 — OpenAI flagship.'])
  } finally {
    await picker.close()
  }
})

test('opening the list keeps the selected model in the field', async () => {
  const picker = await mount()
  try {
    assert.equal(picker.input().value, 'GPT-5.2 (gpt-5.2)')
    await picker.open()
    // The bug: this used to be '', so the placeholder came back and the field
    // read as though nothing had ever been chosen.
    assert.equal(picker.input().value, 'GPT-5.2 (gpt-5.2)')
    assert.equal(picker.input().getAttribute('aria-expanded'), 'true')
  } finally {
    await picker.close()
  }
})

test('the list opens on the current selection rather than at the top', async () => {
  const picker = await mount()
  try {
    await picker.open()
    const active = openOverlayIn(dom.window.document).querySelector('[data-active="true"]')
    assert.equal(active?.querySelector('div')?.textContent?.trim(), 'GPT-5.2')
  } finally {
    await picker.close()
  }
})

test('a picked model is reported once and then shown in the field', async () => {
  const picker = await mount()
  try {
    await picker.open()
    await picker.press(picker.row('Grok 4'))
    assert.deepEqual(picker.picked.map((option) => option.model), ['grok-4'])
    assert.equal(picker.input().value, 'Grok 4 (grok-4)')
    assert.equal(picker.input().getAttribute('aria-expanded'), 'false')
  } finally {
    await picker.close()
  }
})
