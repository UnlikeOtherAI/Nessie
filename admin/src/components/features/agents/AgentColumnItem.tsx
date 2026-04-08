import type { AgentChild } from '@nessie/schemas'
import type { AgentRecord } from '../../../lib/api-client'
import { AgentStatusDot } from './AgentStatusDot'

type AgentColumnItemProps = {
  agent: AgentRecord | AgentChild
  hasChildren?: boolean
  isSelected: boolean
  onClick: () => void
}

const getName = (agent: AgentRecord | AgentChild): string => agent.name

const getRole = (agent: AgentRecord | AgentChild): string =>
  'role' in agent && typeof (agent as AgentRecord).role === 'string'
    ? (agent as AgentRecord).role
    : 'purpose' in agent
      ? (agent as AgentChild).purpose ?? ''
      : ''

export const AgentColumnItem = ({
  agent,
  hasChildren,
  isSelected,
  onClick,
}: AgentColumnItemProps) => (
  <button
    className={[
      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
      isSelected
        ? 'bg-[color:var(--accent)] text-white'
        : 'text-[color:var(--tx)] hover:bg-white/8',
    ].join(' ')}
    onClick={onClick}
    type="button"
  >
    <AgentStatusDot status={agent.status} />
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">{getName(agent)}</div>
      <div className="truncate text-xs text-[color:var(--tx3)]">{getRole(agent)}</div>
    </div>
    {hasChildren ? (
      <svg
        className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : null}
  </button>
)
