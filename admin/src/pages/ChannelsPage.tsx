import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useChannels, useJoinChannel } from '../facades/channels/hooks'
import {
  useExternalAgentIdentity,
  useSyncExternalAgentChannel,
} from '../facades/integrations/hooks'
import {
  isExternalAgentChannel,
  isPersonalAssistantChannel,
  usePersonalAssistant,
} from '../facades/personal-assistant/hooks'
import { useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { useTools } from '../facades/tools/hooks'
import { useUsers } from '../facades/users/hooks'
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { CallBanner } from '../components/shared/CallBanner'
import { CallOverlay } from '../components/shared/CallOverlay'
import { ChannelMembersPopup } from '../components/shared/ChannelMembersPopup'
import { ChannelSettingsDialog } from '../components/shared/ChannelSettingsDialog'
import { ChannelComposer } from '../components/features/channels/ChannelComposer'
import { ChannelHeader } from '../components/features/channels/ChannelHeader'
import { ChannelMessageFeed } from '../components/features/channels/ChannelMessageFeed'
import { ExternalAgentIntro } from '../components/features/channels/ExternalAgentIntro'
import { ThreadReplyPanel } from '../components/features/channels/thread-panel/ThreadReplyPanel'
import { ChannelSearchPanel } from '../components/features/channels/ChannelSearchPanel'
import { ChannelTabBar } from '../components/features/channels/ChannelTabBar'
import { ChannelTabPanels } from '../components/features/channels/ChannelTabPanels'
import { buildFeedItems, isOperationsTab, type ChannelTab, type MessageUserIdentity } from '../components/features/channels/channel-helpers'
import { useChannelComposer } from '../components/features/channels/useChannelComposer'
import { useChannelMessageActions } from '../components/features/channels/useChannelMessageActions'
import { ChannelInfoDrawers } from './channels/ChannelInfoDrawers'
import { useChannelCall } from './channels/useChannelCall'
import { useChannelMentions } from './channels/useChannelMentions'
import { useAlertMessageHighlight, useChannelMessageSearch } from './channels/useChannelMessageSearch'
import { useChannelTitleFavorite } from './channels/useChannelTitleFavorite'
import { useReplyThread } from './channels/useReplyThread'
import { useThreadReadMarker } from './channels/useThreadReadMarker'

export const ChannelsPage = () => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const { me, token } = useAuthSession()
  const { onSelectAgent, scopedAgents } = useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()
  const isOwner = me?.user.roleIds?.includes('owner') ?? false
  const { data: allUsers = [] } = useUsers(isOwner)

  const activeChannel =
    channels.find((channel) => channel.id === channelId) ?? channels[0] ?? null
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
  const { pendingMessages } = useThreadStream(activeChannel?.defaultThreadId)
  useThreadReadMarker(activeChannel?.defaultThreadId, threadMessages)

  const channelUsers = useMemo(
    () =>
      activeChannel
        ? allUsers.filter((user) => user.channelIds.includes(activeChannel.id))
        : [],
    [activeChannel, allUsers],
  )

  const [activeTab, setActiveTab] = useState<ChannelTab>('messages')
  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const [selectedMessageUser, setSelectedMessageUser] =
    useState<MessageUserIdentity | null>(null)
  const [selectedMessageAgentId, setSelectedMessageAgentId] = useState<string | null>(null)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)

  const isPersonalAssistantConversation = isPersonalAssistantActiveChannel
  const isConversationSurface =
    activeChannel?.type === 'dm' || isPersonalAssistantConversation
  const visibleActiveTab =
    isConversationSurface && isOperationsTab(activeTab) ? 'messages' : activeTab
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
  // follow mutation, and the persisted drag-resizable width.
  const replyThread = useReplyThread({ activeChannel, agents, channelUsers })

  const {
    message,
    setMessage,
    optimisticMessages,
    oversizePaste,
    setOversizePaste,
    mentionRef,
    isSendPending,
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

  // sp-messaging: inline edit + channel message search.
  const {
    addReaction,
    cancelEdit,
    changeEditingContent,
    confirmDelete,
    editingContent,
    editingMessageId,
    startEdit,
    submitEdit,
    updatePending,
  } = useChannelMessageActions(activeChannel?.defaultThreadId)
  const {
    closeSearch,
    jumpToMessage,
    searchOpen,
    searchQuery,
    searchResults,
    setSearchQuery,
    toggleSearch,
  } = useChannelMessageSearch(activeChannel?.id)
  useAlertMessageHighlight(threadMessagesFetched, jumpToMessage)
  // sp-channels: channel settings dialog + join.
  const [showChannelSettings, setShowChannelSettings] = useState(false)
  const joinChannel = useJoinChannel()

  useEffect(() => {
    if (isConversationSurface && isOperationsTab(activeTab)) {
      setActiveTab('messages')
    }
  }, [activeTab, isConversationSurface])

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
    if (!channelId && activeChannel) {
      void navigate(`/channels/${activeChannel.id}`, { replace: true })
    }
  }, [activeChannel, channelId, navigate])

  const feedItems = useMemo(() => buildFeedItems(threadMessages), [threadMessages])

  useLayoutEffect(() => {
    const container = contentScrollRef.current
    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  }, [
    activeChannel?.id,
    visibleActiveTab,
    feedItems.length,
    optimisticMessages.length,
    pendingMessages.length,
    scopedAgents.length,
  ])

  if (!me) {
    return null
  }

  return (
    <section className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader
        activeChannel={activeChannel}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        isExternalAgentConversation={isExternalAgentActiveChannel}
        externalAgentIdentity={externalAgentIdentity}
        channelUsers={channelUsers}
        boundAgents={boundAgents}
        callEligible={callEligible}
        activeCall={Boolean(activeCall)}
        isInCall={isInCall}
        searchOpen={searchOpen}
        joinPending={joinChannel.isPending}
        titleFavorite={titleFavorite}
        onOpenMembers={() => setShowMembersPopup(true)}
        onCallButton={onCallButton}
        onOpenSettings={() => setShowChannelSettings(true)}
        onJoin={() => {
          if (activeChannel) {
            joinChannel.mutate({ channelId: activeChannel.id })
          }
        }}
        onToggleSearch={toggleSearch}
      />

      {searchOpen ? (
        <ChannelSearchPanel
          onChangeQuery={setSearchQuery}
          onClose={closeSearch}
          onSelectResult={(messageId) => {
            jumpToMessage(messageId)
            closeSearch()
          }}
          searchQuery={searchQuery}
          searchResults={searchResults}
        />
      ) : null}

      {activeCall && !isInCall && callEligible && activeParticipants.length > 0 && (
        <CallBanner participants={activeParticipants} onJoin={onBannerJoin} />
      )}

      <ChannelTabBar
        visibleActiveTab={visibleActiveTab}
        isConversationSurface={isConversationSurface}
        onSelectTab={setActiveTab}
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="channel-content-scroll"
        ref={contentScrollRef}
      >
        {visibleActiveTab === 'messages' ? (
          <ChannelMessageFeed
            feedItems={feedItems}
            optimisticMessages={optimisticMessages}
            pendingMessages={pendingMessages}
            agentMap={agentMap}
            agentById={agentMap}
            meDisplayName={me.user.displayName}
            meUserId={me.user.id}
            meAvatar={{
              avatarUrl: me.user.avatarUrl,
              avatarAttachmentId: me.user.avatarAttachmentId,
              gravatarUrl: me.user.gravatarUrl,
            }}
            channelUsers={channelUsers}
            token={token}
            isPersonalAssistantConversation={isPersonalAssistantConversation}
            isExternalAgentConversation={isExternalAgentActiveChannel}
            externalAgentDisplayName={activeChannel?.label}
            emptyState={
              isExternalAgentActiveChannel && externalAgentIdentity ? (
                <ExternalAgentIntro
                  identity={externalAgentIdentity}
                  onSelectStarter={(prompt) => void sendText(prompt)}
                />
              ) : undefined
            }
            renderContent={renderContent}
            editingMessageId={editingMessageId}
            editingContent={editingContent}
            updatePending={updatePending}
            onStartEdit={startEdit}
            onChangeEditingContent={changeEditingContent}
            onSubmitEdit={(messageId) => void submitEdit(messageId)}
            onCancelEdit={cancelEdit}
            onAddReaction={addReaction}
            onConfirmDelete={confirmDelete}
            onOpenThread={replyThread.openThread}
            resolveThreadParticipant={replyThread.resolveThreadParticipant}
            onSelectAgent={
              isPersonalAssistantConversation
                ? undefined
                : (agent) => setSelectedMessageAgentId(agent.id)
            }
            onSelectUser={
              activeChannel?.type === 'dm' ? undefined : setSelectedMessageUser
            }
          />
        ) : null}

        <ChannelTabPanels
          visibleActiveTab={visibleActiveTab}
          isConversationSurface={isConversationSurface}
          isPersonalAssistantConversation={isPersonalAssistantConversation}
          activeChannel={activeChannel}
          boundAgents={boundAgents}
          scopedAgents={scopedAgents}
          toolsCount={tools.length}
          pendingMessagesCount={pendingMessages.length}
          personalAssistantAgent={personalAssistantAgent}
          personalAssistantChannel={personalAssistantChannel}
          personalAssistantState={personalAssistantState}
          onSelectAgent={onSelectAgent}
          onCreateAgent={() => void navigate('/agents/designer')}
        />
      </div>

      <ChannelComposer
        mentionRef={mentionRef}
        mentionEntities={mentionEntities}
        placeholder={composePlaceholder}
        message={message}
        isSendPending={isSendPending}
        onChangeMessage={setMessage}
        onOversizePaste={(paste) => setOversizePaste(paste)}
        onSubmitText={(text) => void sendText(text)}
        onSubmitForm={(event) => void sendMessageSubmit(event)}
        onInsertHashSign={() => mentionRef.current?.insertHashSign()}
        onInsertAtSign={() => mentionRef.current?.insertAtSign()}
        pendingAgentInvites={pendingAgentInvites}
        invitingAgentId={invitingAgentId}
        inviteErrors={inviteErrors}
        onInvitePendingAgent={(agentId) => void invitePendingAgent(agentId)}
        onDismissPendingAgent={dismissPendingAgent}
      />
      </div>

      {replyThread.openRootMessageId && activeChannel ? (
        <ThreadReplyPanel
          activeChannel={activeChannel}
          agentMap={agentMap}
          channelUsers={channelUsers}
          meAvatar={{
            avatarUrl: me.user.avatarUrl,
            avatarAttachmentId: me.user.avatarAttachmentId,
            gravatarUrl: me.user.gravatarUrl,
          }}
          meDisplayName={me.user.displayName}
          meUserId={me.user.id}
          mentionEntities={mentionEntities}
          renderContent={renderContent}
          thread={replyThread}
          token={token}
        />
      ) : null}

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
          onClose={() => setShowMembersPopup(false)}
          onGroupCreated={(newChannelId) => {
            setShowMembersPopup(false)
            navigate(`/channels/${newChannelId}`)
          }}
          onSelectAgent={onSelectAgent}
        />
      ) : null}

      {activeChannel ? (
        <ChannelSettingsDialog
          channel={activeChannel}
          onClose={() => setShowChannelSettings(false)}
          open={showChannelSettings}
        />
      ) : null}

      <OversizePasteDialog
        limit={CHAT_MESSAGE_MAX_CHARS}
        onCancel={() => setOversizePaste(null)}
        onInsertTrimmed={(trimmed) => {
          setOversizePaste(null)
          mentionRef.current?.insertText(trimmed)
        }}
        onSendAsFile={(text) => sendAsFile(text)}
        open={oversizePaste !== null}
        pastedText={oversizePaste ?? ''}
      />

      {showCallOverlay && activeCall && isInCall && (
        <CallOverlay
          displayName={me?.user.displayName ?? 'User'}
          onLeave={onOverlayLeave}
          roomId={activeCall.roomId}
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
        onCloseAgent={() => setSelectedMessageAgentId(null)}
        onCloseUser={() => setSelectedMessageUser(null)}
        onOpenActivity={(agentId) => {
          setSelectedMessageAgentId(null)
          onSelectAgent(agentId)
        }}
      />
    </section>
  )
}
