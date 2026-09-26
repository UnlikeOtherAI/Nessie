import { ApiClientProvider } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TaskSetCreatePage } from '../../src/pages/TaskSetCreatePage'
import { TaskSetDetailPage } from '../../src/pages/TaskSetDetailPage'
import { TaskSetsPage } from '../../src/pages/TaskSetsPage'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { taskSetCreatePath, taskSetPath } from '../../src/navigation/task-sets'
import { client, ids } from './transport'
import '../../src/styles.css'

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'create'
const entry = scenario === 'create' ? '/admin/automations/batch-jobs/new'
  : scenario === 'source' ? taskSetCreatePath({ pageId: ids.page, versionId: ids.version, format: 'xlsx' })
    : scenario === 'list' ? '/admin/automations?tab=batch-jobs' : taskSetPath(ids.set)
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={query}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <LocalBackProvider>
          <main className="h-dvh bg-[var(--bg)] text-[color:var(--tx)]">
            <Routes>
              <Route element={<TaskSetsPage />} path="/admin/automations" />
              <Route element={<TaskSetCreatePage />} path="/admin/automations/batch-jobs/new" />
              <Route element={<TaskSetDetailPage />} path="/admin/automations/batch-jobs/:taskSetId" />
            </Routes>
          </main>
        </LocalBackProvider>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
