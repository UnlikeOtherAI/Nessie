import { useOutletContext } from 'react-router-dom'
import { AgentActivityPanel } from '../components/features/agents/AgentActivityPanel'
import { useAgentRealtime, useAgents } from '../facades/agents/hooks'
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'

export const AgentActivityPage = () => {
  const { onSelectAgent } = useOutletContext<AdminShellOutletContext>()
  const { data: agents = [] } = useAgents()
  const realtime = useAgentRealtime({})

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <header className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
            Agents
          </p>
          <h1 className="text-2xl font-semibold text-[color:var(--tx)]">Activity</h1>
          <p className="max-w-2xl text-sm text-[color:var(--tx3)]">
            Live workspace activity for every agent. Select an agent to inspect the current run,
            recent tool usage, messages, and spawned children.
          </p>
        </header>

        <div className="admin-card p-4">
          <AgentActivityPanel
            agents={agents}
            collapsible={false}
            onSelectAgent={onSelectAgent}
            realtime={realtime}
            title="Live agent activity"
          />
        </div>
      </div>
    </div>
  )
}
