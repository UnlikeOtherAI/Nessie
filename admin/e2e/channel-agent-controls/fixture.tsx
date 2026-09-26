import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { ChannelRecordSchema } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { DetailsAgents } from '../../src/components/features/channels/details/DetailsAgents'
import { DetailsPeople, canAddPeople } from '../../src/components/features/channels/details/DetailsPeople'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import type { AgentRecord, UserRecord } from '../../src/lib/api-client'
import '../../src/styles.css'

/**
 * A room's Details › People and › Agents at each authority.
 *
 * Adding a PERSON is any member of the channel (`viewerCanManage`); placing an
 * AGENT takes organisation owner or admin standing and NOT membership
 * (`viewerCanManageAgents`). A control somebody could use with that standing
 * is shown disabled with who can use it (plan R9) rather than pressed into a
 * 403. The fixture renders the real sections at each answer — including the
 * case the two authorities pull apart: an admin outside the room, who may
 * place an agent in it and may not speak in it.
 */

const VIEWER = '11111111-1111-4111-8111-111111111111'
const CHANNEL = '55555555-5555-4555-8555-555555555555'

const user = (id: string, name: string): UserRecord =>
  ({ displayName: name, email: `${name.toLowerCase()}@example.com`, id } as unknown as UserRecord)

const agent = (id: string, name: string, role: string): AgentRecord =>
  ({ id, name, role, status: 'idle', systemManaged: false, visibility: 'team' } as unknown as AgentRecord)

const BOUND = agent('22222222-2222-4222-8222-222222222222', 'Sales agent', 'sales researcher')
const AVAILABLE = agent('33333333-3333-4333-8333-333333333333', 'Support agent', 'support triage')

const channelRecord = (flags: { canManageAgents: boolean; isMember: boolean }) =>
  ChannelRecordSchema.parse({
    createdAt: '2026-09-21T10:00:00.000Z',
    defaultThreadId: '66666666-6666-4666-8666-666666666666',
    id: CHANNEL,
    label: 'sales',
    organizationId: '77777777-7777-4777-8777-777777777777',
    projectId: '88888888-8888-4888-8888-888888888888',
    projectName: 'Sales',
    teamId: '99999999-9999-4999-8999-999999999999',
    teamName: 'Revenue',
    type: 'standard',
    updatedAt: '2026-09-21T10:00:00.000Z',
    viewerCanManage: flags.isMember,
    viewerCanManageAgents: flags.canManageAgents,
    viewerIsMember: flags.isMember,
    visibility: 'public',
  })

const client = {
  delete: async () => ({ ok: true }),
  get: async () => null,
  patch: async () => ({ ok: true }),
  post: async () => ({ ok: true }),
  put: async () => ({ ok: true }),
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  const [canManageAgents, setCanManageAgents] = useState(false)
  // Whether this viewer is IN the channel, which is a different question from
  // whether they may place an agent in it.
  const [isMember, setIsMember] = useState(true)
  useEffect(() => {
    ;(window as typeof window & { __channelAgentControlsFixture: unknown })
      .__channelAgentControlsFixture = { setCanManageAgents, setViewerIsMember: setIsMember }
  }, [])
  const channel = channelRecord({ canManageAgents, isMember })
  const channelUsers = isMember ? [user(VIEWER, 'Viewer'), user('44444444-4444-4444-8444-444444444444', 'Colleague')] : []
  return (
    <main className="grid gap-6 p-4" style={{ background: 'var(--main)', minHeight: '100vh' }}>
      <section aria-label="People" className="grid gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[color:var(--tx)]">People</h2>
          {/* The header's Add people action, which the panel offers exactly when this does. */}
          <button className="admin-button admin-button-primary" disabled={!canAddPeople(channel)} type="button">
            Add people
          </button>
        </div>
        <DetailsPeople channel={channel} channelUsers={channelUsers} currentUserId={VIEWER} />
      </section>
      <section aria-label="Agents" className="grid gap-3">
        <h2 className="text-sm font-semibold text-[color:var(--tx)]">Agents</h2>
        <DetailsAgents
          agents={[BOUND, AVAILABLE]}
          boundAgents={[BOUND]}
          channel={channel}
          currentUserId={VIEWER}
          personalAssistantPresences={[]}
        />
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={[`/channels/${CHANNEL}/info/members`]}>
          <Fixture />
        </MemoryRouter>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
