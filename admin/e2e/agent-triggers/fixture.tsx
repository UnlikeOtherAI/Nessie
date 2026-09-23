import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { TriggerEditorDialog } from '../../src/components/features/triggers/TriggerEditorDialog'
import type { AgentRecord, AgentTriggerRecord, ChannelRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

/**
 * The Triggers page's create dialog over a stubbed API
 * (docs/plans/2026-09-23-ticket-driven-agents/verification.md, T0).
 *
 * The real `TriggerEditorDialog` and its `TriggerTypePicker` render, opened
 * the way the Triggers page opens them; only the transport is fake. Nothing is
 * read on open, so the client answers nothing but the create, and records what
 * was posted on `window.__agentTriggersFixture` for the runner to read.
 *
 * One agent, bound to one project channel, is the target: the case the
 * `ticket_changed` editor will start from once T1 releases that type.
 */

const AGENT_ID = '60000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '60000000-0000-4000-8000-000000000002'

try {
  window.localStorage.clear()
  window.sessionStorage.clear()
} catch {
  // A draft left by a previous run would change what the dialog shows.
}

const agents = [{
  channelIds: [CHANNEL_ID],
  id: AGENT_ID,
  kind: 'shared',
  name: 'CTO',
  role: 'Engineering lead',
  status: 'idle',
  systemManaged: false,
  visibility: 'team',
}] as unknown as AgentRecord[]

const channels = [{
  id: CHANNEL_ID,
  label: '#engineering',
  name: 'engineering',
}] as unknown as ChannelRecord[]

type Posted = { body: unknown; path: string }
const fixture = { posted: [] as Posted[] }
;(window as unknown as { __agentTriggersFixture: typeof fixture }).__agentTriggersFixture = fixture

const client = {
  delete: async () => ({ ok: true }),
  get: async () => null,
  patch: async () => ({ ok: true }),
  post: async (path: string, body: { type: AgentTriggerRecord['type'] } & Record<string, unknown>) => {
    fixture.posted.push({ body, path })
    return {
      ...body,
      agentId: AGENT_ID,
      config: body.config ?? {},
      createdAt: new Date().toISOString(),
      enabled: body.enabled ?? true,
      id: '60000000-0000-4000-8000-000000000003',
      status: 'active',
      updatedAt: new Date().toISOString(),
    } as AgentTriggerRecord
  },
  put: async () => ({ ok: true }),
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Scenario = () => {
  const [open, setOpen] = useState(true)
  return (
    <TriggerEditorDialog
      agents={agents}
      channels={channels}
      onClose={() => setOpen(false)}
      onSaved={() => {}}
      open={open}
      workflowInstallations={[]}
      workflowTemplates={[]}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/triggers']}>
        {/* The shell's one Back registry, which the dialog registers with. */}
        <LocalBackProvider>
          <div data-ready="true" style={{ background: 'var(--main)', minHeight: '100vh' }}>
            <Scenario />
          </div>
        </LocalBackProvider>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
