import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useChannels } from '../channels/hooks'
import type { ChannelRecord, ThreadMessageRecord } from '../../lib/api-client'
import {
  parseChannelIdFromPath,
  parseReplyRootMessageIdFromPath,
  parseThreadIdFromPath,
} from '../../lib/channel-route'
import {
  getLatestPushSurfaceReport,
  parsePushSurfaceReport,
  PUSH_SURFACE_CHANGE_EVENT,
  resolveReportedPushSurface,
  type PushSurfaceReport,
} from '../../lib/push-surface'
import type { SseFrame } from '../../lib/sse'
import { channelKeys } from '../channels/keys'
import { threadKeys } from '../threads/keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useEventStream } from '../realtime/event-stream'
import type { EventStreamConnection } from '../realtime/event-stream-fanout'
import { showBrowserNotification } from './browser-notification'

const MAX_NOTIFIED_MESSAGE_IDS = 500

export type NotificationToastInput = {
  body: string
  channelId: string
  messageId?: string
  rootMessageId?: string
  threadId?: string
  title: string
}

type ChannelLookup = {
  byId: Map<string, ChannelRecord>
  byThreadId: Map<string, ChannelRecord>
}

type MessageCreatedPayload = {
  authorName?: string
  channelId?: string
  contentPreview: string
  messageId?: string
  raw: Record<string, unknown>
  rootMessageId?: string
  role?: string
  threadId?: string
}

type RealtimeEventFrame = {
  data: unknown
  event: string
  ts?: string
}

type LatestNotificationState = {
  activeRootMessageId?: string
  activeThreadId?: string
  channelLookup: ChannelLookup
  currentUserId: string
  onToast: (toast: NotificationToastInput) => void
  openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
  suppressNotifications: boolean
}

const emptyChannelLookup: ChannelLookup = {
  byId: new Map(),
  byThreadId: new Map(),
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const buildChannelLookup = (channels: ChannelRecord[]): ChannelLookup => ({
  byId: new Map(channels.map((channel) => [channel.id, channel])),
  byThreadId: new Map(channels.map((channel) => [channel.defaultThreadId, channel])),
})

const getAuthorName = (payload: Record<string, unknown>): string | undefined => {
  const directName = readString(payload, 'authorName') ?? readString(payload, 'authorDisplayName')
  if (directName) {
    return directName
  }

  const author = payload.author
  if (!isRecord(author)) {
    return undefined
  }

  return readString(author, 'displayName') ?? readString(author, 'name')
}

const getAuthorUserId = (payload: Record<string, unknown>): string | undefined => {
  const directUserId = readString(payload, 'authorUserId') ?? readString(payload, 'userId')
  if (directUserId) {
    return directUserId
  }

  const author = payload.author
  if (!isRecord(author)) {
    return undefined
  }

  const nestedUserId = readString(author, 'userId')
  if (nestedUserId) {
    return nestedUserId
  }

  const authorKind = readString(author, 'kind') ?? readString(author, 'type')
  return authorKind === 'user' ? readString(author, 'id') : undefined
}

const parseRealtimeEvent = (data: string): RealtimeEventFrame | null => {
  try {
    const parsed = JSON.parse(data) as unknown
    if (!isRecord(parsed) || readString(parsed, 'type') !== 'event') {
      return null
    }

    const event = readString(parsed, 'event')
    if (!event || !('data' in parsed)) {
      return null
    }

    return {
      data: parsed.data,
      event,
      ts: readString(parsed, 'ts'),
    }
  } catch {
    return null
  }
}

const parseMessageCreatedPayload = (data: unknown): MessageCreatedPayload | null => {
  if (!isRecord(data)) {
    return null
  }

  const channelId = readString(data, 'channelId')
  const threadId = readString(data, 'threadId')
  if (!channelId && !threadId) {
    return null
  }

  return {
    authorName: getAuthorName(data),
    channelId,
    contentPreview: readString(data, 'contentPreview') ?? readString(data, 'content') ?? '',
    messageId: readString(data, 'messageId'),
    raw: data,
    rootMessageId: readString(data, 'rootMessageId'),
    role: readString(data, 'role'),
    threadId,
  }
}

/**
 * The cutoff below which a frame is history rather than news.
 *
 * A cold connection is handed the hub's buffer to warm the feed, and announcing
 * that as new messages would toast a burst of things the user has already read.
 * A connection that resumed from a `Last-Event-ID` replays only what this
 * session genuinely missed, so nothing there is suppressed.
 */
export const backlogWatermark = (connection: EventStreamConnection): number =>
  connection.resumed ? 0 : connection.openedAt

const isInitialBacklogEvent = (
  event: RealtimeEventFrame,
  connectedAt: number,
): boolean => {
  if (!event.ts) {
    return false
  }

  const eventTime = Date.parse(event.ts)
  return Number.isFinite(eventTime) && eventTime < connectedAt
}

export const shouldSuppressMessageBanner = (input: {
  activeRootMessageId?: string
  activeThreadId?: string
  foreground: boolean
  rootMessageId?: string
  threadId?: string
}): boolean =>
  input.foreground
  && Boolean(input.threadId)
  && input.threadId === input.activeThreadId
  && (input.rootMessageId ?? null) === (input.activeRootMessageId ?? null)

export const isMessageCreatedEvent = (event: string): boolean =>
  event === 'message.new' || event === 'message.reply'

const isActivelyViewingConversation = (
  threadId: string | undefined,
  rootMessageId: string | undefined,
  activeThreadId?: string,
  activeRootMessageId?: string,
): boolean =>
  shouldSuppressMessageBanner({
    activeRootMessageId,
    activeThreadId,
    foreground: document.visibilityState === 'visible' && document.hasFocus(),
    rootMessageId,
    threadId,
  })

const resolveChannel = (
  payload: MessageCreatedPayload,
  lookup: ChannelLookup,
): ChannelRecord | undefined =>
  (payload.channelId ? lookup.byId.get(payload.channelId) : undefined)
  ?? (payload.threadId ? lookup.byThreadId.get(payload.threadId) : undefined)

const isCurrentUserMessage = async (
  payload: MessageCreatedPayload,
  currentUserId: string,
  getThreadMessages: (threadId: string) => Promise<ThreadMessageRecord[]>,
): Promise<boolean> => {
  const authorUserId = getAuthorUserId(payload.raw)
  if (authorUserId) {
    return authorUserId === currentUserId
  }

  if (payload.role !== 'user') {
    return false
  }

  if (!payload.threadId || !payload.messageId) {
    return true
  }

  try {
    const messages = await getThreadMessages(payload.threadId)
    const message = messages.find((candidate) => candidate.id === payload.messageId)
    return message?.userId ? message.userId === currentUserId : true
  } catch {
    return true
  }
}

const trimNotifiedMessageIds = (ids: Set<string>): void => {
  while (ids.size > MAX_NOTIFIED_MESSAGE_IDS) {
    const first = ids.values().next()
    if (first.done) {
      return
    }
    ids.delete(first.value)
  }
}

/**
 * Atomically claim a realtime message before any asynchronous work. The same
 * message can arrive through overlapping stream/reconnect event paths, and a
 * later claim would let both callbacks create an in-app banner.
 */
export const claimMessageNotification = (messageIds: Set<string>, messageId?: string): boolean => {
  if (!messageId) return true
  if (messageIds.has(messageId)) return false
  messageIds.add(messageId)
  trimNotifiedMessageIds(messageIds)
  return true
}

export const useMessageNotifications = (input: {
  onToast: (toast: NotificationToastInput) => void
  openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
  suppressNotifications: boolean
}): void => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const { me } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const location = useLocation()
  const route = useMemo(
    () => ({ pathname: location.pathname, search: location.search }),
    [location.pathname, location.search],
  )
  const [reportedSurface, setReportedSurface] = useState<PushSurfaceReport | null>(
    getLatestPushSurfaceReport,
  )
  const reportedSurfaceForRoute = resolveReportedPushSurface(reportedSurface, route)
  useEffect(() => {
    const receiveSelectedSurface = (event: Event) => {
      const report = parsePushSurfaceReport((event as CustomEvent<unknown>).detail)
      if (report) setReportedSurface(report)
    }
    window.addEventListener(PUSH_SURFACE_CHANGE_EVENT, receiveSelectedSurface)
    return () => window.removeEventListener(PUSH_SURFACE_CHANGE_EVENT, receiveSelectedSurface)
  }, [])
  const activeChannelId = useMemo(
    () => reportedSurfaceForRoute?.kind === 'channel'
      ? reportedSurfaceForRoute.channelId
      : reportedSurfaceForRoute === null
        ? undefined
        : parseChannelIdFromPath(location.pathname),
    [location.pathname, reportedSurfaceForRoute],
  )
  const channelLookup = useMemo(() => buildChannelLookup(channels), [channels])
  const activeThreadId = useMemo(() => {
    if (reportedSurfaceForRoute === null) return undefined
    if (reportedSurfaceForRoute?.kind === 'channel') return reportedSurfaceForRoute.threadId
    const replyThread = parseThreadIdFromPath(location.pathname)
    if (replyThread) return replyThread
    return activeChannelId ? channelLookup.byId.get(activeChannelId)?.defaultThreadId : undefined
  }, [activeChannelId, channelLookup, location.pathname, reportedSurfaceForRoute])
  const activeRootMessageId = useMemo(
    () => reportedSurfaceForRoute?.kind === 'channel'
      ? reportedSurfaceForRoute.rootMessageId ?? undefined
      : reportedSurfaceForRoute === null
        ? undefined
        : parseReplyRootMessageIdFromPath(location.pathname),
    [location.pathname, reportedSurfaceForRoute],
  )
  const currentUserId = me?.user.id
  const notificationsEnabled = Boolean(me) && me?.user.preferences?.pushEnabled !== false
  const latestRef = useRef<LatestNotificationState>({
    channelLookup: emptyChannelLookup,
    currentUserId: '',
    onToast: input.onToast,
    openChannel: input.openChannel,
    suppressNotifications: input.suppressNotifications,
  })
  const notifiedMessageIdsRef = useRef(new Set<string>())

  useEffect(() => {
    latestRef.current = {
      activeRootMessageId,
      activeThreadId,
      channelLookup,
      currentUserId: currentUserId ?? '',
      onToast: input.onToast,
      openChannel: input.openChannel,
      suppressNotifications: input.suppressNotifications,
    }
  }, [
    activeRootMessageId,
    activeThreadId,
    channelLookup,
    currentUserId,
    input.onToast,
    input.openChannel,
    input.suppressNotifications,
  ])

  const enabled = Boolean(currentUserId) && notificationsEnabled

  useEffect(() => {
    if (!enabled) {
      notifiedMessageIdsRef.current.clear()
    }
  }, [enabled])

  const handleMessageCreated = useCallback(async (payload: MessageCreatedPayload): Promise<void> => {
    const latest = latestRef.current
    let channel = resolveChannel(payload, latest.channelLookup)

    if (!channel && !payload.channelId && payload.threadId) {
      try {
        const freshChannels = await queryClient.fetchQuery<ChannelRecord[]>({
          queryKey: channelKeys.all,
          queryFn: () => apiClient.get('/api/channels'),
        })
        channel = resolveChannel(payload, buildChannelLookup(freshChannels))
      } catch {
        // Without a channel mapping there is nowhere useful to deep-link.
      }
    }

    const channelId = payload.channelId ?? channel?.id

    if (payload.threadId) {
      void queryClient.invalidateQueries({
        queryKey: threadKeys.messages(payload.threadId),
      })
    }
    void queryClient.invalidateQueries({ queryKey: channelKeys.all })

    // A foreground banner is suppressed only while this exact conversation is
    // visible and focused. A different reply root in the same channel thread
    // is still work that needs attention, just like a different channel.
    if (!channelId || isActivelyViewingConversation(
      payload.threadId,
      payload.rootMessageId,
      latest.activeThreadId,
      latest.activeRootMessageId,
    )) {
      return
    }

    // Focus mode retains cache coherence above, but intentionally ends the
    // interruptive delivery path before claiming or inspecting the message.
    if (latest.suppressNotifications) {
      return
    }

    if (!claimMessageNotification(notifiedMessageIdsRef.current, payload.messageId)) {
      return
    }

    const authoredByCurrentUser = await isCurrentUserMessage(
      payload,
      latest.currentUserId,
      (threadId) => apiClient.get(`/api/threads/${threadId}/messages?limit=50`),
    )
    if (authoredByCurrentUser) {
      return
    }

    const title = channel?.label ?? payload.authorName ?? 'New message'
    const body = payload.contentPreview.trim() || 'New message'
    const rootMessageId = payload.rootMessageId ?? payload.messageId
    const notificationInput = {
      body,
      channelId,
      messageId: payload.messageId,
      rootMessageId,
      threadId: payload.threadId,
      title,
    }

    showBrowserNotification({
      ...notificationInput,
      openChannel: latest.openChannel,
    })
    latest.onToast(notificationInput)
  }, [apiClient, queryClient])

  const onFrame = useCallback(async (
    frame: SseFrame,
    connection: EventStreamConnection,
  ): Promise<void> => {
    try {
      if (!frame.data || !frame.event || !isMessageCreatedEvent(frame.event)) {
        return
      }

      const event = parseRealtimeEvent(frame.data)
      if (
        !event
        || !isMessageCreatedEvent(event.event)
        || isInitialBacklogEvent(event, backlogWatermark(connection))
      ) {
        return
      }

      const payload = parseMessageCreatedPayload(event.data)
      if (payload) {
        await handleMessageCreated(payload)
      }
    } catch {
      // A malformed event or notification failure must not break the stream.
    }
  }, [handleMessageCreated])

  useEventStream({ enabled, onFrame })
}
