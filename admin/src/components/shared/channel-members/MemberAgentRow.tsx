import type { AgentRecord, PersonalAssistantPresenceParticipant } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Pill } from '../../primitives/Pill'
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
      <AgentAvatar agent={agent} size="sm" token={token} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[color:var(--tx)]">
          {agent.name}
        </div>
        <div className="truncate text-xs text-[color:var(--tx3)]">
          {agent.role}
        </div>
      </div>
      <Pill className="border border-[color:var(--accent)]/30" radius="chip" size="sm" tone="accent">
        agent
      </Pill>
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

type CurrentPersonalAssistantRowProps = {
  currentUserId: string
  presence: PersonalAssistantPresenceParticipant
  removePending: boolean
  onRemove: () => void
}

/**
 * The channel-safe projection of a PA presence. It deliberately takes no
 * AgentRecord and offers no details action: channel peers may see a colleague's
 * PA as a participant, never its singleton configuration.
 */
export const CurrentPersonalAssistantRow = ({
  currentUserId,
  presence,
  removePending,
  onRemove,
}: CurrentPersonalAssistantRowProps) => {
  const { token } = useAuthSession()
  const isMine = presence.principalUserId === currentUserId
  return (
    <div className={rowClass} data-testid={`personal-assistant-presence-${presence.id}`}>
      <AgentAvatar
        agent={{
          avatarAttachmentId: presence.avatarAttachmentId,
          id: presence.agentId,
          name: presence.displayName,
          role: 'Personal Assistant',
        }}
        size="sm"
        token={token}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[color:var(--tx)]">
          {presence.displayName}
        </div>
        <div className="truncate text-xs text-[color:var(--tx3)]">
          Personal Assistant
        </div>
      </div>
      <Pill className="border border-[color:var(--accent)]/30" radius="chip" size="sm" tone="accent">
        PA
      </Pill>
      {isMine ? (
        <button
          className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger-text)]`}
          disabled={removePending}
          onClick={onRemove}
          type="button"
        >
          Remove
        </button>
      ) : null}
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
      <AgentAvatar agent={agent} muted size="sm" token={token} />
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
