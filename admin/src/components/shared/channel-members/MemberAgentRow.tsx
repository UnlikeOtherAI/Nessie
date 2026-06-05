import type { AgentRecord } from '../../../lib/api-client'
import { agentGradient } from '../../../lib/avatar'
import { CloneIcon, CloseIcon, ViewIcon } from './icons'
import { actionBtnClass, rowClass } from './styles'

const getAgentGlyph = (role: string): string => {
  const lower = role.toLowerCase()
  if (lower.includes('research')) return '\u{1F50D}'
  if (lower.includes('write')) return '\u{1F4DD}'
  return '⚡'
}

const agentActionBtnClass = [
  actionBtnClass,
  'text-[color:var(--tx3)] hover:bg-[rgba(124,58,237,0.15)]',
  'hover:text-[#a78bfa]',
].join(' ')

type CurrentAgentRowProps = {
  agent: AgentRecord
  channelId: string
  clonePending: boolean
  unbindPending: boolean
  onClone: (agentId: string) => void
  onView: (agentId: string) => void
  onUnbind: (agentId: string, channelId: string) => void
}

/** An agent bound to the channel. */
export const CurrentAgentRow = ({
  agent,
  channelId,
  clonePending,
  unbindPending,
  onClone,
  onView,
  onUnbind,
}: CurrentAgentRowProps) => (
  <div className={rowClass}>
    <div
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm"
      style={{ background: agentGradient }}
    >
      {getAgentGlyph(agent.role)}
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-white">
        {agent.name}
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {agent.role}
      </div>
    </div>
    <span
      className={[
        'rounded border border-[rgba(124,58,237,0.3)]',
        'bg-[rgba(124,58,237,0.15)] px-1.5 py-0.5',
        'text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a78bfa]',
      ].join(' ')}
    >
      agent
    </span>
    <div className="flex items-center gap-1">
      <button
        className={agentActionBtnClass}
        disabled={clonePending}
        onClick={() => onClone(agent.id)}
        title="Clone to personal collection"
        type="button"
      >
        <CloneIcon />
      </button>
      <button
        className={agentActionBtnClass}
        onClick={() => onView(agent.id)}
        title="View agent details"
        type="button"
      >
        <ViewIcon />
      </button>
      <button
        className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-red-500/10 hover:text-red-400`}
        disabled={unbindPending}
        onClick={() => onUnbind(agent.id, channelId)}
        title="Remove from channel"
        type="button"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
)

type AvailableAgentRowProps = {
  agent: AgentRecord
  channelId: string
  clonePending: boolean
  bindPending: boolean
  onClone: (agentId: string) => void
  onBind: (agentId: string, channelId: string) => void
}

/** An agent that can be bound to the channel. */
export const AvailableAgentRow = ({
  agent,
  channelId,
  clonePending,
  bindPending,
  onClone,
  onBind,
}: AvailableAgentRowProps) => (
  <div className={rowClass}>
    <div
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm opacity-60"
      style={{ background: agentGradient }}
    >
      {getAgentGlyph(agent.role)}
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm text-[color:var(--tx2)]">
        {agent.name}
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {agent.role}
      </div>
    </div>
    <div className="flex items-center gap-1">
      <button
        className={agentActionBtnClass}
        disabled={clonePending}
        onClick={() => onClone(agent.id)}
        title="Clone to personal collection"
        type="button"
      >
        <CloneIcon />
      </button>
      <button
        className={[
          actionBtnClass,
          'border border-[rgba(124,58,237,0.3)] text-[#a78bfa]',
          'hover:bg-[rgba(124,58,237,0.15)]',
        ].join(' ')}
        disabled={bindPending}
        onClick={() => onBind(agent.id, channelId)}
        type="button"
      >
        Add
      </button>
    </div>
  </div>
)
