import { useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExternalAgentIdentity } from '../../facades/integrations/hooks'
import { usePersonalAssistant } from '../../facades/personal-assistant/hooks'
import type {
  AgentRecord,
  CallRecord,
  ChannelRecord,
  MeResponse,
  PersonalAssistantPresenceParticipant,
  UserRecord,
} from '../../lib/api-client'
import { CallBanner } from '../../components/shared/CallBanner'
import { DropZoneOverlay } from '../../components/shared/DropZoneOverlay'
import { ChannelComposer } from '../../components/features/channels/ChannelComposer'
import { ChannelHeader } from '../../components/features/channels/ChannelHeader'
import { channelRoomControls } from '../../components/features/channels/channel-room-controls'
import {
  ChannelMessageFeed,
  type MessageHistoryStatus,
} from '../../components/features/channels/ChannelMessageFeed'
import { ChannelSearchPanel } from '../../components/features/channels/ChannelSearchPanel'
import { ChannelTabBar } from '../../components/features/channels/ChannelTabBar'
import { Pill } from '../../components/primitives/Pill'
import { useActiveDemonstrations } from '../../facades/demonstrations/hooks'
import { ChannelTabPanels } from '../../components/features/channels/ChannelTabPanels'
import { ExternalAgentIntro } from '../../components/features/channels/ExternalAgentIntro'
import { AgentSessionHome, type AgentSessionHomeProps } from '../../components/features/agents/conversations/AgentSessionHome'
import type { ChannelTitleFavorite } from '../../components/features/channels/ChannelFavoriteButton'
import type { ConversationRenameDoorway } from '../../components/features/channels/rename-conversation'
import { buildFeedItems } from '../../components/features/channels/channel-feed'
import { type ChannelAgentParticipant, type MessageUserIdentity } from '../../components/features/channels/channel-participants'
import { type ChannelTab } from '../../components/features/channels/channel-tabs'
import { type ChatToolId } from '../../components/features/channels/tool-rail/chat-tools'
import { useAgentLivenessHint } from '../../components/features/channels/useAgentLivenessHint'
import { useChannelComposer } from '../../components/features/channels/useChannelComposer'
import { useFileDrop } from '../../hooks/useFileDrop'
import type { useShareRestrictedMessage } from '../../facades/messages/hooks'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import type { DocumentStreamStore } from '../../facades/threads/document-stream-store'
import type { DocumentStreamEntry } from '../../facades/threads/document-stream-entries'
import type { PendingStreamMessage } from '../../facades/threads/thinking'
import type { useChannelMessageActions } from '../../components/features/channels/useChannelMessageActions'
import type { useChannelMentions } from './useChannelMentions'
import type { useChannelMessageSearch } from './useChannelMessageSearch'
import type { useExecutorRunLauncher } from './useExecutorRunLauncher'
import type { useReplyThread } from '../../components/features/channels/useReplyThread'
import { useResearchComposerButton } from '../../components/features/deep-water/useResearchComposerButton'
import { ChannelPostRefusal } from '../../components/features/channels/ChannelPostRefusal'
import { RoutineRecordingDialog } from '../../components/features/channels/RoutineRecordingDialog'
import type { WorkThreadComposer } from '../../components/features/ticket-work/WorkThreadReadOnlyNotice'
interface ChannelConversationSurfaceProps {
  sessionHome?: AgentSessionHomeProps | null
  activeCall: CallRecord | null | undefined
  activeChannel: ChannelRecord | null
  /**
   * The thread on screen: the room's General thread, or the conversation the
   * route names (docs/plans/2026-09-08-agent-conversations.md).
   */
  activeThreadId: string | null
  /** Set only inside a conversation; the header then names it, not the room. */
  conversation: { eyebrow: string; title: string } | null
  /** The header's rename doorway; the page owns the rule and the dialog. */
  conversationRename: ConversationRenameDoorway | null
  agentMap: Map<string, AgentRecord>
  agentTabAvailable: boolean
  agentsTabAvailable: boolean
  boundAgents: AgentRecord[]
  // The single agent a direct conversation is with, when there is one. Its
  // To-dos and Triggers sections hang off it.
  conversationAgent: AgentRecord | null
  // The agents whose tools this room offers — a set, because an ordinary room
  // an agent works in has a conversations doorway too, while tabs need one agent.
  chatToolAgents: readonly AgentRecord[]
  callEligible: boolean
  callStarting: boolean
  voiceCallActive: boolean
  voiceCallSupported: boolean
  channelLiveness: ReturnType<typeof useAgentLivenessHint>
  channelUsers: UserRecord[]
  chatDrop: ReturnType<typeof useFileDrop>
  composePlaceholder: string
  composer: Pick<
    ReturnType<typeof useChannelComposer>,
    | 'attachments'
    | 'confirmSecretCapture'
    | 'dismissPendingAgent'
    | 'dismissSecretCapture'
    | 'mentionInvite'
    | 'insertEmoji'
    | 'inviteErrors'
    | 'invitePendingAgent'
    | 'invitingAgentId'
    | 'isSendPending'
    | 'sendError'
    | 'mentionRef'
    | 'message'
    | 'optimisticMessages'
    | 'pendingAgentInvites'
    | 'sendMessageSubmit'
    | 'sendText'
    | 'setMessage'
    | 'setOversizePaste'
    | 'secretCapture'
  >
  // Live document composition for this conversation; the feed owns the popup.
  documentSessions: DocumentStreamEntry[]
  documentStore: DocumentStreamStore
  executorLauncher: ReturnType<typeof useExecutorRunLauncher>
  externalAgentIdentity: ExternalAgentIdentity | null
  feedItems: ReturnType<typeof buildFeedItems>
  feedScroll: ReturnType<typeof useStickToBottom>
  messageHistory: MessageHistoryStatus
  isConversationSurface: boolean
  isExternalAgentConversation: boolean
  isPersonalAssistantConversation: boolean
  triggersTabAvailable: boolean
  todosTabAvailable: boolean
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  joinPending: boolean
  mentionEntities: ReturnType<typeof useChannelMentions>['mentionEntities']
  messageActions: Pick<
    ReturnType<typeof useChannelMessageActions>,
    | 'addReaction'
    | 'cancelEdit'
    | 'changeEditingContent'
    | 'confirmDelete'
    | 'deleteConfirm'
    | 'editingContent'
    | 'editingMessageId'
    | 'startEdit'
    | 'submitEdit'
    | 'updatePending'
  >
  me: MeResponse
  onCallButton: () => void
  /** Opens one of `chatToolAgents`' tools; the page owns the route. */
  onOpenChatTool: (tool: ChatToolId) => void
  onCreateAgent: () => void
  onJoin: () => void
  onOpenInfo: () => void
  onOpenMembers: () => void
  onOpenSettings: () => void
  onSelectMessageAgent: (agent: ChannelAgentParticipant) => void
  onSelectMessageUser: Dispatch<SetStateAction<MessageUserIdentity | null>>
  onToggleSearch: () => void
  pendingMessages: PendingStreamMessage[]
  personalAssistantChannel: ChannelRecord | null
  personalAssistantState: ReturnType<typeof usePersonalAssistant>['data']
  renderContent: ReturnType<typeof useChannelMentions>['renderContent']
  replyThread: ReturnType<typeof useReplyThread>
  search: ReturnType<typeof useChannelMessageSearch>
  shareRestricted: ReturnType<typeof useShareRestrictedMessage>
  setActiveTab: (tab: ChannelTab) => void
  titleFavorite: ChannelTitleFavorite | null
  token: string | null
  visibleActiveTab: ChannelTab
  /** Set when this is a ticket's work thread: who may write there, and what a message does. */
  workThread: WorkThreadComposer | null
}

/**
 * The channel detail column. It is deliberately presentational: route and
 * selection state stay in `ChannelsPage`, while the root page can stay small
 * enough to make the phone navigation boundary obvious.
 */
export const ChannelConversationSurface = ({
  activeCall,
  activeChannel,
  activeThreadId,
  conversation,
  agentMap,
  agentTabAvailable,
  agentsTabAvailable,
  boundAgents,
  callEligible,
  callStarting,
  voiceCallActive,
  voiceCallSupported,
  channelLiveness,
  channelUsers,
  chatDrop,
  chatToolAgents,
  composePlaceholder,
  composer,
  conversationAgent,
  conversationRename,
  documentSessions,
  documentStore,
  executorLauncher,
  externalAgentIdentity,
  feedItems,
  feedScroll,
  messageHistory,
  isConversationSurface,
  isExternalAgentConversation,
  isPersonalAssistantConversation,
  triggersTabAvailable,
  todosTabAvailable,
  personalAssistantPresences,
  sessionHome,
  joinPending,
  mentionEntities,
  messageActions,
  me,
  onCallButton,
  onOpenChatTool,
  onCreateAgent,
  onJoin,
  onOpenInfo,
  onOpenMembers,
  onOpenSettings,
  onSelectMessageAgent,
  onSelectMessageUser,
  onToggleSearch,
  pendingMessages,
  personalAssistantChannel,
  personalAssistantState,
  renderContent,
  replyThread,
  search,
  shareRestricted,
  setActiveTab,
  titleFavorite,
  token,
  visibleActiveTab,
  workThread,
}: ChannelConversationSurfaceProps) => {
  const { t } = useTranslation('channels')
  const {
    addReaction,
    cancelEdit,
    changeEditingContent,
    confirmDelete,
    deleteConfirm,
    editingContent,
    editingMessageId,
    startEdit,
    submitEdit,
    updatePending,
  } = messageActions
  const researchButton = useResearchComposerButton(composer.message)
  // The same derivation the header uses, so the composer and the Join action
  // can never disagree about whether this person is in the room.
  const roomControls = channelRoomControls({ activeChannel, isPersonalAssistantConversation })
  const callerName = activeCall?.startedByDisplayName ?? null
  const [recordRoutineOpen, setRecordRoutineOpen] = useState(false)
  const { data: activeDemonstrations = [] } = useActiveDemonstrations(activeChannel?.id)
  const recording = activeDemonstrations.find(
    (entry) => entry.threadId === activeThreadId && entry.status === 'recording',
  )

  return (
    <div
      className="admin-chat-surface relative flex min-w-0 flex-1 flex-col"
      // Tapping back into the conversation dismisses an open reply thread —
      // the desktop equivalent of the scrim the tablet layout already has.
      // Capture phase, so a reply control that opens a *different* thread runs
      // afterwards and cancels this close rather than racing it.
      onClickCapture={replyThread.closeThreadFromConversation}
      {...chatDrop.dropHandlers}
    >
      <ChannelHeader
        activeCall={Boolean(activeCall)}
        activeChannel={activeChannel} hideConversations={activeChannel?.type === 'dm'}
        boundAgents={boundAgents}
        callEligible={callEligible}
        callMeetingUri={activeCall?.meetingUri}
        callStarting={callStarting}
        voiceCallActive={voiceCallActive}
        voiceCallSupported={voiceCallSupported}
        channelUsers={channelUsers}
        conversation={conversation}
        externalAgentIdentity={externalAgentIdentity}
        isExternalAgentConversation={isExternalAgentConversation}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        personalAssistantPresenceCount={personalAssistantPresences.length}
        joinPending={joinPending}
        searchOpen={search.searchOpen}
        titleFavorite={titleFavorite}
        chatToolAgents={chatToolAgents}
        conversationRename={conversationRename}
        onCallButton={onCallButton}
        onOpenChatTool={onOpenChatTool}
        onJoin={onJoin}
        onOpenInfo={onOpenInfo}
        onOpenMembers={onOpenMembers}
        onOpenSettings={onOpenSettings}
        onToggleRoutineRecording={() => setRecordRoutineOpen(true)}
        onToggleSearch={onToggleSearch}
        routineRecording={Boolean(recording)}
      />


      {search.searchOpen ? (
        <ChannelSearchPanel
          searchQuery={search.searchQuery}
          searchResults={search.searchResults}
          onChangeQuery={search.setSearchQuery}
          onClose={search.closeSearch}
          onSelectResult={(messageId) => {
            search.jumpToMessage(messageId)
            search.closeSearch()
          }}
        />
      ) : null}

      {activeCall?.meetingUri && callerName ? (
        <CallBanner callerName={callerName} meetingUri={activeCall.meetingUri} />
      ) : null}

      <ChannelTabBar
        showAgentTab={agentTabAvailable}
        showAgentsTab={agentsTabAvailable}
        showAutomationsTab={!isConversationSurface}
        showTriggersTab={triggersTabAvailable}
        showTodosTab={todosTabAvailable}
        visibleActiveTab={visibleActiveTab}
        onSelectTab={setActiveTab}
      />

      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        data-testid="channel-content-scroll"
        ref={feedScroll.containerRef}
      >
        <div ref={feedScroll.contentRef}>
          {visibleActiveTab === 'messages' && sessionHome ? <AgentSessionHome {...sessionHome} />
            : visibleActiveTab === 'messages' ? (
            <ChannelMessageFeed
              channelId={activeChannel?.id ?? null}
              documentSessions={documentSessions}
              documentStore={documentStore}
              agentById={agentMap}
              agentMap={agentMap}
              channelUsers={channelUsers}
              personalAssistantPresences={personalAssistantPresences}
              editingContent={editingContent}
              editingMessageId={editingMessageId}
              externalAgentDisplayName={activeChannel?.label}
              feedItems={feedItems}
              historyStatus={messageHistory}
              isExternalAgentConversation={isExternalAgentConversation}
              isPersonalAssistantConversation={isPersonalAssistantConversation}
              meAvatar={{
                avatarAttachmentId: me.user.avatarAttachmentId,
                avatarUrl: me.user.avatarUrl,
              }}
              meDisplayName={me.user.displayName}
              meUserId={me.user.id}
              optimisticMessages={composer.optimisticMessages}
              pendingMessages={pendingMessages}
              renderContent={renderContent}
              showLivenessHint={channelLiveness.visible}
              threadId={activeThreadId ?? undefined}
              token={token}
              updatePending={updatePending}
              emptyState={
                isExternalAgentConversation && externalAgentIdentity ? (
                  <ExternalAgentIntro
                    identity={externalAgentIdentity}
                    onSelectStarter={(prompt) => void composer.sendText(prompt)}
                  />
                ) : undefined
              }
              shareRestrictedMessage={async (messageId, input) => {
                await shareRestricted.mutateAsync({ messageId, ...input })
              }}
              onAddReaction={addReaction}
              onCancelEdit={cancelEdit}
              onChangeEditingContent={changeEditingContent}
              onConfirmDelete={confirmDelete}
              onOpenThread={replyThread.openThread}
              onJumpToMessage={search.jumpToMessage}
              onSelectAgent={
                isPersonalAssistantConversation ? undefined : onSelectMessageAgent
              }
              onSelectUser={activeChannel?.type === 'dm' ? undefined : onSelectMessageUser}
              onStartEdit={startEdit}
              onSubmitEdit={(messageId) => void submitEdit(messageId)}
              resolveThreadParticipant={replyThread.resolveThreadParticipant}
            />
          ) : null}

          <ChannelTabPanels
            activeChannel={activeChannel}
            boundAgents={boundAgents}
            conversationAgent={conversationAgent}
            isConversationSurface={isConversationSurface}
            isPersonalAssistantConversation={isPersonalAssistantConversation}
            personalAssistantChannel={personalAssistantChannel}
            personalAssistantState={personalAssistantState}
            personalAssistantPresences={personalAssistantPresences}
            currentUserId={me.user.id}
            visibleActiveTab={visibleActiveTab}
            onCreateAgent={onCreateAgent}
          />
        </div>
      </div>

      {/* The composer, or why it is not here (`ChannelPostRefusal`). */}
      {recording ? (
        <div className="border-b border-[color:var(--sep)] px-3 py-2" data-testid="demonstration-recording-pill">
          <Pill tone="danger" uppercase={false}>{t('routine.recordingBadge')}</Pill>
        </div>
      ) : null}
      {visibleActiveTab === 'messages' && !sessionHome ? (
        <ChannelPostRefusal postRefusal={roomControls.postRefusal} workThread={workThread} />
      ) : null}

      {visibleActiveTab === 'messages' && !sessionHome && roomControls.canPost && !workThread?.readOnly ? (
        <ChannelComposer
          attachments={composer.attachments}
          inviteErrors={composer.inviteErrors}
          invitingAgentId={composer.invitingAgentId}
          isSendPending={composer.isSendPending}
          sendError={composer.sendError}
          mentionEntities={mentionEntities}
          mentionRef={composer.mentionRef}
          message={composer.message}
          pendingAgentInvites={composer.pendingAgentInvites}
          placeholder={composePlaceholder}
          onChangeMessage={composer.setMessage}
          onDismissPendingAgent={composer.dismissPendingAgent}
          onDismissSecretCapture={composer.dismissSecretCapture}
          mentionInvite={composer.mentionInvite}
          onInsertAtSign={() => composer.mentionRef.current?.insertAtSign()}
          onInsertEmoji={composer.insertEmoji}
          onInsertHashSign={() => composer.mentionRef.current?.insertHashSign()}
          onInvitePendingAgent={(agentId) => void composer.invitePendingAgent(agentId)}
          onConfirmSecretCapture={composer.confirmSecretCapture}
          researchButton={researchButton}
          onOpenExecutorRun={executorLauncher.open}
          executorLeaseIndicator={executorLauncher.leaseIndicator}
          onOversizePaste={composer.setOversizePaste}
          onSubmitForm={(event) => {
            feedScroll.pinToBottom()
            channelLiveness.markSent()
            void composer.sendMessageSubmit(event)
          }}
          onSubmitText={(text, agentMentions) => {
            feedScroll.pinToBottom()
            channelLiveness.markSent()
            void composer.sendText(text, agentMentions)
          }}
          secretCapture={composer.secretCapture}
        />
      ) : null}

      {deleteConfirm}
      <RoutineRecordingDialog
        activeChannel={activeChannel}
        activeThreadId={activeThreadId}
        boundAgents={boundAgents}
        onClose={() => setRecordRoutineOpen(false)}
        open={recordRoutineOpen}
      />
      <DropZoneOverlay active={chatDrop.isDragging} label={t('compose.dropFiles')} />
    </div>
  )
}
