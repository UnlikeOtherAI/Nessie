import type { ChannelRecord, PersonalAssistantPresenceParticipant } from '../../../../lib/api-client'
import {
  useAddPersonalAssistantPresence,
  useRemovePersonalAssistantPresence,
} from '../../../../facades/personal-assistant/hooks'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { CurrentPersonalAssistantRow } from '../../../shared/channel-members/MemberAgentRow'

/**
 * Colleagues' assistants standing in this conversation, plus the control to
 * add or remove your own. It renders from both the Agent section (a one-to-one
 * conversation that also carries a presence) and the Agents list, so the
 * presence roster has one implementation rather than one per panel.
 *
 * Returns null when there is nothing to say and nothing to do.
 */
export const ChannelPersonalAssistantPresences = ({
  activeChannel,
  currentUserId,
  isPersonalAssistantConversation,
  presences,
}: {
  activeChannel: ChannelRecord | null
  currentUserId: string
  isPersonalAssistantConversation: boolean
  presences: PersonalAssistantPresenceParticipant[]
}) => {
  const addPersonalAssistant = useAddPersonalAssistantPresence()
  const removePersonalAssistant = useRemovePersonalAssistantPresence()
  const canManage = Boolean(
    activeChannel && !activeChannel.systemChannelType && !isPersonalAssistantConversation,
  )
  const hasMine = presences.some((presence) => presence.principalUserId === currentUserId)

  if (presences.length === 0 && !canManage) return null

  return (
    <article className="admin-card p-4">
      <SectionLabel>Personal Assistant presences</SectionLabel>
      <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
        Each presence is a colleague's assistant in this conversation, without exposing its
        private configuration.
      </p>
      <div className="mt-3 grid gap-1">
        {presences.map((presence) => (
          <CurrentPersonalAssistantRow
            currentUserId={currentUserId}
            key={presence.id}
            presence={presence}
            removePending={removePersonalAssistant.isPending}
            onRemove={() => {
              if (activeChannel) removePersonalAssistant.mutate(activeChannel.id)
            }}
          />
        ))}
      </div>
      {canManage && !hasMine ? (
        <button
          className="admin-button admin-button-secondary mt-3"
          disabled={addPersonalAssistant.isPending}
          onClick={() => {
            if (activeChannel) addPersonalAssistant.mutate(activeChannel.id)
          }}
          type="button"
        >
          {addPersonalAssistant.isPending ? 'Adding…' : 'Add my assistant'}
        </button>
      ) : null}
    </article>
  )
}
