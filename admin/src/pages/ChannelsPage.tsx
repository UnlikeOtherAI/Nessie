import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useChannels, useJoinChannel } from '../facades/channels/hooks'
import {
  useDeleteMessage,
  useMessageSearch,
  useUpdateMessage,
} from '../facades/messages/hooks'
import { isPersonalAssistantChannel, usePersonalAssistant } from '../facades/personal-assistant/hooks'
import { useMarkThreadRead, useThreadMessages, useThreadStream } from '../facades/threads/hooks'
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
import { ChannelTabBar } from '../components/features/channels/ChannelTabBar'
import { ChannelTabPanels } from '../components/features/channels/ChannelTabPanels'
import { buildFeedItems, formatClock, isOperationsTab, type ChannelTab } from '../components/features/channels/channel-helpers'
import { useChannelCall } from './channels/useChannelCall'
import { useChannelComposer } from './channels/useChannelComposer'
import { useChannelMentions } from './channels/useChannelMentions'

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
    channels,
    channelUsers,
    isConversationSurface,
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
    sendAsFile,
  } = useChannelComposer({
    activeChannel,
    threadMessages,
    currentUserId: me?.user.id,
  })

  // sp-messaging: inline edit + channel message search.
  const updateMessage = useUpdateMessage(activeChannel?.defaultThreadId)
  const deleteMessage = useDeleteMessage(activeChannel?.defaultThreadId)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const { data: searchResults = [] } = useMessageSearch(activeChannel?.id, searchQuery)
  // sp-channels: channel settings dialog + join.
  const [showChannelSettings, setShowChannelSettings] = useState(false)
  const joinChannel = useJoinChannel()

  const submitEdit = useCallback(
    async (messageId: string) => {
      const next = editingContent.trim()
      if (!next) {
        return
      }
      try {
        await updateMessage.mutateAsync({ content: next, messageId })
      } finally {
        setEditingMessageId(null)
        setEditingContent('')
      }
    },
    [editingContent, updateMessage],
  )

  const confirmDelete = useCallback(
    (messageId: string) => {
      if (!window.confirm('Delete this message? This cannot be undone.')) {
        return
      }
      deleteMessage.mutate(messageId)
    },
    [deleteMessage],
  )

  const jumpToMessage = useCallback((messageId: string) => {
    const element = document.getElementById(`msg-${messageId}`)
    if (!element) {
      return
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.classList.add('admin-msg-highlight')
    window.setTimeout(() => element.classList.remove('admin-msg-highlight'), 1600)
  }, [])

  useEffect(() => {
    if (isConversationSurface && isOperationsTab(activeTab)) {
      setActiveTab('messages')
    }
  }, [activeTab, isConversationSurface])

  useEffect(() => {
    setEditingMessageId(null)
    setEditingContent('')
    setSearchOpen(false)
    setSearchQuery('')
    setShowChannelSettings(false)
  }, [activeChannel?.id])

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
        searchOpen={searchOpen}
        joinPending={joinChannel.isPending}
        onOpenMembers={() => setShowMembersPopup(true)}
        onCallButton={onCallButton}
        onOpenSettings={() => setShowChannelSettings(true)}
        onJoin={() => {
          if (activeChannel) {
            joinChannel.mutate({ channelId: activeChannel.id })
          }
        }}
        onToggleSearch={() =>
          setSearchOpen((open) => {
            if (open) {
              setSearchQuery('')
            }
            return !open
          })
        }
      />

      {searchOpen ? (
        <div className="border-b border-[color:var(--sep)] px-5 py-2">
          <input
            autoFocus
            className="admin-input w-full text-sm"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false)
                setSearchQuery('')
              }
            }}
            placeholder="Search messages in this channel"
            type="text"
            value={searchQuery}
          />
          {searchQuery.trim().length > 0 ? (
            <div className="mt-2 max-h-64 overflow-y-auto">
              {searchResults.length === 0 ? (
                <div className="px-1 py-2 text-sm text-[color:var(--tx3)]">
                  No matches.
                </div>
              ) : (
                searchResults.map((result) => (
                  <button
                    key={result.id}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-[color:var(--overlay-weak)]"
                    onClick={() => {
                      jumpToMessage(result.id)
                      setSearchOpen(false)
                      setSearchQuery('')
                    }}
                    type="button"
                  >
                    <span className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
                      <span className="font-semibold text-[color:var(--tx2)]">
                        {result.authorName}
                      </span>
                      #{result.channelLabel} · {formatClock(result.createdAt)}
                    </span>
                    <span className="truncate text-sm text-[color:var(--tx)]">
                      {result.snippet}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
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
            token={token}
            isPersonalAssistantConversation={isPersonalAssistantConversation}
            renderContent={renderContent}
            editingMessageId={editingMessageId}
            editingContent={editingContent}
            updatePending={updateMessage.isPending}
            onStartEdit={(messageId, content) => {
              setEditingMessageId(messageId)
              setEditingContent(content)
            }}
            onChangeEditingContent={setEditingContent}
            onSubmitEdit={(messageId) => void submitEdit(messageId)}
            onCancelEdit={() => {
              setEditingMessageId(null)
              setEditingContent('')
            }}
            onConfirmDelete={confirmDelete}
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
    </section>
  )
}
