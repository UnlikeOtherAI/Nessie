import { useMemo, useState } from 'react'
import type {
  AgentRecord,
  PersonalAssistantPresenceParticipant,
  UserRecord,
} from '../../lib/api-client'
import {
  useAddChannelMember,
  useRemoveChannelMember,
} from '../../facades/channels/hooks'
import {
  useBindAgent,
  useCloneAgent,
  useUnbindAgent,
} from '../../facades/agents/hooks'
import {
  useAddPersonalAssistantPresence,
  useRemovePersonalAssistantPresence,
} from '../../facades/personal-assistant/hooks'
import { CloseIcon, SearchIcon } from './channel-members/icons'
import { useMemberFilters } from './channel-members/use-member-filters'
import {
  AvailableUserRow,
  CurrentUserRow,
} from './channel-members/MemberUserRow'
import {
  AvailableAgentRow,
  CurrentAgentRow,
  CurrentPersonalAssistantRow,
} from './channel-members/MemberAgentRow'
import { actionBtnClass, sectionHeadingClass } from './channel-members/styles'
import { useOverlayDismiss } from './useOverlayDismiss'

type ChannelMembersPopupProps = {
  allAgents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelId: string
  channelLabel: string
  channelType: 'dm' | 'standard'
  channelUsers: UserRecord[]
  currentUserId: string
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  onClose: () => void
  onGroupCreated: (channelId: string) => void
  onSelectAgent: (agentId: string) => void
}

export const ChannelMembersPopup = ({
  allAgents,
  allUsers,
  boundAgents,
  channelId,
  channelLabel,
  channelType,
  channelUsers,
  currentUserId,
  personalAssistantPresences,
  onClose,
  onGroupCreated,
  onSelectAgent,
}: ChannelMembersPopupProps) => {
  const [search, setSearch] = useState('')

  const addMember = useAddChannelMember()
  const removeMember = useRemoveChannelMember()
  const bindAgent = useBindAgent()
  const unbindAgent = useUnbindAgent()
  const cloneAgent = useCloneAgent()
  const addPersonalAssistant = useAddPersonalAssistantPresence()
  const removePersonalAssistant = useRemovePersonalAssistantPresence()
  const hasMyPersonalAssistant = personalAssistantPresences.some(
    (presence) => presence.principalUserId === currentUserId,
  )
  const filteredPersonalAssistantPresences = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query
      ? personalAssistantPresences.filter((presence) =>
          presence.displayName.toLocaleLowerCase().includes(query))
      : personalAssistantPresences
  }, [personalAssistantPresences, search])

  const {
    filteredUsers,
    filteredAgents,
    availableUsers,
    availableAgents,
    totalMembers,
    hasAvailable,
  } = useMemberFilters({
    allAgents,
    allUsers,
    boundAgents,
    channelUsers,
    search,
  })

  const handleAddUser = (userId: string) =>
    addMember.mutate(
      { channelId, userId },
      {
        onSuccess: (data) => {
          if (channelType === 'dm' && data?.id) {
            onGroupCreated(data.id)
          }
        },
      },
    )

  const overlayDismiss = useOverlayDismiss(onClose)

  return (
    <div
      {...overlayDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--scrim-strong)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className={[
          'flex max-h-[80vh] w-[calc(100%-1.5rem)] max-w-[480px] flex-col rounded-xl',
          'border border-[color:var(--sep)] bg-[color:var(--main)]',
        ].join(' ')}
        style={{ boxShadow: '0 24px 48px var(--scrim-strong)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-[color:var(--tx)]">
              #{channelLabel} members
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {totalMembers + personalAssistantPresences.length} member
              {totalMembers + personalAssistantPresences.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx3)] hover:bg-[color:var(--overlay)]',
              'hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-[color:var(--sep)] px-5 py-3">
          <div
            className={[
              'flex items-center gap-2 rounded-lg border',
              'border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)] px-3 py-2',
            ].join(' ')}
          >
            <SearchIcon />
            <input
              autoFocus
              className={[
                'w-full bg-transparent text-sm text-[color:var(--tx)] outline-none',
                'placeholder:text-[color:var(--tx3)]',
              ].join(' ')}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members or agents..."
              value={search}
            />
          </div>
        </div>

        {/* Scrollable list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {/* Current members */}
          {(filteredUsers.length > 0
            || filteredAgents.length > 0
            || filteredPersonalAssistantPresences.length > 0) && (
            <div>
              <div className={sectionHeadingClass}>In this channel</div>

              {filteredUsers.map((user) => (
                <CurrentUserRow
                  key={user.id}
                  user={user}
                  currentUserId={currentUserId}
                  removePending={removeMember.isPending}
                  onRemove={(userId) =>
                    removeMember.mutate({ channelId, userId })
                  }
                />
              ))}

              {filteredAgents.map((agent) => (
                <CurrentAgentRow
                  key={agent.id}
                  agent={agent}
                  channelId={channelId}
                  clonePending={cloneAgent.isPending}
                  unbindPending={unbindAgent.isPending}
                  onClone={(agentId) => cloneAgent.mutate(agentId)}
                  onView={(agentId) => {
                    onSelectAgent(agentId)
                    onClose()
                  }}
                  onUnbind={(agentId, chId) =>
                    unbindAgent.mutate({ agentId, channelId: chId })
                  }
                />
              ))}

              {filteredPersonalAssistantPresences.map((presence) => (
                <CurrentPersonalAssistantRow
                  currentUserId={currentUserId}
                  key={presence.id}
                  presence={presence}
                  removePending={removePersonalAssistant.isPending}
                  onRemove={() => removePersonalAssistant.mutate(channelId)}
                />
              ))}
            </div>
          )}

          {/* Available to add */}
          {hasAvailable && (
            <div className="mt-2">
              <div className={sectionHeadingClass}>Add to channel</div>

              {availableUsers.map((user) => (
                <AvailableUserRow
                  key={user.id}
                  user={user}
                  addPending={addMember.isPending}
                  onAdd={handleAddUser}
                />
              ))}

              {availableAgents.map((agent) => (
                <AvailableAgentRow
                  key={agent.id}
                  agent={agent}
                  channelId={channelId}
                  clonePending={cloneAgent.isPending}
                  bindPending={bindAgent.isPending}
                  onClone={(agentId) => cloneAgent.mutate(agentId)}
                  onBind={(agentId, chId) =>
                    bindAgent.mutate({ agentId, channelId: chId })
                  }
                />
              ))}
            </div>
          )}

          {!hasMyPersonalAssistant ? (
            <div className="mt-2">
              <div className={sectionHeadingClass}>Personal Assistant</div>
              <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[color:var(--tx)]">Add my assistant</div>
                  <div className="text-xs text-[color:var(--tx3)]">Let people in this channel hand it a task.</div>
                </div>
                <button
                  className={[
                    actionBtnClass,
                    'border border-[color:var(--accent)]/30 text-[color:var(--thinking)]',
                    'hover:bg-[color:var(--accent-soft)]',
                  ].join(' ')}
                  disabled={addPersonalAssistant.isPending}
                  onClick={() => addPersonalAssistant.mutate(channelId)}
                  type="button"
                >
                  {addPersonalAssistant.isPending ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>
          ) : null}

          {filteredUsers.length === 0 &&
            filteredAgents.length === 0 &&
            filteredPersonalAssistantPresences.length === 0 &&
            !hasAvailable && (
              <div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
                No members match your search.
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
