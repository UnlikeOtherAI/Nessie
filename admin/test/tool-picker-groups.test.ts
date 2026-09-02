import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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

const markup = () =>
  renderToStaticMarkup(
    createElement(ToolPicker, {
      groups,
      onToggle: () => undefined,
      query: { isError: false, isLoading: false, refetch: () => undefined },
      toolState: {},
    }),
  )

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
