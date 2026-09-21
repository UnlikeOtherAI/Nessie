import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { ChannelDecisionPolicySchema, ChannelRecordSchema } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ChannelSettingsDialog } from '../../src/components/shared/ChannelSettingsDialog'
import type { AgentRecord, ChannelRecord } from '../../src/lib/api-client'
import '../../src/styles.css'

const uuid = (digit: number) => `${digit.toString().repeat(8)}-1111-4111-8111-111111111111`
const AGENT_ID = uuid(7)
let stored = ChannelRecordSchema.parse({
  id: uuid(1), label: 'product-decisions', topic: 'Weekly product decisions', description: 'Keep useful context.',
  type: 'standard', visibility: 'public', organizationId: uuid(2), projectId: uuid(3),
  projectName: 'Product', teamId: uuid(4), teamName: 'Design', defaultThreadId: uuid(5),
  viewerCanManage: true, viewerCanManageAgents: true, viewerIsMember: true,
  decisionPolicy: null, createdAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z',
})
let emitChannel: (channel: ChannelRecord) => void = () => {}
let failNextSave = false
const writes: unknown[] = []

const client = {
  patch: async (_path: string, body: Record<string, unknown>) => {
    if (failNextSave) {
      failNextSave = false
      throw new Error('Unable to save channel. Try again.')
    }
    if (body.decisionPolicy) ChannelDecisionPolicySchema.parse(body.decisionPolicy)
    writes.push(body)
    stored = ChannelRecordSchema.parse({ ...stored, ...body })
    emitChannel(stored)
    return stored
  },
} as unknown as ApiClient

const agents = [{
  id: AGENT_ID, name: 'Decision keeper', visibility: 'team', channelIds: [stored.id],
}] as AgentRecord[]
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  const [channel, setChannel] = useState(stored)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    emitChannel = setChannel
    Object.assign(window, {
      __channelDecisionsFixture: {
        agentId: AGENT_ID,
        writes,
        saved: () => stored,
        refresh: (update: Partial<ChannelRecord>) => {
          stored = ChannelRecordSchema.parse({ ...stored, ...update })
          setChannel(stored)
        },
        failNextSave: () => { failNextSave = true },
      },
    })
  }, [])
  return (
    <main className="min-h-screen bg-[var(--bg)] p-4 text-[color:var(--tx)]">
      <h1 className="mb-4 text-lg font-semibold">#{channel.label}</h1>
      <button className="admin-button admin-button-secondary" onClick={() => setOpen(true)} type="button">
        Channel settings
      </button>
      <ChannelSettingsDialog boundAgents={agents} channel={channel} onClose={() => setOpen(false)} open={open} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}>
      <MemoryRouter><Fixture /></MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
