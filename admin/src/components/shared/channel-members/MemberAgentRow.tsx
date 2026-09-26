import type { AgentRecord, PersonalAssistantPresenceParticipant } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { getAgentScope } from '../agent-scope'
import { AgentVisibilityPill } from '../AgentVisibilityPill'
import { Pill } from '../../primitives/Pill'
import { AgentAvatar } from '../AgentAvatar'
import { CloneIcon, CloseIcon, ViewIcon } from './icons'
import { actionBtnClass, rowClass } from './styles'

const agentActionBtnClass = [
  actionBtnClass,
  'text-[color:var(--tx3)] hover:bg-[color:var(--accent-soft)]',
  'hover:text-[color:var(--thinking)]',
].join(' ')

/**
 * Who may place or remove an agent, said on the control that needs it. The
 * binding routes take organisation owner or admin standing, which is narrower
 * than being in the channel, so a control somebody could use with that
 * standing stays on screen, disabled, rather than disappearing (plan R9).
 */
const PLACEMENT_REASON = 'Only an organisation owner or admin can add or remove agents here'

/**
 * A global agent is app-provided, so it can be placed here but never copied:
 * `cloneAgent` refuses a `systemManaged` source, and a button whose only
 * outcome is a 404 is worse than no button. The scope comes from the shared
 * `getAgentScope` rather than a second reading of `systemManaged`.
 */
const isGlobalAgent = (agent: AgentRecord): boolean => getAgentScope(agent) === 'global'

const GlobalAgentPill = () => (
  <Pill radius="chip" size="sm" tone="outline">
    global
  </Pill>
)

type CurrentAgentRowProps = {
  agent: AgentRecord
  /**
   * `ChannelRecord.viewerCanManageAgents` — organisation owner or admin
   * standing, which `DELETE /api/agents/:agentId/bindings/:channelId` requires.
   * Only the removal is gated, and without the standing it is shown disabled:
   * everyone in the channel may see which agents are in it, and copying one is
   * its own, wider permission.
   */
  canUnbind: boolean
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
  canUnbind,
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
      {isGlobalAgent(agent) ? <GlobalAgentPill /> : null}
      {isGlobalAgent(agent) ? null : <AgentVisibilityPill visibility={agent.visibility} />}
      <Pill className="border border-[color:var(--accent)]/30" radius="chip" size="sm" tone="accent">
        agent
      </Pill>
      <div className="flex items-center gap-1">
        {isGlobalAgent(agent) ? null : (
          <button
            className={agentActionBtnClass}
            disabled={clonePending}
            onClick={() => onClone(agent.id)}
            title="Create a copy you own"
            type="button"
          >
            <CloneIcon />
          </button>
        )}
        <button
          className={agentActionBtnClass}
          onClick={() => onView(agent.id)}
          title="View agent details"
          type="button"
        >
          <ViewIcon />
        </button>
        <button
          aria-label={`Remove ${agent.name} from channel`}
          className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger-text)] disabled:opacity-40`}
          data-testid="channel-agent-remove"
          disabled={!canUnbind || unbindPending}
          onClick={() => onUnbind(agent.id, channelId)}
          title={canUnbind ? 'Remove from channel' : PLACEMENT_REASON}
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
  /**
   * `ChannelRecord.viewerCanManageAgents` — organisation owner or admin
   * standing, which `POST /api/agents/:agentId/bindings` requires. Without it
   * the row stays, because the agent is worth seeing and copying it is a wider
   * permission, and "Add" is shown disabled with who can use it rather than
   * pressed into a 403.
   */
  canBind: boolean
  channelId: string
  clonePending: boolean
  bindPending: boolean
  onClone: (agentId: string) => void
  onBind: (agentId: string, channelId: string) => void
}

/** An agent that can be bound to the channel. */
export const AvailableAgentRow = ({
  agent,
  canBind,
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
      {isGlobalAgent(agent) ? <GlobalAgentPill /> : null}
      {isGlobalAgent(agent) ? null : <AgentVisibilityPill visibility={agent.visibility} />}
      <div className="flex items-center gap-1">
        {isGlobalAgent(agent) ? null : (
          <button
            className={agentActionBtnClass}
            disabled={clonePending}
            onClick={() => onClone(agent.id)}
            title="Create a copy you own"
            type="button"
          >
            <CloneIcon />
          </button>
        )}
        <button
          aria-label={`Add ${agent.name} to channel`}
          className={[
            actionBtnClass,
            'border border-[color:var(--accent)]/30 text-[color:var(--thinking)]',
            'hover:bg-[color:var(--accent-soft)] disabled:opacity-40',
          ].join(' ')}
          data-testid="channel-agent-add"
          disabled={!canBind || bindPending}
          onClick={() => onBind(agent.id, channelId)}
          title={canBind ? undefined : PLACEMENT_REASON}
          type="button"
        >
          Add
        </button>
      </div>
    </div>
  )
}
