import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { AgentIdentityBlock } from '../../src/components/features/agents/AgentIdentityBlock'
import { ChannelLiveStreamTail } from '../../src/components/features/channels/ChannelLiveStreamTail'
import { ThinkingBubble } from '../../src/components/features/channels/ThinkingBubble'
import type { AgentIdentity } from '../../src/components/shared/agent-identity'
import { agentKeys } from '../../src/facades/agents/keys'
import type { PendingStreamMessage } from '../../src/facades/threads/thinking'
import type { AgentRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

/**
 * Stop where a person watches a run: the thinking bubble at the tail of a
 * channel, the compact one under a thread's root, and the agent page's status
 * pill — all real components over the real API client, with the runner
 * answering `/api/**` so the cancel it asserts is the request on the wire.
 *
 * The run's live state is driven the way the product drives it: a bubble
 * leaves when `stream.done` would remove it, and the agent header re-reads
 * its status when `run.updated` would invalidate it. Both are exposed on
 * `window.__runStopFixture` for the runner.
 */

const RUN_CHANNEL = '00000000-0000-4000-8000-0000000000a1'
const RUN_THREAD = '00000000-0000-4000-8000-0000000000a2'
const AGENT_PAGE_ID = '00000000-0000-4000-8000-0000000000b3'

const cto: AgentIdentity = { id: '00000000-0000-4000-8000-0000000000b1', name: 'CTO', role: 'Chief technology officer' }
const researcher: AgentIdentity = { id: '00000000-0000-4000-8000-0000000000b2', name: 'Researcher', role: 'Web researcher' }

const initialEntries: PendingStreamMessage[] = [
  {
    agentId: cto.id,
    content: '',
    rootMessageId: null,
    runId: RUN_CHANNEL,
    thinking: [
      { content: 'Reading the open tickets on the board.', id: '1', kind: 'reasoning' },
      { content: 'executor_mcp_call kelpie navigate', id: '2', kind: 'tool' },
    ],
  },
  {
    agentId: researcher.id,
    content: '',
    rootMessageId: '00000000-0000-4000-8000-0000000000c1',
    runId: RUN_THREAD,
    thinking: [{ content: 'Searching for the release notes.', id: '3', kind: 'reasoning' }],
  },
]

const agentRecord = (status: 'idle' | 'thinking') => ({
  id: AGENT_PAGE_ID,
  lastActivityAt: '2026-09-23T09:00:00.000Z',
  name: 'Release manager',
  provider: 'openai',
  role: 'Ships the weekly release',
  status,
  systemManaged: false,
  visibility: 'team',
}) as unknown as AgentRecord

const client = createApiClient({ baseUrl: '', token: 'run-stop-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  const [entries, setEntries] = useState(initialEntries)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking'>('thinking')
  const [opened, setOpened] = useState<string[]>([])

  useEffect(() => {
    ;(window as typeof window & { __runStopFixture: unknown }).__runStopFixture = {
      // `stream.done` for that run: the bubble is removed.
      streamDone: (runId: string) => {
        setEntries((current) => current.filter((entry) => entry.runId !== runId))
      },
      // `run.updated`: the agent caches are invalidated and re-read.
      runUpdated: (status: 'idle' | 'thinking') => {
        setAgentStatus(status)
        void queries.invalidateQueries({ queryKey: agentKeys.status(AGENT_PAGE_ID) })
      },
    }
  }, [])

  const open = (runId: string) => setOpened((current) => [...current, runId])
  const threadEntry = entries.find((entry) => entry.runId === RUN_THREAD)

  return (
    <main className="grid min-h-screen content-start gap-6 bg-[color:var(--bg)] py-6 text-[color:var(--tx)]">
      <section aria-label="Channel" className="grid gap-1">
        <h1 className="px-5 text-lg font-semibold">Project channel</h1>
        <article className="admin-msg-row relative py-1">
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-bold">Ondrej</span>
            <p>Find the release notes for 0.1.12, please.</p>
          </div>
        </article>
        {threadEntry ? (
          <ThinkingBubble
            agent={researcher}
            agentName={researcher.name}
            entry={threadEntry}
            onOpen={open}
            token={null}
            variant="compact"
          />
        ) : null}
        <ChannelLiveStreamTail
          isDedicatedAgentConversation={false}
          onOpenThoughtProcess={open}
          pendingMessages={entries.filter((entry) => entry.rootMessageId === null)}
          renderContent={(text) => text}
          resolveAgentIdentity={() => ({ agent: cto, name: cto.name })}
          thinkingSurface="channel"
          token={null}
        />
      </section>

      <section aria-label="Agent page" className="flex items-start gap-3 px-5">
        <AgentIdentityBlock
          agent={agentRecord(agentStatus)}
          avatar={false}
          canEditAvatar={false}
          headingLevel="h2"
        />
      </section>

      <p className="px-5 text-xs text-[color:var(--tx3)]" data-testid="opened">
        {opened.length > 0 ? `Opened: ${opened.join(', ')}` : 'Nothing opened'}
      </p>
    </main>
  )
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Run stop fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <ApiClientProvider client={client}>
      <BrowserRouter>
        <LocalBackProvider>
          <Fixture />
        </LocalBackProvider>
      </BrowserRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
