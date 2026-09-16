import assert from 'node:assert/strict'
import test from 'node:test'

import type { PresentedAgentCardBlock } from '@nessie/schemas'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { AgentCardBlocks } from '../src/components/features/channels/AgentCardBlocks.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * The folded half of an agent proposal.
 *
 * The Agent Designer's card has to carry the agent's whole tool and app
 * selection — that list IS the person's approval of it — while still being
 * readable while they decide whether the name is right. `details` is how a
 * card says both at once, and `chips` is how a set of named things reads as a
 * set rather than as prose the reader has to parse.
 */
const render = (blocks: PresentedAgentCardBlock[]): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(AgentCardBlocks, {
        blocks,
        disabled: false,
        onSecretChange: () => {},
        onValueChange: () => {},
        providedSecretKeys: [],
        secrets: {},
        settled: false,
        values: {},
      }),
    ),
  )

test('a details block arrives closed and renders the vocabulary inside it', () => {
  const html = render([
    {
      blocks: [
        { items: ['send_message', 'ticket_read'], label: 'Tools', type: 'chips' },
        { items: [{ label: 'App', value: 'Sales Portal' }], type: 'fields' },
      ],
      summary: 'What it can reach',
      type: 'details',
    },
  ])

  assert.match(html, /<details class="agent-card-details">/)
  // No `open`: the whole point is that the detail waits until it is asked for.
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/)
  assert.match(html, /<summary[^>]*>What it can reach<\/summary>/)
  assert.match(html, /<li>send_message<\/li>/)
  assert.match(html, /<li>ticket_read<\/li>/)
  assert.match(html, /Sales Portal/)
})

test('a chips block labels its row and never swallows the words', () => {
  const html = render([{ items: ['Sales Portal', 'Linear'], label: 'Apps', type: 'chips' }])
  assert.match(html, /agent-card-chips-label">Apps</)
  assert.match(html, /<li>Sales Portal<\/li>/)
  assert.match(html, /<li>Linear<\/li>/)
})

test('a select input still renders as a dropdown beside the folded detail', () => {
  const html = render([
    {
      input: 'select',
      key: 'model',
      label: 'Model',
      options: [
        { label: 'Claude Opus 5', value: 'anthropic/claude-opus-5' },
        { label: 'GPT-5 mini', value: 'openai/gpt-5-mini' },
      ],
      required: true,
      type: 'input',
    },
    { blocks: [{ markdown: 'Everything else', type: 'text' }], summary: 'Detail', type: 'details' },
  ])

  assert.match(html, /<select/)
  assert.match(html, /value="anthropic\/claude-opus-5"/)
  assert.match(html, /<details/)
})
