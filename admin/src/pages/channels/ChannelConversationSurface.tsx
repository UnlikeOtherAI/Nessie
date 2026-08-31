import type { Dispatch, SetStateAction } from 'react'
import type { ExternalAgentIdentity } from '../../facades/integrations/hooks'
import { usePersonalAssistant } from '../../facades/personal-assistant/hooks'
import type {
  AgentRecord,
  CallRecord,
  ChannelRecord,
  MeResponse,
  UserRecord,
} from '../../lib/api-client'
import { CallBanner } from '../../components/shared/CallBanner'
import { DropZoneOverlay } from '../../components/shared/DropZoneOverlay'
import { ChannelComposer } from '../../components/features/channels/ChannelComposer'
import { SecretCaptureDialog } from '../../components/features/channels/SecretCaptureDialog'
import { ChannelHeader } from '../../components/features/channels/ChannelHeader'
import { ChannelMessageFeed } from '../../components/features/channels/ChannelMessageFeed'
import { ChannelSearchPanel } from '../../components/features/channels/ChannelSearchPanel'
import { ChannelTabBar } from '../../components/features/channels/ChannelTabBar'
import { ChannelTabPanels } from '../../components/features/channels/ChannelTabPanels'
import { ExternalAgentIntro } from '../../components/features/channels/ExternalAgentIntro'
import type { ChannelTitleFavorite } from '../../components/features/channels/ChannelFavoriteButton'
import {
  buildFeedItems,
  type ChannelTab,
  type MessageUserIdentity,
} from '../../components/features/channels/channel-helpers'
import { useAgentLivenessHint } from '../../components/features/channels/useAgentLivenessHint'
import { useChannelComposer } from '../../components/features/channels/useChannelComposer'
import { useFileDrop } from '../../hooks/useFileDrop'
import type { useShareRestrictedMessage } from '../../facades/messages/hooks'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import type { DocumentStreamStore } from '../../facades/threads/document-stream-store'
import type { DocumentStreamEntry } from '../../facades/threads/document-stream-helpers'
import type { PendingStreamMessage } from '../../facades/threads/thinking'
import type { useChannelMessageActions } from '../../components/features/channels/useChannelMessageActions'
import type { useChannelMentions } from './useChannelMentions'
import type { useChannelMessageSearch } from './useChannelMessageSearch'
import type { useDeepWaterResearchLauncher } from './useDeepWaterResearchLauncher'
import type { useExecutorRunLauncher } from './useExecutorRunLauncher'
import type { useReplyThread } from './useReplyThread'

interface ChannelConversationSurfaceProps {
  activeCall: CallRecord | null | undefined
  activeChannel: ChannelRecord | null
  agentMap: Map<string, AgentRecord>
  agentsTabAvailable: boolean
  boundAgents: AgentRecord[]
  callEligible: boolean
  callStarting: boolean
  channelLiveness: ReturnType<typeof useAgentLivenessHint>
  channelUsers: UserRecord[]
  chatDrop: ReturnType<typeof useFileDrop>
  composePlaceholder: string
  composer: Pick<
    ReturnType<typeof useChannelComposer>,
    | 'attachments'
    | 'dismissPendingAgent'
    | 'dismissSecretCapture'
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
  deepWaterLauncher: ReturnType<typeof useDeepWaterResearchLauncher>
  // Live document composition for this conversation; the feed owns the popup.
  documentSessions: DocumentStreamEntry[]
  documentStore: DocumentStreamStore
  executorLauncher: ReturnType<typeof useExecutorRunLauncher>
  externalAgentIdentity: ExternalAgentIdentity | null
  feedItems: ReturnType<typeof buildFeedItems>
  feedScroll: ReturnType<typeof useStickToBottom>
  isConversationSurface: boolean
  isExternalAgentConversation: boolean
  isPersonalAssistantConversation: boolean
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
  onCreateAgent: () => void
  onJoin: () => void
  onOpenInfo: () => void
  onOpenMembers: () => void
  onOpenSettings: () => void
  onSelectAgent: (agentId: string) => void
  onSelectMessageAgent: (agent: AgentRecord) => void
  onSelectMessageUser: Dispatch<SetStateAction<MessageUserIdentity | null>>
  onToggleSearch: () => void
  pendingMessages: PendingStreamMessage[]
  personalAssistantAgent: AgentRecord | null
  personalAssistantChannel: ChannelRecord | null
  personalAssistantState: ReturnType<typeof usePersonalAssistant>['data']
  renderContent: ReturnType<typeof useChannelMentions>['renderContent']
  replyThread: ReturnType<typeof useReplyThread>
  search: ReturnType<typeof useChannelMessageSearch>
  shareRestricted: ReturnType<typeof useShareRestrictedMessage>
  setActiveTab: Dispatch<SetStateAction<ChannelTab>>
  titleFavorite: ChannelTitleFavorite | null
  token: string | null
  visibleActiveTab: ChannelTab
}

/**
 * The channel detail column. It is deliberately presentational: route and
 * selection state stay in `ChannelsPage`, while the root page can stay small
 * enough to make the phone navigation boundary obvious.
 */
export const ChannelConversationSurface = ({
  activeCall,
  activeChannel,
  agentMap,
  agentsTabAvailable,
  boundAgents,
  callEligible,
  callStarting,
  channelLiveness,
  channelUsers,
  chatDrop,
  composePlaceholder,
  composer,
  deepWaterLauncher,
  documentSessions,
  documentStore,
  executorLauncher,
  externalAgentIdentity,
  feedItems,
  feedScroll,
  isConversationSurface,
  isExternalAgentConversation,
  isPersonalAssistantConversation,
  joinPending,
  mentionEntities,
  messageActions,
  me,
  onCallButton,
  onCreateAgent,
  onJoin,
  onOpenInfo,
  onOpenMembers,
  onOpenSettings,
  onSelectAgent,
  onSelectMessageAgent,
  onSelectMessageUser,
  onToggleSearch,
  pendingMessages,
  personalAssistantAgent,
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
}: ChannelConversationSurfaceProps) => {
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
  const callerName = activeCall?.startedByDisplayName ?? null

  return (
    <div
      className="admin-chat-surface relative flex min-w-0 flex-1 flex-col"
      {...chatDrop.dropHandlers}
    >
      <ChannelHeader
        activeCall={Boolean(activeCall)}
        activeChannel={activeChannel}
        boundAgents={boundAgents}
        callEligible={callEligible}
        callMeetingUri={activeCall?.meetingUri}
        callStarting={callStarting}
        channelUsers={channelUsers}
        externalAgentIdentity={externalAgentIdentity}
        isExternalAgentConversation={isExternalAgentConversation}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        joinPending={joinPending}
        searchOpen={search.searchOpen}
        titleFavorite={titleFavorite}
        onCallButton={onCallButton}
        onJoin={onJoin}
        onOpenInfo={onOpenInfo}
        onOpenMembers={onOpenMembers}
        onOpenSettings={onOpenSettings}
        onToggleSearch={onToggleSearch}
      />

      {search.searchOpen ? (
        <ChannelSearchPanel
          searchQuery={search.searchQuery}
          searchResults={search.searchResults}
          onChangeQuery={search.setSearchQuery}
          onClose={search.closeSearch}
          onSelectResult={(messageId) => {
            feedScroll.releasePin()
            search.jumpToMessage(messageId)
            search.closeSearch()
          }}
        />
      ) : null}

      {activeCall?.meetingUri && callerName ? (
        <CallBanner callerName={callerName} meetingUri={activeCall.meetingUri} />
      ) : null}

      <ChannelTabBar
        showAgentsTab={agentsTabAvailable}
        showAutomationsTab={!isConversationSurface}
        visibleActiveTab={visibleActiveTab}
        onSelectTab={setActiveTab}
      />

      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        data-testid="channel-content-scroll"
        ref={feedScroll.containerRef}
      >
        <div ref={feedScroll.contentRef}>
          {visibleActiveTab === 'messages' ? (
            <ChannelMessageFeed
              documentSessions={documentSessions}
              documentStore={documentStore}
              agentById={agentMap}
              agentMap={agentMap}
              channelUsers={channelUsers}
              editingContent={editingContent}
              editingMessageId={editingMessageId}
              externalAgentDisplayName={activeChannel?.label}
              feedItems={feedItems}
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
              threadId={activeChannel?.defaultThreadId}
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
            isConversationSurface={isConversationSurface}
            isPersonalAssistantConversation={isPersonalAssistantConversation}
            personalAssistantAgent={personalAssistantAgent}
            personalAssistantChannel={personalAssistantChannel}
            personalAssistantState={personalAssistantState}
            visibleActiveTab={visibleActiveTab}
            onCreateAgent={onCreateAgent}
            onSelectAgent={onSelectAgent}
          />
        </div>
      </div>

      {visibleActiveTab === 'messages' ? (
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
        onInsertAtSign={() => composer.mentionRef.current?.insertAtSign()}
        onInsertEmoji={composer.insertEmoji}
        onInsertHashSign={() => composer.mentionRef.current?.insertHashSign()}
        onInvitePendingAgent={(agentId) => void composer.invitePendingAgent(agentId)}
        onOpenDeepWaterResearch={deepWaterLauncher.open}
        onOpenExecutorRun={executorLauncher.open}
        onOversizePaste={composer.setOversizePaste}
        onSubmitForm={(event) => {
          feedScroll.pinToBottom()
          channelLiveness.markSent()
          void composer.sendMessageSubmit(event)
        }}
        onSubmitText={(text) => {
          feedScroll.pinToBottom()
          channelLiveness.markSent()
          void composer.sendText(text)
        }}
        />
      ) : null}

      {deleteConfirm}
      {composer.secretCapture ? (
        <SecretCaptureDialog capture={composer.secretCapture} onClose={composer.dismissSecretCapture} />
      ) : null}

      <DropZoneOverlay active={chatDrop.isDragging} label="Drop files to attach" />
    </div>
  )
}
