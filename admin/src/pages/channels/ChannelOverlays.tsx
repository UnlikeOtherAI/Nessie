import type { ReactNode } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type {
  AgentRecord,
  CallRecord,
  ChannelRecord,
  MeResponse,
  ThreadMessageRecord,
  UserRecord,
} from '../../lib/api-client'
import type { MentionEntity } from '../../components/shared/MentionInput'
import { CallOverlay } from '../../components/shared/CallOverlay'
import { ChannelMembersPopup } from '../../components/shared/ChannelMembersPopup'
import { ChannelSettingsDialog } from '../../components/shared/ChannelSettingsDialog'
import { OversizePasteDialog } from '../../components/shared/OversizePasteDialog'
import { ThreadReplyPanel } from '../../components/features/channels/thread-panel/ThreadReplyPanel'
import type { MessageUserIdentity } from '../../components/features/channels/channel-helpers'
import type { PendingStreamMessage } from '../../facades/threads/thinking'
import { ChannelInfoDrawers } from './ChannelInfoDrawers'
import type { useReplyThread } from './useReplyThread'

interface ChannelOverlaysProps {
  activeChannel: ChannelRecord | null
  activeCall: CallRecord | null | undefined
  agentMap: Map<string, AgentRecord>
  agents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelUsers: UserRecord[]
  // Already-rendered node rather than the launcher hook: the overlay layer
  // places it, it does not own it.
  deepWaterDialog: ReactNode
  hasRespondingAgent: boolean
  isExternalAgentConversation: boolean
  isInCall: boolean
  isPersonalAssistantConversation: boolean
  me: MeResponse
  mentionEntities: MentionEntity[]
  oversizePaste: string | null
  pendingMessages: PendingStreamMessage[]
  renderContent: (text: string) => ReactNode
  replyThread: ReturnType<typeof useReplyThread>
  selectedMessageAgent: AgentRecord | null
  selectedMessageUser: MessageUserIdentity | null
  showCallOverlay: boolean
  showChannelSettings: boolean
  showMembersPopup: boolean
  threadMessages: ThreadMessageRecord[]
  // Runs whose reply lands in the open reply thread, so the panel renders their
  // bubble instead of the channel feed.
  threadPendingMessages: PendingStreamMessage[]
  token: string | null
  onCancelOversizePaste: () => void
  onCloseMembers: () => void
  onCloseSelectedAgent: () => void
  onCloseSelectedUser: () => void
  onCloseSettings: () => void
  onGroupCreated: (channelId: string) => void
  onInsertTrimmed: (trimmed: string) => void
  onLeaveCall: () => void
  onOpenAgentActivity: (agentId: string) => void
  onSelectAgent: (agentId: string) => void
  onSendAsFile: (text: string) => Promise<void>
}

/**
 * Everything that layers over the channel conversation: the reply-thread panel,
 * the members popup, channel settings, the oversize-paste prompt, the call
 * overlay and the agent/user info drawers.
 *
 * Extracted from `ChannelsPage` alongside `ChannelInfoDrawers` for the same
 * reason — the page composes ~15 hooks and was past the 500-line cap. This is
 * the cohesive half: none of it reads the message feed, so it takes values and
 * callbacks and renders, with no state of its own.
 */
export const ChannelOverlays = ({
  activeChannel,
  activeCall,
  agentMap,
  agents,
  allUsers,
  boundAgents,
  channelUsers,
  deepWaterDialog,
  hasRespondingAgent,
  isExternalAgentConversation,
  isInCall,
  isPersonalAssistantConversation,
  me,
  mentionEntities,
  oversizePaste,
  pendingMessages,
  renderContent,
  replyThread,
  selectedMessageAgent,
  selectedMessageUser,
  showCallOverlay,
  showChannelSettings,
  showMembersPopup,
  threadMessages,
  threadPendingMessages,
  token,
  onCancelOversizePaste,
  onCloseMembers,
  onCloseSelectedAgent,
  onCloseSelectedUser,
  onCloseSettings,
  onGroupCreated,
  onInsertTrimmed,
  onLeaveCall,
  onOpenAgentActivity,
  onSelectAgent,
  onSendAsFile,
}: ChannelOverlaysProps) => (
  <>
    {replyThread.openRootMessageId && activeChannel ? (
      <ThreadReplyPanel
        activeChannel={activeChannel}
        agentMap={agentMap}
        channelUsers={channelUsers}
        hasRespondingAgent={hasRespondingAgent}
        isExternalAgentConversation={isExternalAgentConversation}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        meAvatar={{
          avatarUrl: me.user.avatarUrl,
          avatarAttachmentId: me.user.avatarAttachmentId,
        }}
        meDisplayName={me.user.displayName}
        meUserId={me.user.id}
        mentionEntities={mentionEntities}
        pendingMessages={threadPendingMessages}
        renderContent={renderContent}
        thread={replyThread}
        token={token}
      />
    ) : null}

    {deepWaterDialog}

    {showMembersPopup && activeChannel ? (
      <ChannelMembersPopup
        allAgents={agents}
        allUsers={allUsers}
        boundAgents={boundAgents}
        channelId={activeChannel.id}
        channelLabel={activeChannel.label}
        channelType={activeChannel.type}
        channelUsers={channelUsers}
        currentUserId={me.user.id}
        onClose={onCloseMembers}
        onGroupCreated={onGroupCreated}
        onSelectAgent={onSelectAgent}
      />
    ) : null}

    {activeChannel ? (
      <ChannelSettingsDialog
        channel={activeChannel}
        onClose={onCloseSettings}
        open={showChannelSettings}
      />
    ) : null}

    <OversizePasteDialog
      limit={CHAT_MESSAGE_MAX_CHARS}
      onCancel={onCancelOversizePaste}
      onInsertTrimmed={onInsertTrimmed}
      onSendAsFile={onSendAsFile}
      open={oversizePaste !== null}
      pastedText={oversizePaste ?? ''}
    />

    {showCallOverlay && activeCall && isInCall && (
      <CallOverlay
        displayName={me.user.displayName ?? 'User'}
        onLeave={onLeaveCall}
        roomId={activeCall.roomId ?? ''}
      />
    )}

    <ChannelInfoDrawers
      activeChannel={activeChannel}
      agents={agents}
      allUsers={allUsers}
      me={me}
      mentionEntities={mentionEntities}
      pendingMessages={pendingMessages}
      renderContent={renderContent}
      selectedMessageAgent={selectedMessageAgent}
      selectedMessageUser={selectedMessageUser}
      threadMessages={threadMessages}
      token={token}
      onCloseAgent={onCloseSelectedAgent}
      onCloseUser={onCloseSelectedUser}
      onOpenActivity={onOpenAgentActivity}
    />
  </>
)
