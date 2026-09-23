import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { AgentDetailTabs } from '../../src/components/features/agents/AgentDetailTabs'
import { ThoughtProcessDialog } from '../../src/components/features/channels/ThoughtProcessDialog'
import type { AgentIdentity } from '../../src/components/shared/agent-identity'
import type { ThinkingEntry } from '../../src/facades/threads/thinking'
import type { AgentRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { AuthSessionProvider, useAuthSession } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * Where a person sees a local program's screenshots
 * (docs/plans/2026-09-22-executor-local-apps/screenshots.md §4): under the
 * tool line in the thought-process dialog, the doorway from a thinking
 * bubble, and on the call's card in the agent page's Activity tab, the home.
 * Both are the real components over the real API client; the runner answers
 * `/api/**`, bytes included, so what it asserts is the request on the wire.
 *
 * `?surface=thought` opens the dialog on a live run whose newest call — a
 * Kelpie screenshot — has not returned yet; `window.__toolScreenshotsFixture`
 * plays the next reasoning chunk and the run's end the way the thread stream
 * would. `?surface=agent` is the agent page on its Activity tab.
 */

const RUN_ID = '50000000-0000-4000-8000-000000000001'
const THREAD_ID = '50000000-0000-4000-8000-000000000002'
const AGENT_ID = '50000000-0000-4000-8000-000000000003'

const surface = new URLSearchParams(location.search).get('surface') ?? 'thought'

const cto: AgentIdentity = { id: AGENT_ID, name: 'CTO', role: 'Chief technology officer' }

const liveThinking: ThinkingEntry[] = [
  { content: 'I will open the pricing page in Kelpie and look at how it renders.', id: '1', kind: 'reasoning' },
  { content: 'executor_mcp_call: server=kelpie, tool=navigate, url=https://example.com', id: '2', kind: 'tool' },
  { content: 'The page loaded. A screenshot will show whether the hero fits.', id: '3', kind: 'reasoning' },
  { content: 'executor_mcp_call: server=kelpie, tool=screenshot', id: '4', kind: 'tool' },
]

const agentRecord = {
  id: AGENT_ID,
  lastActivityAt: '2026-09-23T09:00:00.000Z',
  name: 'CTO',
  provider: 'openai',
  role: 'Chief technology officer',
  status: 'idle',
  systemManaged: false,
  visibility: 'team',
} as unknown as AgentRecord

// The runner plants this token as the stored session and answers `/api/auth/me`
// for it, so the page is a signed-in member's.
const client = createApiClient({ baseUrl: '', token: 'tool-screenshots-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const ThoughtSurface = () => {
  const { token } = useAuthSession()
  const [thinking, setThinking] = useState(liveThinking)
  const [streaming, setStreaming] = useState(true)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    ;(window as typeof window & { __toolScreenshotsFixture: unknown }).__toolScreenshotsFixture = {
      // `stream.reasoning`: the model's next thought, after the call returned.
      reason: (entry: ThinkingEntry) => setThinking((current) => [...current, entry]),
      // `stream.done`: the run ended and its reply landed.
      streamDone: () => setStreaming(false),
    }
  }, [])

  return (
    <main className="grid min-h-screen content-start gap-2 bg-[color:var(--main)] px-5 py-6 text-[color:var(--tx)]">
      <h1 className="text-lg font-semibold">Website review</h1>
      <p className="text-sm text-[color:var(--tx2)]">Ondrej: How does the pricing page look on a laptop?</p>
      {open ? (
        <ThoughtProcessDialog
          agent={cto}
          agentName={cto.name}
          entry={{ agentId: AGENT_ID, content: '', rootMessageId: null, runId: RUN_ID, thinking }}
          onClose={() => setOpen(false)}
          streaming={streaming}
          threadId={THREAD_ID}
          token={token}
        />
      ) : (
        <p data-testid="thought-process-closed">Thought process closed</p>
      )}
    </main>
  )
}

const AgentSurface = () => (
  <main
    aria-label="Agent page"
    className="flex h-screen flex-col bg-[color:var(--main)] text-[color:var(--tx)]"
  >
    <h1 className="px-[var(--page-gutter)] pt-4 text-lg font-semibold">CTO</h1>
    <div className="min-h-0 flex-1">
      <AgentDetailTabs agent={agentRecord} />
    </div>
  </main>
)

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Tool screenshots fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <BrowserRouter>
          <LocalBackProvider>
            {surface === 'agent' ? <AgentSurface /> : <ThoughtSurface />}
          </LocalBackProvider>
        </BrowserRouter>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
