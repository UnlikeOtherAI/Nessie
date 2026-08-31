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
import { MemberManagementPopup } from './MemberManagementPopup'

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

  return (
    <MemberManagementPopup
      entityLabel={`#${channelLabel}`}
      onClose={onClose}
      onSearchChange={setSearch}
      search={search}
      totalMembers={totalMembers}
    >
          {/* Current members */}
          {(filteredUsers.length > 0 || filteredAgents.length > 0) && (
            <div>
              <div className={sectionHeadingClass}>In this channel</div>

              {filteredUsers.map((user) => (
                <CurrentUserRow
                  key={user.id}
                  user={user}
                  currentUserId={currentUserId}
                  removeLabel="Remove from channel"
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
    </MemberManagementPopup>
  )
}
