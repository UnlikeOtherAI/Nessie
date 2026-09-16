import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import type { AgentCardPresenter } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { AgentCardMessage } from '../../src/components/features/channels/AgentCardMessage'
import '../../src/styles.css'

/**
 * The Agent Designer's proposal card, rendered by the real card component.
 *
 * The card is served by the ordinary viewer-scoped presenter, so the fixture
 * only has to answer `GET /api/agent-cards/:id` — everything else on screen is
 * the product's own renderer, which is the point: this proves the standard
 * shape reads correctly in the chat card, not that a bespoke component exists.
 */

const CARD_ID = '77777777-7777-4777-8777-777777777777'

const card: AgentCardPresenter = {
  action: 'respond',
  actions: [
    { key: 'accept', label: 'Accept', style: 'primary', submits: true },
    { key: 'edit', label: 'Edit', style: 'secondary', submits: false },
    { key: 'discard', label: 'Discard', style: 'danger', submits: false },
  ],
  agentId: '88888888-8888-4888-8888-888888888888',
  agentName: 'Agent Designer',
  blocks: [
    {
      markdown:
        'Answers questions about deals, customers and pipeline by looking them '
        + 'up in Sales Portal.\nWorks on demand — you ask, it fetches.\n'
        + 'Posts what it finds back into the channel it was asked in.',
      type: 'text',
    },
    {
      items: [
        { label: 'Lives in', value: 'KiloMayo → Sales → #sales' },
        { label: 'Who can see it', value: 'Everyone in the KiloMayo team' },
      ],
      type: 'fields',
    },
    {
      default: 'anthropic/claude-opus-5',
      input: 'select',
      key: 'model',
      label: 'Model',
      options: [
        { label: 'Claude Opus 5 — strongest here', value: 'anthropic/claude-opus-5' },
        { label: 'Claude Sonnet 5 — cheaper, still strong', value: 'anthropic/claude-sonnet-5' },
        { label: 'GPT-5 mini — cheapest', value: 'openai/gpt-5-mini' },
      ],
      required: true,
      type: 'input',
    },
    {
      blocks: [
        {
          items: ['Sales Portal'],
          label: 'Apps',
          type: 'chips',
        },
        {
          items: [
            'send_message',
            'channel_find',
            'message_search',
            'people_search',
            'web_search',
          ],
          label: 'Tools',
          type: 'chips',
        },
        {
          markdown:
            'No schedule — it runs when somebody asks. It cannot post outside '
            + '#sales.',
          type: 'text',
        },
      ],
      summary: 'What the agent can reach',
      type: 'details',
    },
  ],
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
  waitingFor: ['Ondrej Rafaj'],
}

const client = {
  delete: async () => ({ ok: true }),
  get: async (path: string) => {
    if (path === `/api/agent-cards/${CARD_ID}`) return card
    return null
  },
  patch: async () => ({ ok: true }),
  post: async () => ({ cardId: CARD_ID, responseMessageId: 'message-1', status: 'resolved' }),
  put: async () => ({ ok: true }),
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={['/channels/sales']}>
        <div style={{ background: 'var(--bg)', minHeight: '100vh', padding: '24px' }}>
          <div style={{ maxWidth: '520px' }}>
            <AgentCardMessage metadata={{ agentCard: { cardId: CARD_ID, schemaVersion: 1 } }} />
          </div>
        </div>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
