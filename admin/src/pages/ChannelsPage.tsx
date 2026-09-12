import { useState } from 'react'
import { Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useRedirect } from '../navigation/redirect'
import { useChannelPlaceableAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { useExternalAgentIdentity } from '../facades/integrations/hooks'
import {
  isExternalAgentChannel,
  isGlobalAgentChannel,
  isPersonalAssistantChannel,
  usePersonalAssistant,
} from '../facades/personal-assistant/hooks'
import { useConversation } from '../facades/threads/hooks'
import { usePersonalAssistantCall, useVoiceCapability } from '../facades/voice/hooks'
import { useUsers } from '../facades/users/hooks'
import { useShellActions } from '../layouts/admin-shell/ShellStateContext'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { readChannelComposeReturnTo } from '../lib/channel-compose-navigation'
import { parseChannelIdFromPath } from '../lib/channel-route'
import { usePhoneLayout } from '../navigation/mobile-shell'
import { useIsOwner } from '../facades/auth/hooks'
import { ConversationInfoFlow } from '../components/features/channels/ConversationInfoFlow'
import { type ChannelAgentParticipant, type MessageUserIdentity } from '../components/features/channels/channel-participants'
import type { ConversationRenameDoorway } from '../components/features/channels/rename-conversation'
import { ChatToolDock } from '../components/features/channels/tool-rail/ChatToolDock'
import { conversationRoomEyebrow } from '../components/features/agents/conversations/conversation-presentation'
import { availableChatTools } from '../components/features/channels/tool-rail/chat-tools'
import { ChannelOverlays } from './channels/ChannelOverlays'
import { ChannelConversationSurface } from './channels/ChannelConversationSurface'
import { useChannelCall } from './channels/useChannelCall'
import { useChannelTab } from './channels/useChannelTab'
import { useChannelTitleFavorite } from './channels/useChannelTitleFavorite'
import { useChannelParticipants } from './channels/useChannelParticipants'
import { useChannelChatTools } from './channels/useChannelChatTools'
import { useChannelMessageSurface } from './channels/useChannelMessageSurface'

export const ChannelsPage = () => {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const redirect = useRedirect()
  const phoneLayout = usePhoneLayout()
  const { channelId, dashboardId, threadId, toolId } = useParams()
  const { me, token } = useAuthSession()
  const { onSelectAgent } = useShellActions()
  const { data: channels = [], isPending: channelsPending } = useChannels()
  // Not `useAgents()`: a global agent is placeable in an ordinary channel, and
  // `GET /api/agents` omits every system-managed row — so the members popup,
  // the roster and the @mention typeahead would each have been blind to one
  // that is standing right there. See `useChannelPlaceableAgents`.
  const { data: agents = [], isPending: agentsPending } = useChannelPlaceableAgents()
  const isOwner = useIsOwner()
  const { data: allUsers = [] } = useUsers(isOwner)

  const isComposeRoute = location.pathname === '/channels/new'
  const composeReturnTo = readChannelComposeReturnTo(location.state)
  const backgroundChannelId = isComposeRoute
    ? parseChannelIdFromPath(composeReturnTo)
    : channelId
  const activeChannel =
    channels.find((channel) => channel.id === backgroundChannelId) ?? channels[0] ?? null
  const isPersonalAssistantActiveChannel = isPersonalAssistantChannel(activeChannel)
  const isExternalAgentActiveChannel = isExternalAgentChannel(activeChannel)
  const isGlobalAgentActiveChannel = isGlobalAgentChannel(activeChannel)
  // Function-first identity + conversation starters for the active external
  // agent, sourced from its plugin manifest (null for any other channel).
  const externalAgentIdentity = useExternalAgentIdentity(activeChannel)
  const { agentMap, boundAgents, channelUsers } = useChannelParticipants(
    activeChannel,
    agents,
    allUsers,
  )
  // The thread on screen. A channel now holds many threads — its General one
  // and a conversation per piece of work with its agent — so every read that
  // means "the thread being looked at" comes from here rather than from the
  // channel record (docs/plans/2026-09-08-agent-conversations.md). The route
  // names it; a bare channel route is the room's General thread.
  const activeThreadId = threadId ?? activeChannel?.defaultThreadId
  const inConversation = Boolean(threadId) && threadId !== activeChannel?.defaultThreadId
  const { data: personalAssistantState, isPending: personalAssistantPending } =
    usePersonalAssistant(isPersonalAssistantActiveChannel)
  // The conversation's own record — its title and the room it lives in — read
  // only when one is open. A General thread is the room and needs no read.
  const conversationQuery = useConversation(inConversation ? threadId : undefined)
  const conversationRecord = conversationQuery.data ?? null
  // The agent this conversation is *with*, resolved from the record's id. The
  // placeable-agent list answers for every ordinary and global agent; the
  // Personal Assistant is absent from it (it is system-managed), so its own
  // facade answers for its DM — the same two sources `conversationAgent` uses.
  const conversationThreadAgent = inConversation && conversationRecord
    ? agentMap.get(conversationRecord.agentId)
      ?? (personalAssistantState?.agent?.id === conversationRecord.agentId
        ? personalAssistantState.agent
        : null)
    : null
  const conversationHeader = inConversation && conversationRecord
    ? {
        eyebrow: conversationRoomEyebrow(conversationRecord.channel),
        title: conversationRecord.title,
      }
    : null
  // Renaming the open conversation. The doorway is a header action and the
  // dialog is a modal over this page, exactly like channel settings — a
  // rename is an edit of the thing on screen, not a place you navigate to.
  const [renameConversationOpen, setRenameConversationOpen] = useState(false)
  // Who may rename, and what pressing it does. The rule itself lives in
  // `rename-conversation.ts` so the header and this page cannot come to
  // disagree about it, and so it can be pinned without a DOM.
  const conversationRename: ConversationRenameDoorway | null =
    inConversation && conversationRecord && activeChannel
      ? {
          conversation: conversationRecord,
          onRename: () => setRenameConversationOpen(true),
          viewerCanManageChannel: activeChannel.viewerCanManage,
          viewerUserId: me?.user.id ?? null,
        }
      : null

  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const [selectedMessageUser, setSelectedMessageUser] = useState<MessageUserIdentity | null>(null)
  const [selectedMessageAgent, setSelectedMessageAgent] = useState<ChannelAgentParticipant | null>(null)

  const isPersonalAssistantConversation = isPersonalAssistantActiveChannel
  const isConversationSurface =
    activeChannel?.type === 'dm' || isPersonalAssistantConversation
  const personalAssistantAgent =
    personalAssistantState?.agent ?? boundAgents[0] ?? null
  const {
    agentTabAvailable,
    agentsTabAvailable,
    conversationAgent,
    triggersTabAvailable,
    setActiveTab,
    todosTabAvailable,
    visibleActiveTab,
  } = useChannelTab({
    activeChannel,
    boundAgents,
    isConversationSurface,
    isOwner,
    isPersonalAssistantConversation,
    // Until these reads land there is no honest answer to "does this
    // conversation have one agent?", and a link straight to ?tab=to-dos must
    // not be rewritten to Messages in that window. The Personal Assistant is
    // absent from GET /api/agents, so its own read counts here too — on its DM
    // it is the *only* source of the conversation's agent.
    participantsSettled:
      !channelsPending
      && !agentsPending
      && !(isPersonalAssistantConversation && personalAssistantPending),
    personalAssistantAgent,
  })
  const {
    chatToolAgents,
    closeTool,
    openTool,
    openToolScreen,
    routeTool,
    selectChatToolAgent,
    selectedAgent,
    toggleTool,
  } = useChannelChatTools({
    activeChannel,
    boundAgents,
    conversationAgent,
    conversationThreadAgent,
    inConversation,
    navigate,
    phoneLayout,
    toolId,
  })
  const titleFavorite = useChannelTitleFavorite({ activeChannel, personalAssistantAgent })
  const personalAssistantChannel =
    personalAssistantState?.channel ?? activeChannel
  const callEligible =
    !isPersonalAssistantConversation && channelUsers.length >= 2
  // In a conversation the message reaches exactly one agent — that is what a
  // conversation is — so the placeholder names it rather than the room.
  const composePlaceholder = inConversation && conversationThreadAgent
    ? `Message ${conversationThreadAgent.name}`
    : isPersonalAssistantConversation
      ? 'Message Personal Assistant'
      : activeChannel?.type === 'dm'
        ? `Message ${activeChannel.label}`
        : `Message #${activeChannel?.label ?? 'channel'} or @mention an agent`

  const {
    activeCall,
    callActionError,
    callActionPending,
    callStarting,
    callerDialogCall,
    onCallButton: onProviderCallButton,
    onCloseCallerDialog,
    onCloseStartCallFailure,
    onFinishCall,
    startCallFailureCode,
  } = useChannelCall({
    activeChannel,
    callEligible,
  })

  // The Personal Assistant DM answers the same call button with a live voice
  // call instead of a provider-linked meeting. The branch is structural — it
  // follows from the channel being that DM — never a reading of its content.
  const voiceCall = usePersonalAssistantCall()
  const voiceCapability = useVoiceCapability()
  // Both must hold: the conversation takes voice calls (structural — it is
  // the assistant's DM) and this deployment is wired to place them.
  const voiceCallSupported =
    isPersonalAssistantConversation && voiceCapability.data?.available === true
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false)
  const onCallButton = () => {
    if (!voiceCallSupported) {
      onProviderCallButton()
      return
    }
    setVoiceDialogOpen(true)
    if (!voiceCall.isActive) void voiceCall.start()
  }

  const messageSurface = useChannelMessageSurface({
    activeChannel,
    activeThreadId,
    agents,
    boundAgents,
    channelId,
    channels,
    channelUsers,
    currentUserId: me?.user.id,
    inConversation,
    isComposeRoute,
    isExternalAgentActiveChannel,
    isGlobalAgentActiveChannel,
    isPersonalAssistantConversation,
    location,
    phoneLayout,
    redirect,
    routeTool,
    searchParams,
    setRenameConversationOpen,
    setSelectedMessageAgent,
    setSelectedMessageUser,
    threadId,
    visibleActiveTab,
  })
  if (!me) {
    return null
  }

  return (
    // The leaving thread panel slides past the right edge, so the row clips
    // for the length of that move — permanently would cut off the composer's
    // own popovers.
    <section
      className={[
        'relative flex h-full min-h-0',
        messageSurface.replyThread.isClosing ? 'overflow-hidden' : '',
      ].join(' ')}
    >
      <ChannelConversationSurface
        activeCall={activeCall}
        activeChannel={activeChannel}
        activeThreadId={activeThreadId ?? null}
        conversation={conversationHeader}
        agentMap={agentMap}
        boundAgents={boundAgents}
        callEligible={callEligible}
        callStarting={callStarting}
        voiceCallActive={voiceCall.isActive}
        voiceCallSupported={voiceCallSupported}
        channelLiveness={messageSurface.channelLiveness}
        channelUsers={channelUsers}
        personalAssistantPresences={activeChannel?.personalAssistantPresences ?? []}
        chatDrop={messageSurface.chatDrop}
        composePlaceholder={composePlaceholder}
        composer={messageSurface.composer}
        agentTabAvailable={agentTabAvailable}
        agentsTabAvailable={agentsTabAvailable}
        chatToolAgents={chatToolAgents}
        conversationAgent={conversationAgent}
        conversationRename={conversationRename}
        deepWaterLauncher={messageSurface.deepWaterLauncher}
        documentSessions={messageSurface.documentSessions}
        documentStore={messageSurface.documentStore}
        executorLauncher={messageSurface.executorLauncher}
        externalAgentIdentity={externalAgentIdentity}
        feedItems={messageSurface.feedItems}
        feedScroll={messageSurface.feedScroll}
        messageHistory={{
          hasOlder: Boolean(messageSurface.hasOlderThreadMessages),
          isLoadingOlder: messageSurface.isLoadingOlderThreadMessages,
          olderLoadFailed: messageSurface.olderThreadMessagesFailed,
          retryOlder: messageSurface.feedScroll.loadOlder,
        }}
        isConversationSurface={isConversationSurface}
        isExternalAgentConversation={isExternalAgentActiveChannel}
        triggersTabAvailable={triggersTabAvailable}
        todosTabAvailable={todosTabAvailable}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        joinPending={messageSurface.joinChannel.isPending}
        mentionEntities={messageSurface.mentionEntities}
        messageActions={messageSurface.messageActions}
        me={me}
        pendingMessages={messageSurface.pendingMessages}
        personalAssistantChannel={personalAssistantChannel}
        personalAssistantState={personalAssistantState}
        renderContent={messageSurface.renderContent}
        replyThread={messageSurface.replyThread}
        search={messageSurface.search}
        shareRestricted={messageSurface.shareRestricted}
        titleFavorite={titleFavorite}
        token={token}
        visibleActiveTab={visibleActiveTab}
        onCallButton={onCallButton}
        onCreateAgent={() => void navigate('/agents/designer')}
        onJoin={() => {
          if (activeChannel) messageSurface.joinChannel.mutate({ channelId: activeChannel.id })
        }}
        onOpenChatTool={openToolScreen}
        onOpenInfo={() => {
          if (activeChannel) void navigate(`/channels/${activeChannel.id}/info`)
        }}
        onOpenMembers={() => setShowMembersPopup(true)}
        onOpenSettings={() => messageSurface.setShowChannelSettings(true)}
        onSelectMessageAgent={setSelectedMessageAgent}
        onSelectMessageUser={setSelectedMessageUser}
        onToggleSearch={messageSurface.search.toggleSearch}
        setActiveTab={setActiveTab}
      />

      <ChannelOverlays
        activeCall={activeCall}
        activeChannel={activeChannel}
        activeThreadId={activeThreadId ?? null}
        agentMap={agentMap}
        agents={agents}
        allUsers={allUsers}
        boundAgents={boundAgents}
        channelUsers={channelUsers}
        callerCallActionError={callActionError}
        callerCallActionPending={callActionPending}
        callerDialogCall={callerDialogCall}
        voiceCall={{
          onClose: () => setVoiceDialogOpen(false),
          onEnd: () => {
            void voiceCall.end().then(() => setVoiceDialogOpen(false))
          },
          onRetry: () => {
            void voiceCall.start()
          },
          onToggleMute: () => voiceCall.setMuted(!voiceCall.state.muted),
          open: voiceDialogOpen,
          state: voiceCall.state,
        }}
        startCallFailureCode={startCallFailureCode}
        personalAssistantPresences={activeChannel?.personalAssistantPresences ?? []}
        deepWaterDialog={messageSurface.deepWaterLauncher.dialog}
        hasRespondingAgent={messageSurface.hasRespondingAgent}
        isExternalAgentConversation={isExternalAgentActiveChannel}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        me={me}
        mentionEntities={messageSurface.mentionEntities}
        oversizePaste={messageSurface.oversizePaste}
        pendingMessages={messageSurface.pendingMessages}
        renameConversation={{
          conversation: conversationRecord,
          onClose: () => setRenameConversationOpen(false),
          open: renameConversationOpen,
        }}
        renderContent={messageSurface.renderContent}
        replyThread={messageSurface.replyThread}
        selectedMessageAgent={selectedMessageAgent}
        selectedMessageUser={selectedMessageUser}
        showChannelSettings={messageSurface.showChannelSettings}
        showMembersPopup={showMembersPopup}
        threadMessages={messageSurface.threadMessages}
        threadMessageHistory={{
          hasOlder: Boolean(messageSurface.hasOlderThreadMessages),
          isLoadingOlder: messageSurface.isLoadingOlderThreadMessages,
          olderLoadFailed: messageSurface.olderThreadMessagesFailed,
          retryOlder: messageSurface.feedScroll.loadOlder,
        }}
        threadMessageLoader={{
          failed: messageSurface.olderThreadMessagesFailed,
          hasMore: Boolean(messageSurface.hasOlderThreadMessages),
          isLoading: messageSurface.isLoadingOlderThreadMessages,
          itemCount: messageSurface.threadMessages.length,
          loadMore: () => messageSurface.fetchOlderThreadMessages({ cancelRefetch: false }),
          pageCount: messageSurface.threadMessagePageCount,
        }}
        threadPendingMessages={messageSurface.threadPendingMessages}
        token={token}
        onCancelOversizePaste={() => messageSurface.setOversizePaste(null)}
        onCloseMembers={() => setShowMembersPopup(false)}
        onCloseSelectedAgent={() => setSelectedMessageAgent(null)}
        onCloseSelectedUser={() => setSelectedMessageUser(null)}
        onCloseSettings={() => messageSurface.setShowChannelSettings(false)}
        onInsertTrimmed={(trimmed) => {
          messageSurface.setOversizePaste(null)
          messageSurface.composer.mentionRef.current?.insertText(trimmed)
        }}
        onCloseCallerDialog={onCloseCallerDialog}
        onCloseStartCallFailure={onCloseStartCallFailure}
        onFinishCall={onFinishCall}
        onOpenAgentActivity={(agentId) => {
          setSelectedMessageAgent(null)
          onSelectAgent(agentId)
        }}
        onSelectAgent={onSelectAgent}
        onSendAsFile={messageSurface.composer.sendAsFile}
      />
      {selectedAgent ? (
        <ChatToolDock
          activeChannelId={activeChannel?.id ?? null}
          activeThreadId={activeThreadId ?? null}
          agents={chatToolAgents}
          onClose={closeTool}
          onSelectAgent={selectChatToolAgent}
          onToggle={toggleTool}
          openTool={openTool}
          otherPanelOpen={Boolean(messageSurface.replyThread.openRootMessageId) || Boolean(dashboardId)}
          routed={routeTool !== null}
          selectedAgent={selectedAgent}
          threadId={messageSurface.browserThreadId ?? null}
        />
      ) : null}
      {activeChannel ? (
        <ConversationInfoFlow
          activeChannel={activeChannel}
          activeThreadId={messageSurface.replyThread.activeThreadId ?? null}
          allUsers={allUsers}
          canAddPeople={activeChannel.viewerCanManage && activeChannel.type !== 'dm'}
          channelUsers={channelUsers}
          agentTools={availableChatTools(chatToolAgents)}
          me={me}
          onOpenTool={openToolScreen}
        />
      ) : null}
      {messageSurface.executorLauncher.dialog}
      <Outlet />
    </section>
  )
}
