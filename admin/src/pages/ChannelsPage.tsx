import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { isPersonalAssistantChannel, usePersonalAssistant } from '../facades/personal-assistant/hooks'
import { useMarkThreadRead, useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { useTools } from '../facades/tools/hooks'
import { useUsers } from '../facades/users/hooks'
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { CallBanner } from '../components/shared/CallBanner'
import { CallOverlay } from '../components/shared/CallOverlay'
import { ChannelMembersPopup } from '../components/shared/ChannelMembersPopup'
import { ChannelComposer } from '../components/features/channels/ChannelComposer'
import { ChannelHeader } from '../components/features/channels/ChannelHeader'
import { ChannelMessageFeed } from '../components/features/channels/ChannelMessageFeed'
import { ChannelTabBar } from '../components/features/channels/ChannelTabBar'
import { ChannelTabPanels } from '../components/features/channels/ChannelTabPanels'
import { buildFeedItems, isOperationsTab, type ChannelTab } from '../components/features/channels/channel-helpers'
import { useChannelCall } from './channels/useChannelCall'
import { useChannelComposer } from './channels/useChannelComposer'
import { useChannelMentions } from './channels/useChannelMentions'

export const ChannelsPage = () => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const { me } = useAuthSession()
  const { onSelectAgent, scopedAgents } = useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()
  const isOwner = me?.user.roleIds?.includes('owner') ?? false
  const { data: allUsers = [] } = useUsers(isOwner)

  const activeChannel =
    channels.find((channel) => channel.id === channelId) ?? channels[0] ?? null
  const isPersonalAssistantActiveChannel = isPersonalAssistantChannel(activeChannel)
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
  const { data: threadMessages = [] } = useThreadMessages(activeChannel?.defaultThreadId)
  const { data: personalAssistantState } = usePersonalAssistant(isPersonalAssistantActiveChannel)
  const markThreadRead = useMarkThreadRead()
  const { pendingMessages } = useThreadStream(activeChannel?.defaultThreadId)

  const channelUsers = useMemo(
    () =>
      activeChannel
        ? allUsers.filter((user) => user.channelIds.includes(activeChannel.id))
        : [],
    [activeChannel, allUsers],
  )

  const [activeTab, setActiveTab] = useState<ChannelTab>('messages')
  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)

  const isPersonalAssistantConversation = isPersonalAssistantActiveChannel
  const isConversationSurface =
    activeChannel?.type === 'dm' || isPersonalAssistantConversation
  const visibleActiveTab =
    isConversationSurface && isOperationsTab(activeTab) ? 'messages' : activeTab
  const personalAssistantAgent =
    personalAssistantState?.agent ?? boundAgents[0] ?? null
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
    agents,
    channelUsers,
    isConversationSurface,
    onSelectAgent,
  })

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
  } = useChannelComposer({
    activeChannel,
    threadMessages,
    currentUserId: me?.user.id,
  })

  useEffect(() => {
    if (isConversationSurface && isOperationsTab(activeTab)) {
      setActiveTab('messages')
    }
  }, [activeTab, isConversationSurface])

  const lastReadMarkerRef = useRef<string | null>(null)
  const pendingReadMarkerRef = useRef<string | null>(null)
  useEffect(() => {
    lastReadMarkerRef.current = null
    pendingReadMarkerRef.current = null
  }, [activeChannel?.defaultThreadId])

  useEffect(() => {
    const threadId = activeChannel?.defaultThreadId
    const latestMessageId = threadMessages.at(-1)?.id
    if (!threadId || !latestMessageId) {
      return
    }

    const marker = `${threadId}:${latestMessageId}`
    if (lastReadMarkerRef.current === marker || pendingReadMarkerRef.current === marker) {
      return
    }

    pendingReadMarkerRef.current = marker
    markThreadRead.mutate(threadId, {
      onError: () => {
        pendingReadMarkerRef.current = null
      },
      onSuccess: () => {
        lastReadMarkerRef.current = marker
        pendingReadMarkerRef.current = null
      },
    })
  }, [activeChannel?.defaultThreadId, markThreadRead, threadMessages])

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
    <section className="flex h-full min-h-0 flex-col">
      <ChannelHeader
        activeChannel={activeChannel}
        isPersonalAssistantConversation={isPersonalAssistantConversation}
        channelUsers={channelUsers}
        boundAgents={boundAgents}
        callEligible={callEligible}
        activeCall={Boolean(activeCall)}
        isInCall={isInCall}
        onOpenMembers={() => setShowMembersPopup(true)}
        onCallButton={onCallButton}
      />

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
            isPersonalAssistantConversation={isPersonalAssistantConversation}
            renderContent={renderContent}
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
        onInsertAtSign={() => mentionRef.current?.insertAtSign()}
      />

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

      <OversizePasteDialog
        limit={CHAT_MESSAGE_MAX_CHARS}
        onCancel={() => setOversizePaste(null)}
        onInsertTrimmed={(trimmed) => {
          setOversizePaste(null)
          mentionRef.current?.insertText(trimmed)
        }}
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
    </section>
  )
}
