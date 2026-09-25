import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AgentCardMessage } from '../../src/components/features/channels/AgentCardMessage'
import { ExecutorAgentsPanel } from '../../src/components/features/executors/ExecutorAgentsPanel'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

const executorId = '33333333-3333-4333-8333-333333333333'
// The confirmation card an assistant posts when it prepares a change in chat.
// Its press answers with a token minted for the presser, and the card opens
// the same review dialog this page mounts for a change prepared here.
const reviewCardId = '55555555-5555-4555-8555-555555555555'
const client = createApiClient({ baseUrl: '', token: 'executor-agents-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  return (
    <QueryClientProvider client={queries}>
      <ApiClientProvider client={client}>
        <BrowserRouter>
          <LocalBackProvider>
            <main className="min-h-screen bg-[color:var(--main)] p-5 text-[color:var(--tx)]">
              <h1 className="mb-5 text-xl font-semibold">Studio Mac</h1>
              <ExecutorAgentsPanel executorId={executorId} scopeKind="private" token={null} />
              <section aria-label="Chat confirmation card" className="mt-8 max-w-[520px]">
                <AgentCardMessage metadata={{ agentCard: { cardId: reviewCardId, schemaVersion: 1 } }} />
              </section>
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
