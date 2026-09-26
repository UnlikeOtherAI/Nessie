import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { channelRoomControls } from '../../components/features/channels/channel-room-controls'
import { ConversationDetails } from '../../components/features/channels/details/ConversationDetails'
import { detailsPath } from '../../components/features/channels/details/details-sections'
import { availableChatTools, type ChatToolId } from '../../components/features/channels/tool-rail/chat-tools'
import { usePhoneNavigation } from '../../layouts/admin-shell/PhoneNavigationProvider'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../lib/api-client'
import { getConversationRoute, isConversationDetailsRoute } from '../../lib/conversation-navigation'
import { usePhoneLayout } from '../../navigation/mobile-shell'

type ConversationDetailsInput = {
  activeChannel: ChannelRecord | null
  /** Every agent that may be placed in a channel. */
  agents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelUsers: UserRecord[]
  chatToolAgents: readonly AgentRecord[]
  currentUserId: string
  isPersonalAssistantConversation: boolean
  onOpenTool: (tool: ChatToolId) => void
  threadId: string | null
}

type ConversationDetailsHost = {
  /** The header's gear: Details at General. */
  openDetails: () => void
  /** The header's Members count: Details at People. */
  openMembers: () => void
  /** On `split`, the sheet the page mounts beside the conversation. */
  sheet: ReactNode
  /** On `single`, on a Details route, the screen drawn in place of the conversation. */
  screen: ReactNode
}

/**
 * The Channels page's half of a conversation's Details: the doorways the
 * header calls and where the panel stands on each layout. Details' doorways
 * are its routes, so opening it is a navigation (the conversation's own
 * `?tab=` rides along); closing it is the route's own Back, which only the
 * page can reach — the navigation controller lives in the shell.
 */
export const useConversationDetails = ({
  activeChannel,
  agents,
  allUsers,
  boundAgents,
  channelUsers,
  chatToolAgents,
  currentUserId,
  isPersonalAssistantConversation,
  onOpenTool,
  threadId,
}: ConversationDetailsInput): ConversationDetailsHost => {
  const location = useLocation()
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  const phoneLayout = usePhoneLayout()
  const canOpen = channelRoomControls({ activeChannel, isPersonalAssistantConversation }).canOpenDetails

  const details = activeChannel && canOpen ? (
    <ConversationDetails
      agentTools={availableChatTools(chatToolAgents, activeChannel.type === 'dm')}
      agents={agents}
      allUsers={allUsers}
      boundAgents={boundAgents}
      channel={activeChannel}
      channelUsers={channelUsers}
      currentUserId={currentUserId}
      onClose={() => navigation?.performRouteBack()}
      onOpenTool={onOpenTool}
      personalAssistantPresences={activeChannel.personalAssistantPresences ?? []}
      threadId={threadId}
    />
  ) : null
  const onDetailsRoute = isConversationDetailsRoute(getConversationRoute(location.pathname))

  return {
    openDetails: () => {
      if (activeChannel) void navigate(detailsPath(activeChannel.id, 'general', location.search))
    },
    openMembers: () => {
      if (activeChannel) void navigate(detailsPath(activeChannel.id, 'people', location.search))
    },
    screen: phoneLayout && onDetailsRoute ? details : null,
    sheet: phoneLayout ? null : details,
  }
}
