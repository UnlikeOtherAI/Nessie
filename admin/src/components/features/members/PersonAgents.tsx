import { Link } from 'react-router-dom'
import type { AgentRecord } from '../../../lib/api-client'
import { AgentAvatar } from '../../shared/AgentAvatar'

/**
 * The agents one person stewards, rendered under their roster row — the
 * "virtual employees" half of the people-and-their-agents tree.
 *
 * The list is whatever `GET /api/agents` already returned for the viewer, so
 * entitlement is inherited rather than restated here. There is deliberately no
 * "and N more you cannot see" counter: a hidden count leaks the shape of
 * private channels.
 */
export const PersonAgents = ({
  agents,
  token,
}: {
  agents: AgentRecord[]
  token: string | null
}) => {
  if (agents.length === 0) {
    return (
      <div className="mt-2 pl-[52px] text-xs text-[color:var(--tx3)]">
        No agents
      </div>
    )
  }

  return (
    <ul className="mt-2 grid gap-1 pl-[52px]">
      {agents.map((agent) => (
        <li key={agent.id}>
          <Link
            className="flex min-w-0 items-center gap-2 rounded px-1 py-1 hover:bg-[color:var(--main-hover)]"
            to={`/agents/${agent.id}`}
          >
            <AgentAvatar agent={agent} size="xs" token={token} />
            <span className="min-w-0 truncate text-xs text-[color:var(--tx2)]">
              {agent.name}
            </span>
            <span className="min-w-0 truncate text-[11px] text-[color:var(--tx3)]">
              {agent.role}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Agents that belong to no one in this team. Split into two labelled
 * groups on purpose: "team-owned" is a real state — nobody stewards the agent,
 * so anyone entitled to it may edit it — while "owned outside this team"
 * covers an owner the *team* roster does not list, which an active colleague in
 * another team and a departed person both produce. Merging them would either
 * hide who may edit what or call present colleagues gone.
 */
export const UnassignedAgents = ({
  agents,
  emptyLabel,
  title,
  token,
}: {
  agents: AgentRecord[]
  emptyLabel: string
  title: string
  // Passed rather than read from context so this renders in isolation.
  token: string | null
}) => (
  <div>
    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]">
      {title}
      {agents.length > 0 ? ` (${agents.length})` : ''}
    </div>
    {agents.length === 0 ? (
      <div className="mt-2 text-xs text-[color:var(--tx3)]">{emptyLabel}</div>
    ) : (
      <ul className="mt-2 grid gap-1">
        {agents.map((agent) => (
          <li key={agent.id}>
            <Link
              className="flex min-w-0 items-center gap-2 rounded px-1 py-1 hover:bg-[color:var(--main-hover)]"
              to={`/agents/${agent.id}`}
            >
              <AgentAvatar agent={agent} size="xs" token={token} />
              <span className="min-w-0 truncate text-xs text-[color:var(--tx2)]">
                {agent.name}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    )}
  </div>
)

/** Aggregate-only operational signal: a paused private agent remains unnamed. */
export const PausedPrivateAgentsBucket = ({ count }: { count: number }) => {
  if (count === 0) return null

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]">
        Paused private agents ({count})
      </div>
      <p className="mt-2 text-xs text-[color:var(--tx3)]">
        Paused because their owners are deactivated. Names and configuration stay private.
      </p>
    </div>
  )
}
