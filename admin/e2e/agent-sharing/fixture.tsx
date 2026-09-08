import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'

import { AgentOwnershipState } from '../../src/components/features/agents/AgentOwnershipState'
import { AgentVisibilityPicker } from '../../src/components/features/agents/AgentVisibilityPicker'
import { ApiClientProvider } from '../../src/providers/ApiClientProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

const timestamp = '2026-09-08T10:00:00.000Z'
const userId = '00000000-0000-4000-8000-000000000105'
const agent = {
  channelIds: ['00000000-0000-4000-8000-000000000106'],
  createdAt: timestamp,
  id: '00000000-0000-4000-8000-000000000101',
  lastActivityAt: timestamp,
  name: 'Morning Joke',
  owner: { displayName: 'Taylor', id: userId },
  ownerUserId: userId,
  role: 'assistant',
  status: 'idle' as const,
  todosEnabled: false,
  updatedAt: timestamp,
  visibility: 'team' as const,
}
const me = {
  auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local-bootstrap' as const },
  context: {
    bootstrapMode: false,
    organizationId: '00000000-0000-4000-8000-000000000102',
    projectId: '00000000-0000-4000-8000-000000000103',
    teamId: '00000000-0000-4000-8000-000000000104',
  },
  session: { issuedAt: timestamp, sessionId: 'agent-sharing-e2e' },
  user: { displayName: 'Taylor', email: 'taylor@example.test', id: userId, roleIds: ['owner'], superAdmin: false },
}

window.localStorage.setItem('nessie.admin.token', 'agent-sharing-e2e')
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin)
  if (url.pathname === '/api/auth/me') return Response.json({ data: me })
  if (url.pathname === `/api/agents/${agent.id}` && init?.method === 'PUT') {
    return Response.json({ data: { ...agent, owner: null, ownerUserId: null } })
  }
  return Response.json({ data: [] })
}

const Fixture = () => (
  <QueryClientProvider client={new QueryClient()}>
    <AuthSessionProvider>
      <ApiClientProvider>
        <main className="min-h-screen bg-[color:var(--main)] p-10 text-[color:var(--tx)]">
          <section className="max-w-3xl rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-6 shadow-sm">
            <p className="text-sm text-[color:var(--tx3)]">Agent</p>
            <h1 className="mt-1 text-2xl font-semibold">Morning Joke</h1>
            <AgentOwnershipState agent={agent} />
            <div className="mt-8 max-w-xl">
              <AgentVisibilityPicker onChange={() => undefined} value="team" />
            </div>
          </section>
        </main>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>
)

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Agent-sharing fixture root is missing.')
createRoot(root).render(<Fixture />)
