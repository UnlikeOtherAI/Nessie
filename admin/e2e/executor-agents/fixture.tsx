import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { ExecutorAgentsPanel } from '../../src/components/features/executors/ExecutorAgentsPanel'
import { ExecutorAccessChangeDialog } from '../../src/components/features/executors/ExecutorReviewDialogs'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

const executorId = '33333333-3333-4333-8333-333333333333'
const client = createApiClient({ baseUrl: '', token: 'executor-agents-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  const [prepared, setPrepared] = useState<PreparedExecutorAccessChangeResponse | null>(null)
  return (
    <QueryClientProvider client={queries}>
      <ApiClientProvider client={client}>
        <BrowserRouter>
          <LocalBackProvider>
            <main className="min-h-screen bg-[color:var(--main)] p-5 text-[color:var(--tx)]">
              <h1 className="mb-5 text-xl font-semibold">Studio Mac</h1>
              <ExecutorAgentsPanel executorId={executorId} onPrepared={setPrepared} scopeKind="private" token={null} />
              {prepared ? (
                <ExecutorAccessChangeDialog
                  accessChangeId={prepared.accessChangeId}
                  confirmationToken={prepared.confirmationToken}
                  onClose={() => setPrepared(null)}
                  open
                />
              ) : null}
            </main>
          </LocalBackProvider>
        </BrowserRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  )
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor agents fixture root is missing.')
createRoot(root).render(<Fixture />)
