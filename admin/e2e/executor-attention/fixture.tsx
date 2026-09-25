import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ExecutorRecordResponseSchema } from '@nessie/schemas'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'
import { ExecutorsTable } from '../../src/components/features/executors/ExecutorsTable'
import { AdminSidebarNav } from '../../src/layouts/admin-shell/AdminSidebarNav'
import '../../src/styles.css'

const client = createApiClient({ baseUrl: '', token: 'executor-attention-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const executorIds = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
const executors = executorIds.map((id, index) => ExecutorRecordResponseSchema.parse({
  authorizationRevision: 1,
  createdAt: '2026-09-21T00:00:00.000Z',
  id,
  label: index === 0 ? 'Office Mac' : 'Studio PC',
  profiles: ['workspace_sandbox'],
  scope: { kind: 'private', organizationId: '22222222-2222-4222-8222-222222222222' },
  status: 'online',
  updatedAt: '2026-09-21T00:00:00.000Z',
}))

const Fixture = () => {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--bg)] text-[color:var(--tx)] md:flex-row">
      <div className="h-80 w-full shrink-0 md:h-screen md:w-64">
        <AdminSidebarNav
          canManageOrganization={false}
          isAdmin={false}
          isOwner={false}
          isSuperAdmin={false}
          isUoaSession
          pathname={location.pathname}
        />
      </div>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <h1 className="mb-4 text-xl font-semibold">Executors</h1>
        <ExecutorsTable
          emptyMessage="No machines paired."
          executors={executors}
          isLoading={false}
          onOpen={(id) => navigate(`/agents/executors/${id}`)}
        />
      </main>
    </div>
  )
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor inventory fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <ApiClientProvider client={client}>
      <BrowserRouter><Fixture /></BrowserRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
