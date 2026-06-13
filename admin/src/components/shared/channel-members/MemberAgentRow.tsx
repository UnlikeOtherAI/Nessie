import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../AgentAvatar'
import { CloneIcon, CloseIcon, ViewIcon } from './icons'
import { actionBtnClass, rowClass } from './styles'

const agentActionBtnClass = [
  actionBtnClass,
  'text-[color:var(--tx3)] hover:bg-[color:var(--accent-soft)]',
  'hover:text-[color:var(--thinking)]',
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
}: CurrentAgentRowProps) => {
  const { token } = useAuthSession()
  return (
    <div className={rowClass}>
      <AgentAvatar agent={agent} shape="circle" size="sm" token={token} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[color:var(--tx)]">
          {agent.name}
        </div>
        <div className="truncate text-xs text-[color:var(--tx3)]">
          {agent.role}
        </div>
      </div>
      <span
        className={[
          'rounded border border-[color:var(--accent)]/30',
          'bg-[color:var(--accent-soft)] px-1.5 py-0.5',
          'text-[10px] font-semibold uppercase tracking-[0.12em]',
          'text-[color:var(--thinking)]',
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
          className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger-text)]`}
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
}

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
}: AvailableAgentRowProps) => {
  const { token } = useAuthSession()
  return (
    <div className={rowClass}>
      <AgentAvatar agent={agent} muted shape="circle" size="sm" token={token} />
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
            'border border-[color:var(--accent)]/30 text-[color:var(--thinking)]',
            'hover:bg-[color:var(--accent-soft)]',
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
}
