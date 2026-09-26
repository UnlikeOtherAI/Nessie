import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { HashRouter, Route, Routes } from 'react-router-dom'

import { ShellStateProvider } from '../../src/layouts/admin-shell/ShellStateContext'
import { PhoneNavigationProvider } from '../../src/layouts/admin-shell/PhoneNavigationProvider'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { ExecutorDetailContent } from '../../src/pages/ExecutorDetailPage'
import { ExecutorSessionPage } from '../../src/pages/ExecutorSessionPage'
import { ExecutorSessionsPage } from '../../src/pages/ExecutorSessionsPage'
import '../../src/styles.css'

/**
 * The coding sessions open on a machine, drawn by the real executor page on
 * its Sessions tab — the Local apps section, the coding bridge's status
 * and its session list with Close — over the real facade hooks and API
 * client. Every API answer is the runner's
 * (docs/executor-protocol/host-coding-sessions.md → "The executor page"), so
 * who may Close and which agent a reader may see are the API route tests'
 * decisions; here the pairing owner and another administrator differ only in
 * what `GET /api/executors/:id/coding-sessions` answers them.
 */

const EXECUTOR_ID = '33333333-3333-4333-8333-333333333333'
const initialPath = new URLSearchParams(window.location.search).get('sessions') === '1'
  ? '/agents/executor-sessions' : `/agents/executors/${EXECUTOR_ID}?tab=sessions`
// Keep the fixture document served by Vite while exercising real browser history and reload.
if (!window.location.hash) window.history.replaceState(null, '', `${window.location.href}#${initialPath}`)

const client = createApiClient({ baseUrl: '', token: 'executor-coding-sessions-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor coding sessions fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <ApiClientProvider client={client}>
      <HashRouter>
        <LocalBackProvider>
          <ShellStateProvider value={{ onCreateAgent: () => undefined, onCreateChannel: () => undefined,
            onSelectAgent: () => undefined, onLogout: () => undefined, openDrawer: () => undefined,
            showHeaderAccountMenu: false }}>
          <PhoneNavigationProvider>
          <main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
            <Routes>
              <Route path="/agents/executors/:executorId" element={<ExecutorDetailContent token={null} />} />
              <Route path="/agents/executors/:executorId/sessions/:sessionId" element={<ExecutorSessionPage />} />
              <Route path="/agents/executor-sessions" element={<ExecutorSessionsPage />} />
            </Routes>
          </main>
          </PhoneNavigationProvider>
          </ShellStateProvider>
        </LocalBackProvider>
      </HashRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
