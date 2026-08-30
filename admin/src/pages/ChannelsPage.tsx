import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { parseChannelId, parseThreadId } from '@nessie/schemas'
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
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { readChannelComposeReturnTo } from '../lib/channel-compose-navigation'
import { parseChannelIdFromPath } from '../lib/channel-route'
import { usePhoneLayout } from '../lib/mobile-shell'
import { reportPushSurface } from '../lib/push-surface'
import { ConversationInfoFlow } from '../components/features/channels/ConversationInfoFlow'
import {
  buildFeedItems,
  isAgentsTabAvailable,
  type ChannelTab,
  type MessageUserIdentity,
} from '../components/features/channels/channel-helpers'
import { useAgentLivenessHint } from '../components/features/channels/useAgentLivenessHint'
import { useChannelComposer } from '../components/features/channels/useChannelComposer'
import { useChannelMessageActions } from '../components/features/channels/useChannelMessageActions'
import { useShareRestrictedMessage } from '../facades/messages/hooks'
import { ChannelOverlays } from './channels/ChannelOverlays'
import { ChannelConversationSurface } from './channels/ChannelConversationSurface'
import { useChannelCall } from './channels/useChannelCall'
import { useDeepWaterResearchLauncher } from './channels/useDeepWaterResearchLauncher'
import { useExecutorRunLauncher } from './channels/useExecutorRunLauncher'
import { useChannelMentions } from './channels/useChannelMentions'
import { useAlertMessageHighlight, useChannelMessageSearch } from './channels/useChannelMessageSearch'
import { useChannelTitleFavorite } from './channels/useChannelTitleFavorite'
import { useReplyThread } from './channels/useReplyThread'
import { isConversationReadReady } from './channels/thread-read-marker'
import { useThreadReadMarker } from './channels/useThreadReadMarker'

export const ChannelsPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const phoneLayout = usePhoneLayout()
  const { channelId } = useParams()
  const { me, token } = useAuthSession()
  const { onSelectAgent } = useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const isOwner = me?.user.roleIds?.includes('owner') ?? false
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
  const boundAgents = useMemo(
    () =>
      activeChannel
        ? agents.filter((agent) => agent.channelIds.includes(activeChannel.id))
        : [],
    [activeChannel, agents],
  )
  const agentMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const { data: threadMessages = [], isFetched: threadMessagesFetched } =
    useThreadMessages(activeChannel?.defaultThreadId)
  const { data: personalAssistantState } = usePersonalAssistant(isPersonalAssistantActiveChannel)
  const { documentSessions, documentStore, pendingMessages } = useThreadStream(
    activeChannel?.defaultThreadId,
  )

  const channelUsers = useMemo(
    () =>
      activeChannel
        ? allUsers.filter((user) => user.channelIds.includes(activeChannel.id))
        : [],
    [activeChannel, allUsers],
  )

  const [activeTab, setActiveTab] = useState<ChannelTab>('messages')
  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const [selectedMessageUser, setSelectedMessageUser] = useState<MessageUserIdentity | null>(null)
  const [selectedMessageAgentId, setSelectedMessageAgentId] = useState<string | null>(null)

  const isPersonalAssistantConversation = isPersonalAssistantActiveChannel
  const isConversationSurface =
    activeChannel?.type === 'dm' || isPersonalAssistantConversation
  const agentsTabAvailable = isAgentsTabAvailable({
    boundAgentCount: boundAgents.length,
    isConversationSurface,
    isPersonalAssistantConversation,
  })
  const visibleActiveTab =
    (activeTab === 'agents' && !agentsTabAvailable) ||
    (activeTab === 'automations' && isConversationSurface)
      ? 'messages'
      : activeTab

  useEffect(() => {
    const requestedTab = new URLSearchParams(location.search).get('tab')
    if (requestedTab === 'files' || requestedTab === 'messages') {
      setActiveTab(requestedTab)
    }
  }, [location.search])
  const personalAssistantAgent =
    personalAssistantState?.agent ?? boundAgents[0] ?? null
  const titleFavorite = useChannelTitleFavorite({ activeChannel, personalAssistantAgent })
  const selectedMessageAgent =
    selectedMessageAgentId ? agentMap.get(selectedMessageAgentId) ?? null : null
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
    activeParticipants,
    isInCall,
    showCallOverlay,
    onCallButton,
    onBannerJoin,
    onOverlayLeave,
  } = useChannelCall({
    activeChannel,
    currentUserId: me?.user.id,
    callEligible,
  })

  const { mentionEntities, renderContent } = useChannelMentions({
    activeChannel,
    agents,
    channels,
    channelUsers,
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

  // Presence is the channel feed or one exact reply conversation. The Files,
  // Info, and Runs tabs deliberately clear it: a reply there still needs an
  // in-app and native banner because the user is not reading the conversation.
  useEffect(() => {
    if (visibleActiveTab !== 'messages' || !activeChannel || !replyThread.activeThreadId) {
      reportPushSurface(null, location)
      return undefined
    }
    reportPushSurface({
      channelId: parseChannelId(activeChannel.id),
      kind: 'channel',
      rootMessageId: replyThread.openRootMessageId,
      threadId: parseThreadId(replyThread.activeThreadId),
    }, location)
    return () => reportPushSurface(null, location)
  }, [activeChannel, location, replyThread.activeThreadId, replyThread.openRootMessageId, visibleActiveTab])

  const {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending,
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
  } = useChannelComposer({
    activeChannel,
    threadMessages,
    currentUserId: me?.user.id,
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
    if (activeTab === 'agents' && !agentsTabAvailable) {
      setActiveTab('messages')
    }
  }, [activeTab, agentsTabAvailable])

  useEffect(() => {
    cancelEdit()
    closeSearch()
    setShowChannelSettings(false)
    setSelectedMessageUser(null)
    setSelectedMessageAgentId(null)
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
      void navigate(`/channels/${activeChannel.id}`, { replace: true })
    }
  }, [activeChannel, channelId, isComposeRoute, navigate, phoneLayout])

  // Structural only: is there an agent here at all? Whether one engages is the
  // orchestrator's model-judged call. The Personal Assistant and external-agent
  // DMs own their channel without appearing in `boundAgents`.
  const hasRespondingAgent =
    boundAgents.length > 0 || isPersonalAssistantActiveChannel || isExternalAgentActiveChannel
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
        activeParticipants={activeParticipants}
        agentMap={agentMap}
        boundAgents={boundAgents}
        callEligible={callEligible}
        channelLiveness={channelLiveness}
        channelUsers={channelUsers}
        chatDrop={chatDrop}
        composePlaceholder={composePlaceholder}
        composer={{
          attachments,
          dismissPendingAgent,
          insertEmoji,
          inviteErrors,
          invitePendingAgent,
          invitingAgentId,
          isSendPending,
          mentionRef,
          message,
          optimisticMessages,
          pendingAgentInvites,
          sendMessageSubmit,
          sendText,
          setMessage,
          setOversizePaste,
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
        isInCall={isInCall}
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
        onBannerJoin={onBannerJoin}
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
        onSelectMessageAgent={(agent) => setSelectedMessageAgentId(agent.id)}
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
        deepWaterDialog={deepWaterLauncher.dialog}
        hasRespondingAgent={hasRespondingAgent}
        isExternalAgentConversation={isExternalAgentActiveChannel}
        isInCall={isInCall}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        me={me}
        mentionEntities={mentionEntities}
        oversizePaste={oversizePaste}
        pendingMessages={pendingMessages}
        renderContent={renderContent}
        replyThread={replyThread}
        selectedMessageAgent={selectedMessageAgent}
        selectedMessageUser={selectedMessageUser}
        showCallOverlay={showCallOverlay}
        showChannelSettings={showChannelSettings}
        showMembersPopup={showMembersPopup}
        threadMessages={threadMessages}
        threadPendingMessages={threadPendingMessages}
        token={token}
        onCancelOversizePaste={() => setOversizePaste(null)}
        onCloseMembers={() => setShowMembersPopup(false)}
        onCloseSelectedAgent={() => setSelectedMessageAgentId(null)}
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
        onLeaveCall={onOverlayLeave}
        onOpenAgentActivity={(agentId) => {
          setSelectedMessageAgentId(null)
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
