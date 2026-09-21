import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ExecutorDetailContent } from '../../src/pages/ExecutorDetailPage'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

const client = createApiClient({ baseUrl: '', token: 'executor-detail-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor detail fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/executors/33333333-3333-4333-8333-333333333333']}>
        <LocalBackProvider><main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
          <Routes><Route path="/agents/executors/:executorId" element={<ExecutorDetailContent token={null} />} /></Routes>
        </main></LocalBackProvider>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
