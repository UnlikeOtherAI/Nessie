import { useAgentRunFailures } from '../../../facades/agents/queries'
import { SectionLabel } from '../../primitives/SectionLabel'
import { EmptyState } from '../../shared/EmptyState'
import { formatTimestamp } from '../triggers/trigger-presentation'

type AgentRunFailuresPanelProps = {
  agentId: string
}

export const AgentRunFailuresPanel = ({ agentId }: AgentRunFailuresPanelProps) => {
  const { data, isError, isPending } = useAgentRunFailures(agentId)
  const failures = data?.failures ?? []

  if (isPending) {
    return (
      <section className="admin-card p-4">
        <SectionLabel>Recent run failures</SectionLabel>
        <div className="mt-3 text-sm text-[color:var(--tx3)]">Loading recent failures…</div>
      </section>
    )
  }

  if (isError) {
    return (
      <section className="admin-card p-4">
        <SectionLabel>Recent run failures</SectionLabel>
        <div className="mt-3 text-sm text-[color:var(--tx3)]">Could not load recent failures.</div>
      </section>
    )
  }

  if (failures.length === 0) {
    return (
      <section className="admin-card p-4">
        <SectionLabel>Recent run failures</SectionLabel>
        <div className="mt-3">
          <EmptyState>No unattended runs have failed recently.</EmptyState>
        </div>
      </section>
    )
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>Recent run failures</SectionLabel>
      <div className="mt-3 grid gap-3">
        {failures.map((failure) => (
          <div
            key={failure.runId}
            className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-[color:var(--tx2)]">
                Run {failure.runId.slice(0, 8)}
              </span>
              <span className="text-xs text-[color:var(--tx3)]">
                {formatTimestamp(failure.failedAt)}
              </span>
            </div>
            <div className="mt-1 text-sm text-[color:var(--tx)]">{failure.message}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
