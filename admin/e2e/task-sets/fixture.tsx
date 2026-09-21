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
const entry = scenario === 'create' ? '/agents/task-sets/new'
  : scenario === 'source' ? taskSetCreatePath({ pageId: ids.page, versionId: ids.version, format: 'xlsx' })
    : scenario === 'list' ? '/agents/task-sets' : taskSetPath(ids.set)
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={query}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <LocalBackProvider>
          <main className="h-dvh bg-[var(--bg)] text-[color:var(--tx)]">
            <Routes>
              <Route element={<TaskSetsPage />} path="/agents/task-sets" />
              <Route element={<TaskSetCreatePage />} path="/agents/task-sets/new" />
              <Route element={<TaskSetDetailPage />} path="/agents/task-sets/:taskSetId" />
            </Routes>
          </main>
        </LocalBackProvider>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
