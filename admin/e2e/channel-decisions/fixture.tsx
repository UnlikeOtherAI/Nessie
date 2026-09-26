import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { ChannelDecisionPolicySchema, ChannelRecordSchema } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createMemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { ConversationDetails } from '../../src/components/features/channels/details/ConversationDetails'
import { detailsPath } from '../../src/components/features/channels/details/details-sections'
import { PhoneNavigationProvider } from '../../src/layouts/admin-shell/PhoneNavigationProvider'
import type { AgentRecord, ChannelRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * A room's Details › How agents respond, driven through the real panel: the
 * header's Details doorway, the section strip, the policy editor and its Save.
 * Only the API is substituted — writes land in `stored` and are listed in
 * `writes` — so the flow is the product's own.
 *
 * The router is a memory router whose location is mirrored into this page's
 * own `?at=`: a reload starts the router where it was, which is how the run
 * proves a section is part of the address rather than component state. Every
 * router navigation's kind is recorded, so it can prove a section switch
 * replaces rather than pushes.
 */

const uuid = (digit: number) => `${digit.toString().repeat(8)}-1111-4111-8111-111111111111`
const AGENT_ID = uuid(7)
const CHANNEL_ID = uuid(1)
let stored = ChannelRecordSchema.parse({
  id: CHANNEL_ID, label: 'product-decisions', topic: 'Weekly product decisions', description: 'Keep useful context.',
  type: 'standard', visibility: 'public', organizationId: uuid(2), projectId: uuid(3),
  projectName: 'Product', teamId: uuid(4), teamName: 'Design', defaultThreadId: uuid(5),
  viewerCanManage: true, viewerCanManageAgents: true, viewerIsMember: true, muted: false,
  decisionPolicy: null, createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z',
})
let emitChannel: (channel: ChannelRecord) => void = () => {}
let failNextSave = false
const writes: unknown[] = []
const actions: string[] = []

const client = {
  get: async () => null,
  patch: async (_path: string, body: Record<string, unknown>) => {
    if (failNextSave) {
      failNextSave = false
      throw new Error('Unable to save channel. Try again.')
    }
    if (body.decisionPolicy) ChannelDecisionPolicySchema.parse(body.decisionPolicy)
    writes.push(body)
    stored = ChannelRecordSchema.parse({ ...stored, ...body })
    emitChannel(stored)
    return stored
  },
} as unknown as ApiClient

const agents = [{
  id: AGENT_ID, name: 'Decision keeper', role: 'Keeps the decision log', status: 'idle',
  visibility: 'team', channelIds: [stored.id],
}] as unknown as AgentRecord[]
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Conversation = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const [channel, setChannel] = useState(stored)
  useEffect(() => {
    emitChannel = setChannel
    Object.assign(window, {
      __channelDecisionsFixture: {
        actions,
        agentId: AGENT_ID,
        failNextSave: () => { failNextSave = true },
        refresh: (update: Partial<ChannelRecord>) => {
          stored = ChannelRecordSchema.parse({ ...stored, ...update })
          setChannel(stored)
        },
        saved: () => stored,
        writes,
      },
    })
  }, [])
  return (
    <main className="min-h-screen bg-[var(--bg)] p-4 text-[color:var(--tx)]">
      <h1 className="mb-4 text-lg font-semibold">#{channel.label}</h1>
      {/* The conversation header's gear: Details, carrying the room's own `?tab=`. */}
      <button
        className="admin-button admin-button-secondary"
        onClick={() => void navigate(detailsPath(channel.id, 'general', location.search))}
        type="button"
      >
        Details
      </button>
      <ConversationDetails
        agentTools={[]}
        agents={agents}
        allUsers={[]}
        boundAgents={agents}
        channel={channel}
        channelUsers={[]}
        currentUserId={uuid(6)}
        onClose={() => void navigate(`/channels/${channel.id}`)}
        onOpenTool={() => {}}
        personalAssistantPresences={[]}
        threadId={null}
      />
    </main>
  )
}

const initial = new URLSearchParams(window.location.search).get('at') ?? `/channels/${CHANNEL_ID}?tab=messages`
const router = createMemoryRouter(
  [{
    element: <LocalBackProvider><PhoneNavigationProvider><Conversation /></PhoneNavigationProvider></LocalBackProvider>,
    path: '/channels/:channelId/*',
  }],
  { initialEntries: [initial] },
)
router.subscribe((state) => {
  actions.push(state.historyAction)
  const at = `${state.location.pathname}${state.location.search}`
  window.history.replaceState(null, '', `?at=${encodeURIComponent(at)}`)
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
