import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { TOOL_CATEGORIES } from '@nessie/schemas'

import { ToolPicker } from '../src/components/features/agents/designer/ToolPicker.js'
import type {
  DesignerToolGroup,
  DesignerToolOption,
} from '../src/facades/designer/tool-catalog.js'

const tool = (key: string, group: string): DesignerToolOption => ({
  allowMode: false,
  defaultEnabled: true,
  description: `What ${key} does.`,
  group,
  key,
  kind: 'builtin',
  label: key,
})

const groups: DesignerToolGroup[] = [
  {
    description: 'Reading, writing and reacting to messages.',
    name: 'Conversation',
    tools: [tool('send_message', 'Conversation'), tool('react', 'Conversation')],
  },
  { name: 'Executors', tools: [tool('executor_list', 'Executors')] },
]

const picker = (readOnly = false) =>
  createElement(ToolPicker, {
    groups,
    onToggle: () => undefined,
    query: { isError: false, isLoading: false, refetch: () => undefined },
    readOnly,
    toolState: {},
  })

const markup = (readOnly = false) => renderToStaticMarkup(picker(readOnly))

test('every group is closed at rest, so the picker opens as an index', () => {
  const html = markup()

  // The headings and their counts are all that renders…
  assert.match(html, /Conversation/)
  assert.match(html, /Executors/)
  assert.match(html, /2\/2 enabled/)
  assert.match(html, /aria-expanded="false"/)
  // …and none of the switches behind them.
  assert.doesNotMatch(html, /send_message/)
  assert.doesNotMatch(html, /executor_list/)
})

test('a closed section still says what belongs in it', () => {
  assert.match(markup(), /Reading, writing and reacting to messages\./)
})

test('the picker renders one section per declared category, in the shared order', () => {
  // The vocabulary is the order; a surface that re-sorted it would disagree
  // with every other list of tools.
  const html = markup()
  const positions = ['Conversation', 'Executors'].map((name) => html.indexOf(name))
  assert.ok(positions.every((position) => position >= 0))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)

  const labels = TOOL_CATEGORIES.map((category) => category.label)
  assert.ok(labels.indexOf('Conversation') < labels.indexOf('Executors'))
})

// Opening a section is the only way to see the controls, and the control is
// the whole difference between the two modes — so these mount for real.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5455/agents',
})
const { createRoot } = await import('react-dom/client')

const domGlobals = {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MouseEvent: dom.window.MouseEvent,
  navigator: dom.window.navigator,
  window: dom.window,
}

const openFirstSection = async (readOnly: boolean) => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(domGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(picker(readOnly))
  })

  const heading = [...container.querySelectorAll('button[aria-expanded]')][0]
  assert.ok(heading, 'expected a section heading to render')
  await React.act(async () => {
    heading.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  const switches = [...container.querySelectorAll('[role="switch"]')] as HTMLButtonElement[]
  const cleanup = async () => {
    await React.act(async () => {
      root.unmount()
    })
    container.remove()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  return { cleanup, switches }
}

test('a viewer who cannot edit sees the same switches, disabled', async () => {
  const { cleanup, switches } = await openFirstSection(true)
  try {
    assert.equal(switches.length, 2, 'the read-only view renders the same rows')
    assert.ok(
      switches.every((control) => control.disabled),
      'a viewer who cannot change a tool must not be offered a live control',
    )
    // It still states what it is, so the row is readable without pressing it.
    assert.ok(switches.every((control) => control.getAttribute('aria-checked') === 'true'))
  } finally {
    await cleanup()
  }
})

test('an owner gets the same switches, pressable', async () => {
  const { cleanup, switches } = await openFirstSection(false)
  try {
    assert.equal(switches.length, 2)
    assert.ok(switches.every((control) => !control.disabled))
  } finally {
    await cleanup()
  }
})
