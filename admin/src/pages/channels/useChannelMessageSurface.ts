import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { Location } from 'react-router-dom'

import type {
  AgentRecord,
  ChannelRecord,
  UserRecord,
} from '../../lib/api-client'
import { useJoinChannel } from '../../facades/channels/hooks'
import { useSyncExternalAgentChannel } from '../../facades/integrations/hooks'
import { useShareRestrictedMessage } from '../../facades/messages/hooks'
import { useThreadMessages, useThreadStream } from '../../facades/threads/hooks'
import { selectPendingForRoot } from '../../facades/threads/thinking'
import { useFileDrop } from '../../hooks/useFileDrop'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { readFocusComposerIntent } from '../../components/features/agents/conversations/conversation-intent'
import {
  type ChannelAgentParticipant,
  type MessageUserIdentity,
} from '../../components/features/channels/channel-participants'
import { buildFeedItems } from '../../components/features/channels/channel-feed'
import { channelComposerDraftKey } from '../../components/features/channels/composer-draft'
import { useAgentLivenessHint } from '../../components/features/channels/useAgentLivenessHint'
import { useChannelComposer } from '../../components/features/channels/useChannelComposer'
import { useChannelMessageActions } from '../../components/features/channels/useChannelMessageActions'
import { useReplyThread } from '../../components/features/channels/useReplyThread'
import { isConversationReadReady } from './thread-read-marker'
import { useThreadReadMarker } from './useThreadReadMarker'
import { useReportChannelPushSurface } from './useReportChannelPushSurface'
import { useChannelMentions } from './useChannelMentions'
import { useAlertMessageHighlight, useChannelMessageSearch } from './useChannelMessageSearch'
import { useDeepWaterResearchLauncher } from './useDeepWaterResearchLauncher'
import { useExecutorRunLauncher } from './useExecutorRunLauncher'

type ChannelMessageSurfaceInput = {
  activeChannel: ChannelRecord | null
  activeThreadId: string | undefined
  agents: AgentRecord[]
  boundAgents: AgentRecord[]
  channelId: string | undefined
  channels: ChannelRecord[]
  channelUsers: UserRecord[]
  currentUserId: string | undefined
  inConversation: boolean
  isComposeRoute: boolean
  isExternalAgentActiveChannel: boolean
  isGlobalAgentActiveChannel: boolean
  isPersonalAssistantConversation: boolean
  location: Location
  phoneLayout: boolean
  redirect: (to: string) => void
  routeTool: 'browser' | 'conversations' | null
  searchParams: URLSearchParams
  setRenameConversationOpen: Dispatch<SetStateAction<boolean>>
  setSelectedMessageAgent: Dispatch<SetStateAction<ChannelAgentParticipant | null>>
  setSelectedMessageUser: Dispatch<SetStateAction<MessageUserIdentity | null>>
  threadId: string | undefined
  visibleActiveTab: string
}

/**
 * Owns the room's message, reply, feed, and run controls. Keeping this state
 * machine together lets the page remain the route/data composition boundary.
 */
export const useChannelMessageSurface = ({
  activeChannel,
  activeThreadId,
  agents,
  boundAgents,
  channelId,
  channels,
  channelUsers,
  currentUserId,
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
}: ChannelMessageSurfaceInput) => {
  const {
    data: threadMessages = [],
    fetchNextPage: fetchOlderThreadMessages,
    hasNextPage: hasOlderThreadMessages,
    isFetched: threadMessagesFetched,
    isFetchNextPageError: olderThreadMessagesFailed,
    isFetchingNextPage: isLoadingOlderThreadMessages,
    isPlaceholderData: threadMessagesArePlaceholder,
    pageCount: threadMessagePageCount,
  } = useThreadMessages(activeThreadId)
  const { documentSessions, documentStore, pendingMessages } = useThreadStream(activeThreadId)
  const { mentionEntities, renderContent } = useChannelMentions({
    activeChannel,
    agents,
    channels,
    channelUsers,
    personalAssistantPresences: activeChannel?.personalAssistantPresences,
  })
  const replyThread = useReplyThread({ activeChannel, agents, channelUsers })
  const browserThreadId = (routeTool === 'browser' ? searchParams.get('threadId') : null)
    ?? replyThread.activeThreadId
    ?? activeThreadId
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
  useThreadReadMarker(
    replyThread.activeThreadId,
    visibleConversationMessages,
    visibleActiveTab === 'messages' && conversationReadReady,
    replyThread.openRootMessageId ?? undefined,
  )
  useReportChannelPushSurface({
    activeChannel,
    activeThreadId: replyThread.activeThreadId,
    location,
    openRootMessageId: replyThread.openRootMessageId,
    visibleActiveTab,
  })

  const composer = useChannelComposer({
    activeChannel,
    activeThreadId,
    threadMessages,
    currentUserId,
    draftKey: channelComposerDraftKey(inConversation ? threadId : activeChannel?.id),
  })
  const chatDrop = useFileDrop(composer.attachments.addFiles)
  const deepWaterLauncher = useDeepWaterResearchLauncher(composer.message)
  const messageActions = useChannelMessageActions(activeThreadId)
  const cancelEdit = messageActions.cancelEdit
  const shareRestricted = useShareRestrictedMessage(activeThreadId)
  const search = useChannelMessageSearch(activeChannel?.id)
  const closeSearch = search.closeSearch
  const feedScroll = useStickToBottom(
    `${activeThreadId ?? activeChannel?.id ?? ''}:${visibleActiveTab}`,
    visibleActiveTab === 'messages',
    {
      failed: olderThreadMessagesFailed,
      hasMore: visibleActiveTab === 'messages' && Boolean(hasOlderThreadMessages),
      isLoading: isLoadingOlderThreadMessages,
      itemCount: threadMessages.length,
      loadMore: () => fetchOlderThreadMessages({ cancelRefetch: false }),
      pageCount: threadMessagePageCount,
    },
  )
  const releaseFeedPin = feedScroll.releasePin
  const jumpToMessage = search.jumpToMessage
  const jumpToFeedMessage = useCallback((messageId: string) => {
    releaseFeedPin()
    jumpToMessage(messageId)
  }, [jumpToMessage, releaseFeedPin])
  useAlertMessageHighlight(threadMessagesFetched, jumpToFeedMessage)
  const [showChannelSettings, setShowChannelSettings] = useState(false)
  const joinChannel = useJoinChannel()

  useEffect(() => {
    cancelEdit()
    closeSearch()
    setShowChannelSettings(false)
    setRenameConversationOpen(false)
    setSelectedMessageUser(null)
    setSelectedMessageAgent(null)
  }, [
    activeChannel?.id,
    activeThreadId,
    cancelEdit,
    closeSearch,
    setRenameConversationOpen,
    setSelectedMessageAgent,
    setSelectedMessageUser,
  ])

  const focusComposerOnArrival = readFocusComposerIntent(location.state)
  useEffect(() => {
    if (focusComposerOnArrival) composer.mentionRef.current?.focus()
  }, [activeThreadId, composer.mentionRef, focusComposerOnArrival])

  const { mutate: syncExternalAgentMutate } = useSyncExternalAgentChannel()
  const activeChannelId = activeChannel?.id
  const activeChannelThreadId = activeChannel?.defaultThreadId
  useEffect(() => {
    if (isExternalAgentActiveChannel && activeChannelId) {
      syncExternalAgentMutate({
        channelId: activeChannelId,
        threadId: activeChannelThreadId ?? undefined,
      })
    }
  }, [activeChannelId, activeChannelThreadId, isExternalAgentActiveChannel, syncExternalAgentMutate])

  useEffect(() => {
    if (!phoneLayout && !isComposeRoute && !channelId && activeChannel) {
      redirect(`/channels/${activeChannel.id}`)
    }
  }, [activeChannel, channelId, isComposeRoute, phoneLayout, redirect])

  const hasRespondingAgent = boundAgents.length > 0
    || (activeChannel?.personalAssistantPresences?.length ?? 0) > 0
    || isPersonalAssistantConversation
    || isExternalAgentActiveChannel
    || isGlobalAgentActiveChannel
  const channelLiveness = useAgentLivenessHint({
    hasRespondingAgent,
    meUserId: currentUserId ?? '',
    messages: threadMessages,
    pendingMessages,
    surfaceKey: activeThreadId,
  })
  const executorLauncher = useExecutorRunLauncher({
    agents: !isPersonalAssistantConversation && !isExternalAgentActiveChannel ? boundAgents : [],
    message: composer.message,
    onLaunched: () => {
      composer.setMessage('')
      feedScroll.pinToBottom()
      channelLiveness.markSent()
    },
    projectId: activeChannel?.projectId,
    threadId: activeThreadId,
  })

  return {
    browserThreadId,
    channelLiveness,
    chatDrop,
    composer,
    deepWaterLauncher,
    documentSessions,
    documentStore,
    executorLauncher,
    feedItems: buildFeedItems(threadMessages),
    feedScroll,
    fetchOlderThreadMessages,
    hasOlderThreadMessages,
    hasRespondingAgent,
    isLoadingOlderThreadMessages,
    joinChannel,
    messageActions,
    mentionEntities,
    olderThreadMessagesFailed,
    oversizePaste: composer.oversizePaste,
    pendingMessages,
    renderContent,
    replyThread,
    search,
    setOversizePaste: composer.setOversizePaste,
    setShowChannelSettings,
    shareRestricted,
    showChannelSettings,
    threadMessagePageCount,
    threadMessages,
    threadPendingMessages: selectPendingForRoot(pendingMessages, replyThread.openRootMessageId),
  }
}
