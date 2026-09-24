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
 *
 * There is deliberately no second bubble beside it: the Designer's own words
 * are the card's `message`, above the header, with the decision at the bottom.
 */

const CARD_ID = '77777777-7777-4777-8777-777777777777'

const card: AgentCardPresenter = {
  action: 'respond',
  actions: [
    { key: 'accept', label: 'Accept', style: 'primary', submits: true },
    { key: 'edit', label: 'Edit', style: 'secondary', submits: false },
    { key: 'decline', label: 'Decline', style: 'danger', submits: false },
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
  message:
    'Here is the sales agent I would build — it looks things up in Sales Portal '
    + 'and answers in the channel it was asked in. Press Accept, or tell me what '
    + 'to change.',
  messageId: '99999999-9999-4999-8999-999999999999',
  resolution: null,
  service: null,
  status: 'open',
  subtitle: 'sales researcher',
  threadId: '55555555-5555-4555-8555-555555555555',
  title: 'Sales agent',
  waitingFor: ['Ondrej Rafaj'],
}

// F22: an agent nobody named a place for is proposed living nowhere yet —
// never in a channel the Designer would make for it. The same standard card;
// its placement field is the part that matters. Its job needs no room of its
// own: an agent that works a project's board has to live in one of that
// project's channels, so it is never the agent proposed living nowhere.
const UNPLACED_CARD_ID = '77777777-7777-4777-8777-777777777778'

const unplacedCard: AgentCardPresenter = {
  ...card,
  blocks: [
    {
      markdown:
        'Researches a company or a market on the web when you ask.\n'
        + 'Works on demand — you ask, it looks things up.\n'
        + 'Answers wherever it was asked, with its sources.',
      type: 'text',
    },
    {
      items: [
        { label: 'Lives in', value: 'nowhere yet — add it to any channel' },
        { label: 'Who can see it', value: 'Everyone in the KiloMayo team' },
      ],
      type: 'fields',
    },
    card.blocks[2]!,
    {
      blocks: [
        { items: ['web_search', 'web_fetch', 'people_search'], label: 'Tools', type: 'chips' },
        { markdown: 'No schedule — it runs when somebody asks.', type: 'text' },
      ],
      summary: 'What the agent can reach',
      type: 'details',
    },
  ],
  cardId: UNPLACED_CARD_ID,
  message:
    'Here is the researcher I would build. It lives nowhere yet, so add it to '
    + 'any channel you want it in. Press Accept, or tell me what to change.',
  messageId: '99999999-9999-4999-8999-999999999998',
  subtitle: 'market researcher',
  title: 'Research analyst',
}

// T1 of docs/plans/2026-09-23-ticket-driven-agents: an agent that picks up a
// board's tickets says, on the same fields block, the moment its work starts.
// T4 adds "Runs on": the machines by name on this card, which the person who
// paired them reads in their own conversation with the Designer, and the one
// machine-access confirmation that follows, in the card's message.
const TICKET_CARD_ID = '77777777-7777-4777-8777-777777777779'

const ticketCard: AgentCardPresenter = {
  ...card,
  blocks: [
    {
      markdown:
        'Picks up the Engineering tickets people move into In progress.\n'
        + 'Reads each one, comments a plan on it and asks there when something is unclear.\n'
        + 'Moves it to Review when it is ready for a person.',
      type: 'text',
    },
    {
      items: [
        { label: 'Lives in', value: 'KiloMayo → Nessie → #eng' },
        { label: 'Who can see it', value: 'Everyone in the KiloMayo team' },
        { label: 'Starts work when', value: 'Someone moves a ticket into In progress on Engineering' },
        { label: 'Runs on', value: 'Studio and Minis' },
      ],
      type: 'fields',
    },
    card.blocks[2]!,
    {
      blocks: [
        {
          items: ['ticket_read', 'ticket_comment_add', 'ticket_move', 'ticket_board_read'],
          label: 'Tools',
          type: 'chips',
        },
        {
          markdown: 'One work thread per ticket in #eng, which everyone on the project can read.',
          type: 'text',
        },
      ],
      summary: 'What the agent can reach',
      type: 'details',
    },
  ],
  cardId: TICKET_CARD_ID,
  message:
    'Here is the CTO I would build. It starts on a ticket when someone moves it into In progress, '
    + 'and works it on Studio and Minis. One machine-access confirmation follows, which you confirm '
    + 'with your password. Press Accept, or tell me what to change.',
  messageId: '99999999-9999-4999-8999-999999999997',
  subtitle: 'ticket triage',
  title: 'CTO',
}

// The same agent for someone who did not pair the machines: the card never
// names them, and says whose password the one confirmation takes.
const OWNER_CONFIRMS_CARD_ID = '77777777-7777-4777-8777-77777777777a'

const ownerConfirmsCard: AgentCardPresenter = {
  ...ticketCard,
  blocks: ticketCard.blocks.map((block) => block.type === 'fields'
    ? {
        ...block,
        items: block.items.map((item) =>
          item.label === 'Runs on' ? { ...item, value: 'a machine its owner confirms' } : item),
      }
    : block),
  cardId: OWNER_CONFIRMS_CARD_ID,
  message:
    'Here is the CTO I would build. It starts on a ticket when someone moves it into In progress. '
    + 'One machine-access confirmation follows, which the machines\' owner confirms with their password. '
    + 'Press Accept, or tell me what to change.',
  messageId: '99999999-9999-4999-8999-999999999996',
}

const cards = new Map([
  [CARD_ID, card],
  [UNPLACED_CARD_ID, unplacedCard],
  [TICKET_CARD_ID, ticketCard],
  [OWNER_CONFIRMS_CARD_ID, ownerConfirmsCard],
])

const client = {
  delete: async () => ({ ok: true }),
  get: async (path: string) => {
    const match = /^\/api\/agent-cards\/([^/]+)$/.exec(path)
    return (match ? cards.get(match[1] ?? '') : undefined) ?? null
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
          <div style={{ display: 'grid', gap: '24px', maxWidth: '520px' }}>
            <div data-testid="placed-proposal">
              <AgentCardMessage metadata={{ agentCard: { cardId: CARD_ID, schemaVersion: 1 } }} />
            </div>
            <div data-testid="unplaced-proposal">
              <AgentCardMessage metadata={{ agentCard: { cardId: UNPLACED_CARD_ID, schemaVersion: 1 } }} />
            </div>
            <div data-testid="ticket-proposal">
              <AgentCardMessage metadata={{ agentCard: { cardId: TICKET_CARD_ID, schemaVersion: 1 } }} />
            </div>
            <div data-testid="owner-confirms-proposal">
              <AgentCardMessage metadata={{ agentCard: { cardId: OWNER_CONFIRMS_CARD_ID, schemaVersion: 1 } }} />
            </div>
          </div>
        </div>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
