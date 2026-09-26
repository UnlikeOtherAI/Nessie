import type { ChannelRecord } from '../../../../lib/api-client'
import { IdentityTile } from '../../../primitives/IdentityTile'
import { channelRoomControls } from '../channel-room-controls'
import type { ChatTool, ChatToolId } from '../tool-rail/chat-tools'
import { DetailsDoorways } from './DetailsDoorways'
import { DetailsRoomForm } from './DetailsRoomForm'
import { DetailsRoomLifecycle } from './DetailsRoomLifecycle'
import { isRoom } from './details-sections'

const GroupConversationMark = () => (
  <svg aria-hidden="true" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** What kind of conversation this is, in words, with who is in it. */
const kindLine = (channel: ChannelRecord, people: number, agents: number): string => {
  if (!isRoom(channel)) {
    const kind = channel.isGroupDm || people > 2 ? 'Group conversation' : 'Direct message'
    return `${kind} · ${plural(people, 'person', 'people')}`
  }
  const where = channel.projectName ? ` in ${channel.projectName}` : ''
  const kind = `${channel.visibility === 'protected' ? 'Protected' : 'Public'} channel${where}`
  return agents > 0
    ? `${kind} · ${plural(people, 'person', 'people')} · ${plural(agents, 'agent', 'agents')}`
    : `${kind} · ${plural(people, 'person', 'people')}`
}

type DetailsGeneralProps = {
  agentCount: number
  agentTools: readonly ChatTool[]
  channel: ChannelRecord
  onOpenFiles: () => void
  onOpenTool: (tool: ChatToolId) => void
  peopleCount: number
  threadId: string | null
}

/**
 * Details › General. Every conversation opens on what it is and what else it
 * holds (its agent's tools, its files). A room adds its name, topic,
 * description and visibility, then Archive and Delete — the Channel tab of the
 * settings dialog this replaced. A person who may not change the room reads
 * the same fields, disabled, with who can change them (plan R9); a direct
 * message has nothing a person here renames or archives.
 */
export const DetailsGeneral = ({
  agentCount,
  agentTools,
  channel,
  onOpenFiles,
  onOpenTool,
  peopleCount,
  threadId,
}: DetailsGeneralProps) => {
  const room = isRoom(channel)
  // The one rule for whether a room can be changed by this reader.
  const canManage = channelRoomControls({
    activeChannel: channel,
    isPersonalAssistantConversation: false,
  }).canManageChannel
  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        <IdentityTile
          background="var(--accent-soft)"
          color="var(--accent)"
          fallback={{ kind: 'icon', icon: <GroupConversationMark /> }}
          imageUrl={null}
          label={channel.label}
          size={48}
        />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-[color:var(--tx)]">
            {room ? `#${channel.label}` : channel.label}
          </p>
          <p className="text-xs text-[color:var(--tx3)]">{kindLine(channel, peopleCount, agentCount)}</p>
        </div>
      </div>

      <DetailsDoorways onOpenFiles={onOpenFiles} onOpenTool={onOpenTool} threadId={threadId} tools={agentTools} />

      {room ? (
        <div className="grid gap-5 border-t border-[color:var(--sep)] pt-5">
          {!canManage ? (
            <p className="text-sm text-[color:var(--tx3)]">
              Only members of this channel, or an organisation owner or admin, can change it.
            </p>
          ) : null}
          {/* Keyed by the room: another room is a fresh form, never this one's
              unsaved edits. */}
          <DetailsRoomForm canManage={canManage} channel={channel} key={channel.id} />
          <DetailsRoomLifecycle canManage={canManage} channel={channel} />
        </div>
      ) : null}
    </div>
  )
}
