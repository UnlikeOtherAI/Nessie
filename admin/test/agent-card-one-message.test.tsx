import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import type { AgentCardPresenter } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { AgentCardMessage } from '../src/components/features/channels/AgentCardMessage.js'
import { agentCardKeys } from '../src/facades/agent-cards/keys.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * One message, not two.
 *
 * A proposal used to arrive as a card followed by a separate paragraph saying
 * the same thing. The paragraph is now a field on the card, rendered above its
 * header in the same bubble, with the buttons still in the footer — so the
 * sentence, the detail and the decision read as one thing and are answered in
 * one place.
 */

const CARD_ID = '77777777-7777-4777-8777-777777777777'

const baseCard: AgentCardPresenter = {
  action: 'respond',
  actions: [
    { key: 'accept', label: 'Accept', style: 'primary', submits: true },
    { key: 'edit', label: 'Edit', style: 'secondary', submits: false },
    { key: 'decline', label: 'Decline', style: 'danger', submits: false },
  ],
  agentId: '88888888-8888-4888-8888-888888888888',
  agentName: 'Agent Designer',
  blocks: [{ markdown: 'Answers questions about deals and pipeline.', type: 'text' }],
  browserLogin: null,
  cardId: CARD_ID,
  expiresAt: null,
  messageId: '99999999-9999-4999-8999-999999999999',
  resolution: null,
  service: null,
  status: 'open',
  subtitle: 'sales researcher',
  threadId: '55555555-5555-4555-8555-555555555555',
  title: 'Sales agent',
  waitingFor: [],
}

const apiClient = {
  delete: async () => ({ ok: true }),
  get: async () => null,
  patch: async () => ({ ok: true }),
  post: async () => ({ ok: true }),
  put: async () => ({ ok: true }),
} as unknown as ApiClient

// The card is seeded into the cache rather than fetched: this asks what the
// real component draws for a given presenter, which is the only fact under
// test here.
const render = (card: AgentCardPresenter): string => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(agentCardKeys.card(CARD_ID), card)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: apiClient },
        createElement(
          MemoryRouter,
          { initialEntries: ['/channels/sales'] },
          createElement(AgentCardMessage, {
            metadata: { agentCard: { cardId: CARD_ID, schemaVersion: 1 } },
          }),
        ),
      ),
    ),
  )
}

test('the agent\'s words render inside the card, above its header', () => {
  const html = render({
    ...baseCard,
    message: 'Here is the sales agent — press Accept, or tell me what to change.',
  })
  const card = new JSDOM(`<body>${html}</body>`).window.document
    .querySelector('[data-testid="agent-card"]')
  assert.ok(card, 'the prose stays inside the one card bubble')

  const prose = card.querySelector('.agent-card-prose')
  assert.ok(prose)
  assert.match(prose.textContent ?? '', /press Accept, or tell me what to change/)

  // Order on screen: the agent's sentence, then the card's header, then the
  // buttons that answer it.
  const order = [...card.children].map((child) => child.className.split(' ')[0])
  assert.deepEqual(order.slice(0, 2), ['agent-card-prose', 'agent-card-header'])
  assert.equal(order.at(-1), 'agent-card-footer')

  const actions = [...card.querySelectorAll('.agent-card-footer button')]
    .map((button) => button.textContent)
  assert.deepEqual(actions, ['Accept', 'Edit', 'Decline'])
})

// Every card written before the field existed has no `message`. It must draw
// exactly as it always did — header first, no empty prose slot.
test('a card without a message renders unchanged', () => {
  const html = render(baseCard)
  const card = new JSDOM(`<body>${html}</body>`).window.document
    .querySelector('[data-testid="agent-card"]')
  assert.ok(card)
  assert.equal(card.querySelector('.agent-card-prose'), null)
  assert.equal(card.children[0]?.className.split(' ')[0], 'agent-card-header')
})
