import { Link } from 'react-router-dom'
import { useAgentAvailability } from '../../../facades/agents/hooks'
import { PresenceBadge } from '../../primitives/PresenceBadge'

type AgentAvailabilityProps = {
  agentId: string
  canRepair: boolean
  localBindingId?: string | null
  provider?: string | null
}

const availabilityText = (availability: 'online' | 'offline' | 'unknown'): string =>
  availability === 'online'
    ? 'Local model online'
    : availability === 'unknown'
      ? 'Local model availability unknown'
      : 'Local model offline'

/**
 * A local agent's availability is not a person's PresenceProvider state.  It
 * is read from the server only for a local-pinned agent, so ordinary agents do
 * not acquire a misleading offline dot or an extra request.
 */
export const AgentAvailability = ({
  agentId,
  canRepair,
  localBindingId,
  provider,
}: AgentAvailabilityProps) => {
  const isLocal = provider === 'local/ollama' || Boolean(localBindingId)
  const availability = useAgentAvailability(agentId, isLocal)
  if (!isLocal) return null

  const value = availability.data
  const state = value?.availability ?? 'unknown'
  const label = availabilityText(state)
  const repair = state !== 'online' && canRepair

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[color:var(--tx3)]">
      <PresenceBadge ringColor="var(--main)" size={8} state={state} />
      <span aria-live="polite">{label}</span>
      {repair ? (
        <Link
          className="text-[color:var(--lnk)] hover:underline"
          to={`/admin/agents/designer/${agentId}?designerSection=model`}
        >
          Repair
        </Link>
      ) : null}
    </span>
  )
}
