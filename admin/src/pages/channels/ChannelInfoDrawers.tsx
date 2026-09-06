import type { ReactNode } from 'react'
import type {
  AgentRecord,
  ChannelRecord,
  MeResponse,
  ThreadMessageRecord,
  UserRecord,
} from '../../lib/api-client'
import type { AvatarSources } from '../../components/shared/UserAvatar'
import type { MentionEntity } from '../../components/shared/MentionInput'
import { ChannelAgentInfoDrawer } from '../../components/features/channels/ChannelAgentInfoDrawer'
import { ChannelUserInfoDrawer } from '../../components/features/channels/ChannelUserInfoDrawer'
import type { MessageHistoryStatus } from '../../components/features/channels/ChannelMessageFeed'
import type { ChannelAgentParticipant, MessageUserIdentity } from '../../components/features/channels/channel-participants'
import type { PendingStreamMessage } from '../../facades/threads/thinking'
import type { OlderContentLoader } from '../../hooks/useStickToBottom'

interface ChannelInfoDrawersProps {
  activeChannel: ChannelRecord | null
  agents: AgentRecord[]
  allUsers: UserRecord[]
  me: MeResponse
  mentionEntities: MentionEntity[]
  pendingMessages: PendingStreamMessage[]
  renderContent: (text: string) => ReactNode
  selectedMessageAgent: ChannelAgentParticipant | null
  selectedMessageUser: MessageUserIdentity | null
  threadMessages: ThreadMessageRecord[]
  threadMessageHistory: MessageHistoryStatus
  threadMessageLoader: OlderContentLoader
  token: string | null
  onCloseAgent: () => void
  onCloseUser: () => void
  onOpenActivity: (agentId: string) => void
}

// The agent/user info drawers slide over the channel page; extracted from
// ChannelsPage so the page stays under the file-size cap.
export const ChannelInfoDrawers = ({
  activeChannel,
  agents,
  allUsers,
  me,
  mentionEntities,
  pendingMessages,
  renderContent,
  selectedMessageAgent,
  selectedMessageUser,
  threadMessages,
  threadMessageHistory,
  threadMessageLoader,
  token,
  onCloseAgent,
  onCloseUser,
  onOpenActivity,
}: ChannelInfoDrawersProps) => {
  const meAvatar: AvatarSources = {
    avatarUrl: me.user.avatarUrl,
    avatarAttachmentId: me.user.avatarAttachmentId,
  }

  return (
    <>
      <ChannelAgentInfoDrawer
        activeChannel={activeChannel}
        agent={selectedMessageAgent}
        agents={agents}
        meAvatar={meAvatar}
        meDisplayName={me.user.displayName}
        meUserId={me.user.id}
        mentionEntities={mentionEntities}
        pendingMessages={pendingMessages}
        renderContent={renderContent}
        threadMessages={threadMessages}
        threadMessageHistory={threadMessageHistory}
        threadMessageLoader={threadMessageLoader}
        token={token}
        onClose={onCloseAgent}
        onOpenActivity={onOpenActivity}
      />

      <ChannelUserInfoDrawer
        agents={agents}
        meAvatar={meAvatar}
        meDisplayName={me.user.displayName}
        meUserId={me.user.id}
        target={selectedMessageUser}
        token={token}
        users={allUsers}
        onClose={onCloseUser}
      />
    </>
  )
}
