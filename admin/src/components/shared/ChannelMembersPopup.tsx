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
import { useMemberFilters } from './channel-members/useMemberFilters'
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
import { MemberManagementPopup } from './MemberManagementPopup'

type ChannelMembersPopupProps = {
  allAgents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelId: string
  channelLabel: string
  channelUsers: UserRecord[]
  currentUserId: string
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  /**
   * Server-computed `ChannelRecord.viewerCanManage` — any member of the
   * channel, or an organisation owner/admin. Gates every add/remove control
   * here except a person's own "leave" row, which needs no authority over the
   * channel (see `docs/standards/disclosure-boundaries.md`), and except the
   * agent rows, which have their own narrower authority below.
  */
  viewerCanManage: boolean
  /**
   * Server-computed `ChannelRecord.viewerCanManageAgents`. Adding a PERSON is
   * any member of the channel; adding an AGENT additionally requires the
   * organisation owner role, so the two cannot share a flag. They did share
   * nothing at all until now: the agent rows were drawn unconditionally while
   * the server refused every non-owner.
   */
  viewerCanManageAgents: boolean
  onClose: () => void
  onSelectAgent: (agentId: string) => void
}

export const ChannelMembersPopup = ({
  allAgents,
  allUsers,
  boundAgents,
  channelId,
  channelLabel,
  channelUsers,
  currentUserId,
  personalAssistantPresences,
  viewerCanManage,
  viewerCanManageAgents,
  onClose,
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
  // `POST /api/channels/:channelId/personal-assistant` resolves the channel
  // through `getChannelIfMember`, so a person who has not joined this room is
  // answered 404. The popup opens on an unjoined public channel — the header's
  // Members action is not gated on membership — so without this the offer was
  // made to exactly the people it cannot be kept for. This is the membership
  // the popup is already rendering, not a second reading of an authority rule.
  const viewerIsChannelMember = channelUsers.some((user) => user.id === currentUserId)
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

  const handleAddUser = (userId: string) => addMember.mutate({ channelId, userId })

  return (
    <MemberManagementPopup
      entityLabel={`#${channelLabel}`}
      onClose={onClose}
      onSearchChange={setSearch}
      search={search}
      totalMembers={totalMembers + personalAssistantPresences.length}
    >
          {/* Current members */}
          {(filteredUsers.length > 0
            || filteredAgents.length > 0
            || filteredPersonalAssistantPresences.length > 0) && (
            <div>
              <div className={sectionHeadingClass}>In this channel</div>

              {filteredUsers.map((user) => (
                <CurrentUserRow
                  key={user.id}
                  canRemove={viewerCanManage}
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
                  canUnbind={viewerCanManageAgents}
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

              {viewerCanManage && availableUsers.map((user) => (
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
                  canBind={viewerCanManageAgents}
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

          {viewerIsChannelMember && !hasMyPersonalAssistant ? (
            <div className="mt-2">
              <div className={sectionHeadingClass}>Personal Assistant</div>
              <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[color:var(--tx)]" data-testid="channel-pa-offer">Add my assistant</div>
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
    </MemberManagementPopup>
  )
}
