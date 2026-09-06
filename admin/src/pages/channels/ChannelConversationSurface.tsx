import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
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
import {
  ChannelMessageFeed,
  type MessageHistoryStatus,
} from '../../components/features/channels/ChannelMessageFeed'
import { ChannelSearchPanel } from '../../components/features/channels/ChannelSearchPanel'
import { ChannelTabBar } from '../../components/features/channels/ChannelTabBar'
import { Pill } from '../../components/primitives/Pill'
import { agentSelectionLabel } from '../../components/shared/AgentVisibilityPill'
import { Dialog } from '../../components/shared/Dialog'
import { ChannelTabPanels } from '../../components/features/channels/ChannelTabPanels'
import { ExternalAgentIntro } from '../../components/features/channels/ExternalAgentIntro'
import type { ChannelTitleFavorite } from '../../components/features/channels/ChannelFavoriteButton'
import { buildFeedItems } from '../../components/features/channels/channel-feed'
import { type ChannelAgentParticipant, type MessageUserIdentity } from '../../components/features/channels/channel-participants'
import { type ChannelTab } from '../../components/features/channels/channel-tabs'
import { useAgentLivenessHint } from '../../components/features/channels/useAgentLivenessHint'
import { useChannelComposer } from '../../components/features/channels/useChannelComposer'
import { useFileDrop } from '../../hooks/useFileDrop'
import type { useShareRestrictedMessage } from '../../facades/messages/hooks'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import {
  useActiveDemonstrations,
  useDemonstrations,
  useStartDemonstration,
  useStopDemonstration,
} from '../../facades/demonstrations/hooks'
import type { DocumentStreamStore } from '../../facades/threads/document-stream-store'
import type { DocumentStreamEntry } from '../../facades/threads/document-stream-entries'
import type { PendingStreamMessage } from '../../facades/threads/thinking'
import type { useChannelMessageActions } from '../../components/features/channels/useChannelMessageActions'
import type { useChannelMentions } from './useChannelMentions'
import type { useChannelMessageSearch } from './useChannelMessageSearch'
import type { useDeepWaterResearchLauncher } from './useDeepWaterResearchLauncher'
import type { useExecutorRunLauncher } from './useExecutorRunLauncher'
import type { useReplyThread } from '../../components/features/channels/useReplyThread'

interface ChannelConversationSurfaceProps {
  activeCall: CallRecord | null | undefined
  activeChannel: ChannelRecord | null
  agentMap: Map<string, AgentRecord>
  agentTabAvailable: boolean
  agentsTabAvailable: boolean
  boundAgents: AgentRecord[]
  // The single agent a direct conversation is with, when there is one. Its
  // To-dos and Triggers sections hang off it.
  conversationAgent: AgentRecord | null
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
  composePlaceholder,
  composer,
  conversationAgent,
  deepWaterLauncher,
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
  const [recordRoutineOpen, setRecordRoutineOpen] = useState(false)
  const [selectedRoutineAgentId, setSelectedRoutineAgentId] = useState('')
  const { data: activeDemonstrations = [] } = useActiveDemonstrations(activeChannel?.id)
  const { data: ownDemonstrations = [] } = useDemonstrations()
  const startDemonstration = useStartDemonstration()
  const stopDemonstration = useStopDemonstration()
  const activeThreadId = activeChannel?.defaultThreadId
  const recording = activeDemonstrations.find(
    (entry) => entry.threadId === activeThreadId && entry.status === 'recording',
  )
  const ownRecording = ownDemonstrations.find((entry) => entry.id === recording?.id)

  useEffect(() => {
    if (!selectedRoutineAgentId && boundAgents[0]) {
      setSelectedRoutineAgentId(boundAgents[0].id)
    }
  }, [boundAgents, selectedRoutineAgentId])

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
        activeChannel={activeChannel}
        boundAgents={boundAgents}
        callEligible={callEligible}
        callMeetingUri={activeCall?.meetingUri}
        callStarting={callStarting}
        voiceCallActive={voiceCallActive}
        voiceCallSupported={voiceCallSupported}
        channelUsers={channelUsers}
        externalAgentIdentity={externalAgentIdentity}
        isExternalAgentConversation={isExternalAgentConversation}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        personalAssistantPresenceCount={personalAssistantPresences.length}
        joinPending={joinPending}
        searchOpen={search.searchOpen}
        titleFavorite={titleFavorite}
        onCallButton={onCallButton}
        onJoin={onJoin}
        onOpenInfo={onOpenInfo}
        onOpenMembers={onOpenMembers}
        onOpenSettings={onOpenSettings}
        onToggleRoutineRecording={() => setRecordRoutineOpen(true)}
        onToggleSearch={onToggleSearch}
        routineRecording={Boolean(recording)}
      />

      {recording ? (
        <div className="border-b border-[color:var(--sep)] px-3 py-2" data-testid="demonstration-recording-pill">
          <Pill tone="danger" uppercase={false}>Recording routine · structural tool steps only</Pill>
        </div>
      ) : null}

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
          {visibleActiveTab === 'messages' ? (
            <ChannelMessageFeed
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
          onDismissSecretCapture={composer.dismissSecretCapture}
          onInsertAtSign={() => composer.mentionRef.current?.insertAtSign()}
          onInsertEmoji={composer.insertEmoji}
          onInsertHashSign={() => composer.mentionRef.current?.insertHashSign()}
          onInvitePendingAgent={(agentId) => void composer.invitePendingAgent(agentId)}
          onConfirmSecretCapture={composer.confirmSecretCapture}
          onOpenDeepWaterResearch={deepWaterLauncher.open}
          onOpenExecutorRun={executorLauncher.open}
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
      <Dialog
        description="Teach an agent by doing a routine together once. Only completed, redacted structural tool calls are kept; a recording never runs automatically."
        dismissDisabled={startDemonstration.isPending || stopDemonstration.isPending}
        onClose={() => setRecordRoutineOpen(false)}
        open={recordRoutineOpen}
        title={recording ? 'Routine recording' : 'Record a routine'}
      >
        <div className="grid gap-4">
          {recording ? (
            <>
              <p className="text-sm text-[color:var(--tx2)]">
                Recording is visible to everyone in this channel.
              </p>
              {ownRecording ? (
                <button
                  className="admin-button admin-button-danger"
                  disabled={stopDemonstration.isPending}
                  onClick={() => {
                    void stopDemonstration
                      .mutateAsync(ownRecording.id)
                      .then(() => setRecordRoutineOpen(false))
                  }}
                  type="button"
                >
                  Stop and generalise to a draft Workflow
                </button>
              ) : (
                <p className="text-sm text-[color:var(--tx3)]">
                  Another channel member started this recording.
                </p>
              )}
            </>
          ) : (
            <>
              <label className="grid gap-1 text-sm font-medium text-[color:var(--tx)]">
                Agent to teach
                <select
                  className="admin-input"
                  onChange={(event) => setSelectedRoutineAgentId(event.target.value)}
                  value={selectedRoutineAgentId}
                >
                  {boundAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agentSelectionLabel(agent.name, agent.visibility)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="admin-button admin-button-primary"
                disabled={!activeChannel || !activeThreadId || !selectedRoutineAgentId || startDemonstration.isPending}
                onClick={() => {
                  if (!activeChannel || !activeThreadId || !selectedRoutineAgentId) return
                  // The app-wide mutation default surfaces a failure as a toast.
                  void startDemonstration.mutateAsync({
                    agentId: selectedRoutineAgentId,
                    channelId: activeChannel.id,
                    threadId: activeThreadId,
                  }).then(() => setRecordRoutineOpen(false)).catch(() => undefined)
                }}
                type="button"
              >
                Start recording
              </button>
            </>
          )}
        </div>
      </Dialog>

      <DropZoneOverlay active={chatDrop.isDragging} label="Drop files to attach" />
    </div>
  )
}
