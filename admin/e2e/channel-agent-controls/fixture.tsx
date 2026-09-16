import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { ChannelMembersPopup } from '../../src/components/shared/ChannelMembersPopup'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import type { AgentRecord, UserRecord } from '../../src/lib/api-client'
import '../../src/styles.css'

/**
 * The channel members popup at both authorities.
 *
 * Adding a PERSON is any member of the channel; adding an AGENT additionally
 * requires the organisation owner role. The popup drew the agent controls for
 * everybody, so an ordinary member saw an "Add" whose only outcome was a 403.
 * The fixture renders the real popup at each answer so the difference is
 * something a person can look at.
 */

const VIEWER = '11111111-1111-4111-8111-111111111111'

const user = (id: string, name: string): UserRecord =>
  ({ displayName: name, email: `${name.toLowerCase()}@example.com`, id } as unknown as UserRecord)

const agent = (id: string, name: string, role: string): AgentRecord =>
  ({ id, name, role, status: 'idle', systemManaged: false, visibility: 'team' } as unknown as AgentRecord)

const BOUND = agent('22222222-2222-4222-8222-222222222222', 'Sales agent', 'sales researcher')
const AVAILABLE = agent('33333333-3333-4333-8333-333333333333', 'Support agent', 'support triage')

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
  // The popup is a modal overlay and covers anything rendered beside it, so
  // the authority is switched from the runner rather than by clicking a
  // control the overlay would intercept.
  useEffect(() => {
    ;(window as typeof window & { __channelAgentControlsFixture: unknown })
      .__channelAgentControlsFixture = { setCanManageAgents }
  }, [])
  return (
    <div style={{ background: 'var(--bg)', minHeight: '100vh', padding: '16px' }}>
      <ChannelMembersPopup
        allAgents={[BOUND, AVAILABLE]}
        allUsers={[user(VIEWER, 'Viewer'), user('44444444-4444-4444-8444-444444444444', 'Colleague')]}
        boundAgents={[BOUND]}
        channelId="55555555-5555-4555-8555-555555555555"
        channelLabel="sales"
        channelUsers={[user(VIEWER, 'Viewer')]}
        currentUserId={VIEWER}
        personalAssistantPresences={[]}
        viewerCanManage
        viewerCanManageAgents={canManageAgents}
        onClose={() => {}}
        onSelectAgent={() => {}}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={['/channels/sales']}>
          <Fixture />
        </MemoryRouter>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
