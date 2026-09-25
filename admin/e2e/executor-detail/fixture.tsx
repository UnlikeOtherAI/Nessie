import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ExecutorDetailContent } from '../../src/pages/ExecutorDetailPage'
import { ProjectExecutorsTab } from '../../src/pages/project/ProjectExecutorsTab'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

const client = createApiClient({ baseUrl: '', token: 'executor-detail-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.querySelector('#root')
const projectView = new URLSearchParams(window.location.search).has('project')
if (!(root instanceof HTMLElement)) throw new Error('Executor detail fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={[projectView ? '/project-executors' : '/agents/executors/33333333-3333-4333-8333-333333333333']}>
        <LocalBackProvider><main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
          <Routes>
            <Route path="/agents/executors/:executorId" element={<ExecutorDetailContent teamId="77777777-7777-4777-8777-777777777777" token={null} />} />
            <Route path="/project-executors" element={<ProjectExecutorsTab projectId="11111111-1111-4111-8111-111111111111" />} />
          </Routes>
        </main></LocalBackProvider>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
