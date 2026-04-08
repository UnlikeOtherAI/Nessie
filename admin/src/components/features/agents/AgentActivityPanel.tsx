import type { AgentRecord } from '../../../lib/api-client'
import { AgentRow } from '../../shared/AgentRow'
import { EmptyState } from '../../shared/EmptyState'
import { StatusPill } from '../../primitives/StatusPill'
import { AgentStatusDot } from './AgentStatusDot'

export type AgentRealtimeState = {
  connectionState: 'connected' | 'connecting' | 'disconnected'
  records: Record<
    string,
    {
      currentRunId?: string
      currentToolName?: string
      currentToolStartedAt?: string
      since?: string
      status: AgentRecord['status']
    }
  >
}

type AgentActivityPanelProps = {
  agents: AgentRecord[]
  onSelectAgent: (agentId: string) => void
  realtime: AgentRealtimeState
  selectedAgentId?: string | null
}

const connectionTone = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'danger',
} as const

const activeStatuses = new Set<AgentRecord['status']>([
  'executing',
  'thinking',
  'waiting_approval',
  'error',
])

export const AgentActivityPanel = ({
  agents,
  onSelectAgent,
  realtime,
  selectedAgentId,
}: AgentActivityPanelProps) => {
  const sortedAgents = [...agents].sort((left, right) => {
    const leftRecord = realtime.records[left.id]
    const rightRecord = realtime.records[right.id]
    const leftStatus = leftRecord?.status ?? left.status
    const rightStatus = rightRecord?.status ?? right.status
    const leftActive = activeStatuses.has(leftStatus) ? 1 : 0
    const rightActive = activeStatuses.has(rightStatus) ? 1 : 0
    if (leftActive !== rightActive) {
      return rightActive - leftActive
    }

    const leftTs = Date.parse(leftRecord?.currentToolStartedAt ?? leftRecord?.since ?? left.lastActivityAt)
    const rightTs = Date.parse(
      rightRecord?.currentToolStartedAt ?? rightRecord?.since ?? right.lastActivityAt,
    )
    return rightTs - leftTs
  })

  return (
    <section className="glass-panel flex h-full flex-col rounded-[2rem] p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--muted)]">
            Agent activity
          </div>
          <h2 className="mt-2 text-xl font-semibold">Live status</h2>
        </div>
        <StatusPill tone={connectionTone[realtime.connectionState]}>
          {realtime.connectionState}
        </StatusPill>
      </div>

      <div className="mt-4 flex-1 overflow-y-auto">
        <div className="grid gap-3">
          {sortedAgents.length === 0 ? (
            <EmptyState>No agents exist yet. Create one to populate the activity rail.</EmptyState>
          ) : (
            sortedAgents.map((agent) => {
              const record = realtime.records[agent.id]
              const status = record?.status ?? agent.status
              const currentTask =
                record?.currentToolName ??
                agent.currentToolName ??
                (status === 'thinking' ? 'Thinking through the current run.' : undefined)
              const lastActivity = record?.currentToolStartedAt ?? record?.since ?? agent.lastActivityAt

              return (
                <div
                  key={agent.id}
                  className={`rounded-[1.6rem] border ${
                    selectedAgentId === agent.id
                      ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]/60'
                      : 'border-transparent'
                  }`}
                >
                  <AgentRow
                    currentTask={currentTask}
                    footer={
                      `Last activity ${new Date(lastActivity).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    }
                    onClick={() => onSelectAgent(agent.id)}
                    statusDot={<AgentStatusDot status={status} />}
                    subtitle={agent.role}
                    title={agent.name}
                  />
                </div>
              )
            })
          )}
        </div>
      </div>
    </section>
  )
}
