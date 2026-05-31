import { useState } from 'react'
import type { AgentRecord, UserRecord } from '../../lib/api-client'
import {
  useAddChannelMember,
  useRemoveChannelMember,
} from '../../facades/channels/hooks'
import {
  useBindAgent,
  useCloneAgent,
  useUnbindAgent,
} from '../../facades/agents/hooks'
import { CloseIcon, SearchIcon } from './channel-members/icons'
import { useMemberFilters } from './channel-members/use-member-filters'
import {
  AvailableUserRow,
  CurrentUserRow,
} from './channel-members/MemberUserRow'
import {
  AvailableAgentRow,
  CurrentAgentRow,
} from './channel-members/MemberAgentRow'
import { sectionHeadingClass } from './channel-members/styles'

type ChannelMembersPopupProps = {
  allAgents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelId: string
  channelLabel: string
  channelType: 'dm' | 'standard'
  channelUsers: UserRecord[]
  currentUserId: string
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

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      onClick={handleOverlayClick}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className={[
          'flex max-h-[80vh] w-full max-w-[480px] flex-col rounded-xl',
          'border border-[color:var(--sep)] bg-[color:var(--main)]',
        ].join(' ')}
        style={{ boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-white">
              #{channelLabel} members
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {totalMembers} member{totalMembers !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx3)] hover:bg-white/10 hover:text-white',
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
              'border-[color:var(--border-strong)] bg-white/5 px-3 py-2',
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
          {(filteredUsers.length > 0 || filteredAgents.length > 0) && (
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

          {filteredUsers.length === 0 &&
            filteredAgents.length === 0 &&
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
