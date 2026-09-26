import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { ExecutorRunLauncherDialog } from '../../src/components/features/executors/ExecutorRunLauncherDialog'
import type { AgentRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * The composer's "Run on a computer" doorway, driven by the real dialog and
 * the real API client. The runner answers `/api/**` itself, so what it asserts
 * about the launch is the request the dialog actually put on the wire — the
 * bundle a person picked is the whole grant, and a dialog that posted one
 * operation of the pair would look identical on screen.
 */

// Ids the runner reads back out of the posted payloads.
const AGENT_ID = '00000000-0000-4000-8000-0000000000a7'
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b7'
const THREAD_ID = '00000000-0000-4000-8000-0000000000c7'

const agents = [
  {
    id: AGENT_ID,
    name: 'CTO',
    role: 'Chief technology officer',
    status: 'idle',
    systemManaged: false,
    visibility: 'team',
  } as unknown as AgentRecord,
]

const client = createApiClient({ baseUrl: '', token: 'executor-run-launcher-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  const [open, setOpen] = useState(true)
  const [launched, setLaunched] = useState(false)
  return (
    <main className="min-h-screen bg-[color:var(--bg)] p-8 text-[color:var(--tx)]">
      <h1 className="text-lg font-semibold">Project channel</h1>
      <button className="admin-button admin-button-secondary" onClick={() => setOpen(true)} type="button">
        Run on a computer
      </button>
      {launched ? <p>Computer run started</p> : null}
      <ExecutorRunLauncherDialog
        agents={agents}
        initialContent="Take the tickets one at a time."
        onClose={() => setOpen(false)}
        onLaunched={() => setLaunched(true)}
        open={open}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
      />
    </main>
  )
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor run launcher fixture root is missing.')
// The dialog carries the person's own conversation lease, which listens on the
// session's event stream; the runner answers the session read as signed out,
// which keeps that stream closed.
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <BrowserRouter>
          <LocalBackProvider>
            <Fixture />
          </LocalBackProvider>
        </BrowserRouter>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
