import type { ReactNode } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import type {
  AgentRecord,
  CallRecord,
  ChannelRecord,
  MeResponse,
  PersonalAssistantPresenceParticipant,
  ThreadMessageRecord,
  UserRecord,
} from '../../lib/api-client'
import type { MentionEntity } from '../../components/shared/MentionInput'
import { ChannelMembersPopup } from '../../components/shared/ChannelMembersPopup'
import { ChannelSettingsDialog } from '../../components/shared/ChannelSettingsDialog'
import { OversizePasteDialog } from '../../components/shared/OversizePasteDialog'
import {
  CallerCallDialog,
  StartCallFailureDialog,
} from '../../components/features/channels/CallerCallDialog'
import VoiceCallDialog from '../../components/features/channels/VoiceCallDialog'
import type { VoiceCallState } from '../../facades/voice/voice-call-client'
import { AgentScreenPanel } from '../../components/features/browser-cloud/AgentScreenPanel'

/** What the page hands the overlay layer to render a live voice call. */
type VoiceCallOverlay = {
  onClose: () => void
  onEnd: () => void
  onRetry: () => void
  onToggleMute: () => void
  open: boolean
  state: VoiceCallState
}
import { ThreadReplyPanel } from '../../components/features/channels/thread-panel/ThreadReplyPanel'
import type {
  ChannelAgentParticipant,
  MessageUserIdentity,
} from '../../components/features/channels/channel-helpers'
import type { PendingStreamMessage } from '../../facades/threads/thinking'
import type { MessageHistoryStatus } from '../../components/features/channels/ChannelMessageFeed'
import type { OlderContentLoader } from '../../hooks/useStickToBottom'
import { ChannelInfoDrawers } from './ChannelInfoDrawers'
import type { useReplyThread } from './useReplyThread'

interface ChannelOverlaysProps {
  activeCall: CallRecord | null | undefined
  activeChannel: ChannelRecord | null
  agentMap: Map<string, AgentRecord>
  agents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  /** The agent browser session being watched, if any. */
  browserSessionId: string | null
  onCloseBrowserSession: () => void
  channelUsers: UserRecord[]
  callerCallActionError: unknown
  callerCallActionPending: boolean
  callerDialogCall: CallRecord | null
  voiceCall: VoiceCallOverlay
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  // Already-rendered node rather than the launcher hook: the overlay layer
  // places it, it does not own it.
  deepWaterDialog: ReactNode
  hasRespondingAgent: boolean
  isExternalAgentConversation: boolean
  isPersonalAssistantConversation: boolean
  me: MeResponse
  mentionEntities: MentionEntity[]
  oversizePaste: string | null
  pendingMessages: PendingStreamMessage[]
  renderContent: (text: string) => ReactNode
  replyThread: ReturnType<typeof useReplyThread>
  selectedMessageAgent: ChannelAgentParticipant | null
  selectedMessageUser: MessageUserIdentity | null
  startCallFailureCode: string | undefined
  showChannelSettings: boolean
  showMembersPopup: boolean
  threadMessages: ThreadMessageRecord[]
  threadMessageHistory: MessageHistoryStatus
  threadMessageLoader: OlderContentLoader
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
  onCloseCallerDialog: () => void
  onCloseStartCallFailure: () => void
  onFinishCall: () => void
  onOpenAgentActivity: (agentId: string) => void
  onSelectAgent: (agentId: string) => void
  onSendAsFile: (text: string) => Promise<void>
}

/**
 * Everything that layers over the channel conversation: the reply-thread panel,
 * the members popup, channel settings, the oversize-paste prompt, the call
 * caller dialog and the agent/user info drawers.
 *
 * Extracted from `ChannelsPage` alongside `ChannelInfoDrawers` for the same
 * reason — the page composes ~15 hooks and was past the 500-line cap. This is
 * the cohesive half: none of it reads the message feed, so it takes values and
 * callbacks and renders, with no state of its own.
 */
export const ChannelOverlays = ({
  activeCall,
  activeChannel,
  agentMap,
  agents,
  allUsers,
  boundAgents,
  channelUsers,
  callerCallActionError,
  callerCallActionPending,
  callerDialogCall,
  voiceCall,
  personalAssistantPresences,
  deepWaterDialog,
  hasRespondingAgent,
  isExternalAgentConversation,
  isPersonalAssistantConversation,
  me,
  mentionEntities,
  oversizePaste,
  pendingMessages,
  renderContent,
  replyThread,
  selectedMessageAgent,
  selectedMessageUser,
  startCallFailureCode,
  showChannelSettings,
  showMembersPopup,
  threadMessages,
  threadMessageHistory,
  threadMessageLoader,
  threadPendingMessages,
  token,
  onCancelOversizePaste,
  onCloseMembers,
  onCloseSelectedAgent,
  onCloseSelectedUser,
  onCloseSettings,
  onGroupCreated,
  onInsertTrimmed,
  browserSessionId,
  onCloseBrowserSession,
  onCloseCallerDialog,
  onCloseStartCallFailure,
  onFinishCall,
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

    {browserSessionId && !replyThread.openRootMessageId ? (
      <AgentScreenPanel onClose={onCloseBrowserSession} sessionId={browserSessionId} />
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
        personalAssistantPresences={personalAssistantPresences}
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

    {callerDialogCall && activeChannel ? (
      <CallerCallDialog
        actionError={callerCallActionError}
        actionPending={callerCallActionPending}
        canManageCallSettings={
          me.user.roleIds.includes('owner') || me.user.roleIds.includes('admin')
        }
        call={callerDialogCall}
        channelLabel={activeChannel.label}
        onCancel={onFinishCall}
        onClose={onCloseCallerDialog}
        onEnd={onFinishCall}
      />
    ) : null}

    <VoiceCallDialog
      onClose={voiceCall.onClose}
      onEnd={voiceCall.onEnd}
      onRetry={voiceCall.onRetry}
      onToggleMute={voiceCall.onToggleMute}
      open={voiceCall.open}
      state={voiceCall.state}
    />

    <StartCallFailureDialog
      code={startCallFailureCode}
      existingCall={activeCall}
      onClose={onCloseStartCallFailure}
      open={Boolean(startCallFailureCode)}
    />

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
      threadMessageHistory={threadMessageHistory}
      threadMessageLoader={threadMessageLoader}
      token={token}
      onCloseAgent={onCloseSelectedAgent}
      onCloseUser={onCloseSelectedUser}
      onOpenActivity={onOpenAgentActivity}
    />
  </>
)
