import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useRedirect } from '../navigation/redirect'
import { useAgents } from '../facades/agents/hooks'
import { useChannels, useJoinChannel } from '../facades/channels/hooks'
import { useExternalAgentIdentity, useSyncExternalAgentChannel } from '../facades/integrations/hooks'
import {
  isExternalAgentChannel,
  isPersonalAssistantChannel,
  usePersonalAssistant,
} from '../facades/personal-assistant/hooks'
import { useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { selectPendingForRoot } from '../facades/threads/thinking'
import { useUsers } from '../facades/users/hooks'
import { useFileDrop } from '../hooks/useFileDrop'
import { useStickToBottom } from '../hooks/useStickToBottom'
import { useShellActions } from '../layouts/admin-shell/ShellActionsContext'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { readChannelComposeReturnTo } from '../lib/channel-compose-navigation'
import { parseChannelIdFromPath } from '../lib/channel-route'
import { usePhoneLayout } from '../lib/mobile-shell'
import { useIsOwner } from '../components/shared/OwnerGate'
import { ConversationInfoFlow } from '../components/features/channels/ConversationInfoFlow'
import {
  buildFeedItems,
  type ChannelAgentParticipant,
  type MessageUserIdentity,
} from '../components/features/channels/channel-helpers'
import { useAgentLivenessHint } from '../components/features/channels/useAgentLivenessHint'
import { channelComposerDraftKey } from '../components/features/channels/composer-draft'
import { useChannelComposer } from '../components/features/channels/useChannelComposer'
import { useChannelMessageActions } from '../components/features/channels/useChannelMessageActions'
import { useShareRestrictedMessage } from '../facades/messages/hooks'
import { ChannelOverlays } from './channels/ChannelOverlays'
import { ChannelConversationSurface } from './channels/ChannelConversationSurface'
import { useChannelCall } from './channels/useChannelCall'
import { useChannelTab } from './channels/useChannelTab'
import { useDeepWaterResearchLauncher } from './channels/useDeepWaterResearchLauncher'
import { useExecutorRunLauncher } from './channels/useExecutorRunLauncher'
import { useChannelMentions } from './channels/useChannelMentions'
import { useAlertMessageHighlight, useChannelMessageSearch } from './channels/useChannelMessageSearch'
import { useChannelTitleFavorite } from './channels/useChannelTitleFavorite'
import { useReplyThread } from './channels/useReplyThread'
import { isConversationReadReady } from './channels/thread-read-marker'
import { useThreadReadMarker } from './channels/useThreadReadMarker'
import { useReportChannelPushSurface } from './channels/useReportChannelPushSurface'
import { useChannelParticipants } from './channels/useChannelParticipants'

export const ChannelsPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const redirect = useRedirect()
  const phoneLayout = usePhoneLayout()
  const { channelId } = useParams()
  const { me, token } = useAuthSession()
  const { onSelectAgent } = useShellActions()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
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
  // Function-first identity + conversation starters for the active external
  // agent, sourced from its plugin manifest (null for any other channel).
  const externalAgentIdentity = useExternalAgentIdentity(activeChannel)
  const { agentMap, boundAgents, channelUsers } = useChannelParticipants(
    activeChannel,
    agents,
    allUsers,
  )
  const {
    data: threadMessages = [],
    isFetched: threadMessagesFetched,
    isPlaceholderData: threadMessagesArePlaceholder,
  } = useThreadMessages(activeChannel?.defaultThreadId)
  const { data: personalAssistantState } = usePersonalAssistant(isPersonalAssistantActiveChannel)
  const { documentSessions, documentStore, pendingMessages } = useThreadStream(
    activeChannel?.defaultThreadId,
  )

  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const [selectedMessageUser, setSelectedMessageUser] = useState<MessageUserIdentity | null>(null)
  const [selectedMessageAgent, setSelectedMessageAgent] = useState<ChannelAgentParticipant | null>(null)

  const isPersonalAssistantConversation = isPersonalAssistantActiveChannel
  const isConversationSurface =
    activeChannel?.type === 'dm' || isPersonalAssistantConversation
  const { agentsTabAvailable, setActiveTab, visibleActiveTab } = useChannelTab({
    activeChannel,
    boundAgentCount: boundAgents.length,
    isConversationSurface,
    isPersonalAssistantConversation,
  })

  const personalAssistantAgent =
    personalAssistantState?.agent ?? boundAgents[0] ?? null
  const titleFavorite = useChannelTitleFavorite({ activeChannel, personalAssistantAgent })
  const personalAssistantChannel =
    personalAssistantState?.channel ?? activeChannel
  const callEligible =
    !isPersonalAssistantConversation && channelUsers.length >= 2
  const composePlaceholder = isPersonalAssistantConversation
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
    onCallButton,
    onCloseCallerDialog,
    onCloseStartCallFailure,
    onFinishCall,
    startCallFailureCode,
  } = useChannelCall({
    activeChannel,
    callEligible,
  })

  const { mentionEntities, renderContent } = useChannelMentions({
    activeChannel,
    agents,
    channels,
    channelUsers,
    personalAssistantPresences: activeChannel?.personalAssistantPresences,
  })

  // Reply-thread panel (#233): URL-driven open state, replies/root queries,
  // and the persisted drag-resizable width.
  const replyThread = useReplyThread({ activeChannel, agents, channelUsers })
  const visibleConversationMessages = useMemo(() => {
    if (!replyThread.openRootMessageId) return threadMessages
    const root = replyThread.rootQuery.data?.message
    return root ? [root, ...(replyThread.repliesQuery.data ?? [])] : []
  }, [replyThread.openRootMessageId, replyThread.repliesQuery.data, replyThread.rootQuery.data, threadMessages])
  const conversationReadReady = isConversationReadReady({
    isReplyConversation: Boolean(replyThread.openRootMessageId),
    messagesArePlaceholder: replyThread.openRootMessageId
      ? replyThread.repliesQuery.isPlaceholderData || replyThread.rootQuery.isPlaceholderData
      : threadMessagesArePlaceholder,
    repliesLoaded: replyThread.repliesQuery.isSuccess,
    rootLoaded: replyThread.rootQuery.isSuccess,
  })
  // Loading a channel's Files, Info, or Runs data must not acknowledge its
  // messages. A reply panel acknowledges only its exact, rendered conversation.
  useThreadReadMarker(
    replyThread.activeThreadId,
    visibleConversationMessages,
    visibleActiveTab === 'messages' && conversationReadReady,
    replyThread.openRootMessageId ?? undefined,
  )

  // Presence is the rendered conversation only. Files, Info, and Runs leave
  // the push surface clear so a reply still raises an in-app/native banner.
  useReportChannelPushSurface({
    activeChannel,
    activeThreadId: replyThread.activeThreadId,
    location,
    openRootMessageId: replyThread.openRootMessageId,
    visibleActiveTab,
  })

  const {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending,
    sendError,
    attachments,
    insertEmoji,
    sendText,
    sendMessageSubmit,
    sendAsFile,
    pendingAgentInvites,
    invitingAgentId,
    inviteErrors,
    invitePendingAgent,
    dismissPendingAgent,
    secretCapture,
    dismissSecretCapture,
  } = useChannelComposer({
    activeChannel,
    threadMessages,
    currentUserId: me?.user.id,
    draftKey: channelComposerDraftKey(activeChannel?.id),
  })
  // Dropping files anywhere over the conversation column stages them in the
  // composer. The reply panel is a sibling with its own zone, so the two never
  // both fire for one drop.
  const chatDrop = useFileDrop(attachments.addFiles)
  const deepWaterLauncher = useDeepWaterResearchLauncher(message)

  // sp-messaging: inline edit + channel message search.
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
  } = useChannelMessageActions(activeChannel?.defaultThreadId)
  // Answering the acknowledgement card on a reply that used restricted sources.
  const shareRestricted = useShareRestrictedMessage(activeChannel?.defaultThreadId)
  const {
    closeSearch,
    jumpToMessage,
    searchOpen,
    searchQuery,
    searchResults,
    setSearchQuery,
    toggleSearch,
  } = useChannelMessageSearch(activeChannel?.id)
  // The feed opens on its newest message and stays there while rows settle
  // (media decoding, streaming replies, growing thinking bubbles), so nothing
  // is left hiding behind the composer.
  const feedScroll = useStickToBottom(`${activeChannel?.id ?? ''}:${visibleActiveTab}`)
  const releaseFeedPin = feedScroll.releasePin
  // Jumping to an older message is the reader taking over: stop following the
  // bottom, or the next row that settles would yank them back down.
  const jumpToFeedMessage = useCallback(
    (messageId: string) => {
      releaseFeedPin()
      jumpToMessage(messageId)
    },
    [jumpToMessage, releaseFeedPin],
  )
  useAlertMessageHighlight(threadMessagesFetched, jumpToFeedMessage)
  // sp-channels: channel settings dialog + join.
  const [showChannelSettings, setShowChannelSettings] = useState(false)
  const joinChannel = useJoinChannel()

  useEffect(() => {
    cancelEdit()
    closeSearch()
    setShowChannelSettings(false)
    setSelectedMessageUser(null)
    setSelectedMessageAgent(null)
  }, [activeChannel?.id, cancelEdit, closeSearch])

  // History hydration (DeepSignal §6): when an external-agent channel is opened,
  // pull any turns the user made on the product's own surfaces into the channel.
  // Idempotent server-side, so firing once per open is safe.
  const syncExternalAgentChannel = useSyncExternalAgentChannel()
  const syncExternalAgentMutate = syncExternalAgentChannel.mutate
  const activeChannelId = activeChannel?.id
  const activeChannelThreadId = activeChannel?.defaultThreadId
  useEffect(() => {
    if (isExternalAgentActiveChannel && activeChannelId) {
      syncExternalAgentMutate({
        channelId: activeChannelId,
        threadId: activeChannelThreadId ?? undefined,
      })
    }
  }, [
    activeChannelId,
    activeChannelThreadId,
    isExternalAgentActiveChannel,
    syncExternalAgentMutate,
  ])

  useEffect(() => {
    // A phone tab starts on its contextual list. Desktop and tablet retain the
    // existing convenience of opening the first conversation in the detail
    // pane because that list remains visible alongside it.
    if (!phoneLayout && !isComposeRoute && !channelId && activeChannel) {
      redirect(`/channels/${activeChannel.id}`)
    }
  }, [activeChannel, channelId, isComposeRoute, phoneLayout, redirect])

  // Structural only: is there an agent here at all? Whether one engages is the
  // orchestrator's model-judged call. The Personal Assistant and external-agent
  // DMs own their channel without appearing in `boundAgents`.
  const hasRespondingAgent =
    boundAgents.length > 0
    || (activeChannel?.personalAssistantPresences?.length ?? 0) > 0
    || isPersonalAssistantActiveChannel
    || isExternalAgentActiveChannel
  // Ambient liveness for the channel surface. `pendingMessages` is the full set
  // this feed renders bubbles for — top-level runs at the bottom, thread-anchored
  // ones compactly under their root — so a bubble anywhere in the feed hides the
  // hint rather than stacking with it.
  const channelLiveness = useAgentLivenessHint({
    hasRespondingAgent,
    meUserId: me?.user.id ?? '',
    messages: threadMessages,
    pendingMessages,
    surfaceKey: activeChannel?.defaultThreadId,
  })
  const markChannelSent = channelLiveness.markSent
  const executorLauncher = useExecutorRunLauncher({
    agents: !isPersonalAssistantConversation && !isExternalAgentActiveChannel ? boundAgents : [],
    message,
    onLaunched: () => {
      setMessage('')
      feedScroll.pinToBottom()
      markChannelSent()
    },
    projectId: activeChannel?.projectId,
    threadId: activeChannel?.defaultThreadId,
  })

  const feedItems = useMemo(() => buildFeedItems(threadMessages), [threadMessages])
  // Runs replying into the open reply thread render their bubble (and streaming
  // text) inside the panel, not at the bottom of the channel.
  const threadPendingMessages = useMemo(
    () => selectPendingForRoot(pendingMessages, replyThread.openRootMessageId),
    [pendingMessages, replyThread.openRootMessageId],
  )

  if (!me) {
    return null
  }

  return (
    <section className="relative flex h-full min-h-0">
      <ChannelConversationSurface
        activeCall={activeCall}
        activeChannel={activeChannel}
        agentMap={agentMap}
        boundAgents={boundAgents}
        callEligible={callEligible}
        callStarting={callStarting}
        channelLiveness={channelLiveness}
        channelUsers={channelUsers}
        personalAssistantPresences={activeChannel?.personalAssistantPresences ?? []}
        chatDrop={chatDrop}
        composePlaceholder={composePlaceholder}
        composer={{
          attachments,
          dismissPendingAgent,
          dismissSecretCapture,
          insertEmoji,
          inviteErrors,
          invitePendingAgent,
          invitingAgentId,
          isSendPending,
          sendError,
          mentionRef,
          message,
          optimisticMessages,
          pendingAgentInvites,
          sendMessageSubmit,
          sendText,
          setMessage,
          setOversizePaste,
          secretCapture,
        }}
        agentsTabAvailable={agentsTabAvailable}
        deepWaterLauncher={deepWaterLauncher}
        documentSessions={documentSessions}
        documentStore={documentStore}
        executorLauncher={executorLauncher}
        externalAgentIdentity={externalAgentIdentity}
        feedItems={feedItems}
        feedScroll={feedScroll}
        isConversationSurface={isConversationSurface}
        isExternalAgentConversation={isExternalAgentActiveChannel}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        joinPending={joinChannel.isPending}
        mentionEntities={mentionEntities}
        messageActions={{
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
        }}
        me={me}
        pendingMessages={pendingMessages}
        personalAssistantAgent={personalAssistantAgent}
        personalAssistantChannel={personalAssistantChannel}
        personalAssistantState={personalAssistantState}
        renderContent={renderContent}
        replyThread={replyThread}
        search={{
          closeSearch,
          jumpToMessage,
          searchOpen,
          searchQuery,
          searchResults,
          setSearchQuery,
          toggleSearch,
        }}
        shareRestricted={shareRestricted}
        titleFavorite={titleFavorite}
        token={token}
        visibleActiveTab={visibleActiveTab}
        onCallButton={onCallButton}
        onCreateAgent={() => void navigate('/agents/designer')}
        onJoin={() => {
          if (activeChannel) joinChannel.mutate({ channelId: activeChannel.id })
        }}
        onOpenInfo={() => {
          if (activeChannel) void navigate(`/channels/${activeChannel.id}/info`)
        }}
        onOpenMembers={() => setShowMembersPopup(true)}
        onOpenSettings={() => setShowChannelSettings(true)}
        onSelectAgent={onSelectAgent}
        onSelectMessageAgent={setSelectedMessageAgent}
        onSelectMessageUser={setSelectedMessageUser}
        onToggleSearch={toggleSearch}
        setActiveTab={setActiveTab}
      />

      <ChannelOverlays
        activeCall={activeCall}
        activeChannel={activeChannel}
        agentMap={agentMap}
        agents={agents}
        allUsers={allUsers}
        boundAgents={boundAgents}
        channelUsers={channelUsers}
        callerCallActionError={callActionError}
        callerCallActionPending={callActionPending}
        callerDialogCall={callerDialogCall}
        startCallFailureCode={startCallFailureCode}
        personalAssistantPresences={activeChannel?.personalAssistantPresences ?? []}
        deepWaterDialog={deepWaterLauncher.dialog}
        hasRespondingAgent={hasRespondingAgent}
        isExternalAgentConversation={isExternalAgentActiveChannel}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        me={me}
        mentionEntities={mentionEntities}
        oversizePaste={oversizePaste}
        pendingMessages={pendingMessages}
        renderContent={renderContent}
        replyThread={replyThread}
        selectedMessageAgent={selectedMessageAgent}
        selectedMessageUser={selectedMessageUser}
        showChannelSettings={showChannelSettings}
        showMembersPopup={showMembersPopup}
        threadMessages={threadMessages}
        threadPendingMessages={threadPendingMessages}
        token={token}
        onCancelOversizePaste={() => setOversizePaste(null)}
        onCloseMembers={() => setShowMembersPopup(false)}
        onCloseSelectedAgent={() => setSelectedMessageAgent(null)}
        onCloseSelectedUser={() => setSelectedMessageUser(null)}
        onCloseSettings={() => setShowChannelSettings(false)}
        onGroupCreated={(newChannelId) => {
          setShowMembersPopup(false)
          navigate(`/channels/${newChannelId}`)
        }}
        onInsertTrimmed={(trimmed) => {
          setOversizePaste(null)
          mentionRef.current?.insertText(trimmed)
        }}
        onCloseCallerDialog={onCloseCallerDialog}
        onCloseStartCallFailure={onCloseStartCallFailure}
        onFinishCall={onFinishCall}
        onOpenAgentActivity={(agentId) => {
          setSelectedMessageAgent(null)
          onSelectAgent(agentId)
        }}
        onSelectAgent={onSelectAgent}
        onSendAsFile={sendAsFile}
      />
      {activeChannel ? (
        <ConversationInfoFlow
          activeChannel={activeChannel}
          allUsers={allUsers}
          canAddPeople={isOwner && activeChannel.type !== 'dm'}
          channelUsers={channelUsers}
          me={me}
          onGroupCreated={(newChannelId) => void navigate(`/channels/${newChannelId}`)}
        />
      ) : null}
      {executorLauncher.dialog}
      <Outlet />
    </section>
  )
}
