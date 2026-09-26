import { useAgentRunFailures } from '../../../facades/agents/queries'
import { formatTimestamp } from '../triggers/trigger-presentation'

type AgentRunFailuresPanelProps = {
  agentId: string
}

/**
 * The unattended runs of this agent that failed recently, newest first, as
 * rows under the Activity tab's own heading — a list, not a card of cards.
 */
export const AgentRunFailuresPanel = ({ agentId }: AgentRunFailuresPanelProps) => {
  const { data, isError, isPending } = useAgentRunFailures(agentId)
  const failures = data?.failures ?? []

  if (isPending) {
    return <p className="text-sm text-[color:var(--tx3)]">Loading recent failures…</p>
  }
  if (isError) {
    return <p className="text-sm text-[color:var(--tx3)]">Recent failures could not be loaded.</p>
  }
  if (failures.length === 0) {
    return <p className="text-sm text-[color:var(--tx3)]">No run it started on its own has failed recently.</p>
  }
  return (
    <ul className="grid divide-y divide-[color:var(--sep)]" data-testid="agent-run-failures">
      {failures.map((failure) => (
        <li className="grid gap-1 py-2" key={failure.runId}>
          <span className="text-xs text-[color:var(--tx3)]">{formatTimestamp(failure.failedAt)}</span>
          <span className="text-sm text-[color:var(--tx)]">{failure.message}</span>
        </li>
      ))}
    </ul>
  )
}
