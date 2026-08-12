import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useChannels } from '../channels/hooks'
import type { ChannelRecord, ThreadMessageRecord } from '../../lib/api-client'
import { getBaseUrl } from '../../lib/api-client'
import { parseChannelIdFromPath, parseThreadIdFromPath } from '../../lib/channel-route'
import { readSseStream } from '../../lib/sse'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { getNotificationApi } from './permission'

const RECONNECT_DELAY_MS = 2_000
const MAX_NOTIFIED_MESSAGE_IDS = 500

const baseUrl = getBaseUrl()

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
  activeThreadId?: string
  channelLookup: ChannelLookup
  currentUserId: string
  onToast: (toast: NotificationToastInput) => void
  openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
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
  activeThreadId?: string
  foreground: boolean
  threadId?: string
}): boolean =>
  input.foreground
  && Boolean(input.threadId)
  && input.threadId === input.activeThreadId

export const isMessageCreatedEvent = (event: string): boolean =>
  event === 'message.new' || event === 'message.reply'

const isActivelyViewingThread = (threadId: string | undefined, activeThreadId?: string): boolean =>
  shouldSuppressMessageBanner({
    activeThreadId,
    foreground: document.visibilityState === 'visible' && document.hasFocus(),
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

const showNativeNotification = (
  input: NotificationToastInput & {
    openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
  },
): void => {
  const notificationApi = getNotificationApi()
  if (!notificationApi || notificationApi.permission !== 'granted') {
    return
  }

  try {
    const notification = new notificationApi(input.title, {
      body: input.body,
      tag: input.threadId ?? input.channelId,
    })
    notification.addEventListener('click', () => {
      input.openChannel(input.channelId, input.threadId, input.rootMessageId)
      notification.close()
    })
  } catch {
    // Native notification support varies by host webview; the in-app toast remains.
  }
}

export const useMessageNotifications = (input: {
  onToast: (toast: NotificationToastInput) => void
  openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
}): void => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const { me, token } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const location = useLocation()
  const activeChannelId = useMemo(
    () => parseChannelIdFromPath(location.pathname),
    [location.pathname],
  )
  const channelLookup = useMemo(() => buildChannelLookup(channels), [channels])
  const activeThreadId = useMemo(() => {
    const replyThread = parseThreadIdFromPath(location.pathname)
    if (replyThread) return replyThread
    return activeChannelId ? channelLookup.byId.get(activeChannelId)?.defaultThreadId : undefined
  }, [activeChannelId, channelLookup, location.pathname])
  const currentUserId = me?.user.id
  const notificationsEnabled = Boolean(me) && me?.user.preferences?.pushEnabled !== false
  const latestRef = useRef<LatestNotificationState>({
    channelLookup: emptyChannelLookup,
    currentUserId: '',
    onToast: input.onToast,
    openChannel: input.openChannel,
  })
  const notifiedMessageIdsRef = useRef(new Set<string>())

  useEffect(() => {
    latestRef.current = {
      activeThreadId,
      channelLookup,
      currentUserId: currentUserId ?? '',
      onToast: input.onToast,
      openChannel: input.openChannel,
    }
  }, [activeThreadId, channelLookup, currentUserId, input.onToast, input.openChannel])

  useEffect(() => {
    if (!currentUserId || !notificationsEnabled || !token) {
      notifiedMessageIdsRef.current.clear()
      return
    }

    let cancelled = false
    let lastEventId = ''
    let activeController: AbortController | null = null

    const handleMessageCreated = async (payload: MessageCreatedPayload): Promise<void> => {
      const latest = latestRef.current
      let channel = resolveChannel(payload, latest.channelLookup)

      if (!channel && !payload.channelId && payload.threadId) {
        try {
          const freshChannels = await queryClient.fetchQuery<ChannelRecord[]>({
            queryKey: ['channels'],
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
          queryKey: ['threads', payload.threadId, 'messages'],
        })
      }
      void queryClient.invalidateQueries({ queryKey: ['channels'] })

      // A foreground banner is suppressed only while this exact conversation is
      // visible and focused. A different thread in the same channel is still
      // work that needs attention, just like a different channel.
      if (!channelId || isActivelyViewingThread(payload.threadId, latest.activeThreadId)) {
        return
      }

      if (payload.messageId && notifiedMessageIdsRef.current.has(payload.messageId)) {
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

      if (payload.messageId) {
        notifiedMessageIdsRef.current.add(payload.messageId)
        trimNotifiedMessageIds(notifiedMessageIdsRef.current)
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

      showNativeNotification({
        ...notificationInput,
        openChannel: latest.openChannel,
      })
      latest.onToast(notificationInput)
    }

    const handleFrame = async (frameData: string, suppressEventsBefore: number): Promise<void> => {
      const event = parseRealtimeEvent(frameData)
      if (
        !event
        || !isMessageCreatedEvent(event.event)
        || isInitialBacklogEvent(event, suppressEventsBefore)
      ) {
        return
      }

      const payload = parseMessageCreatedPayload(event.data)
      if (payload) {
        await handleMessageCreated(payload)
      }
    }

    const connectStream = async (): Promise<void> => {
      while (!cancelled) {
        const controller = new AbortController()
        const suppressEventsBefore = lastEventId ? 0 : Date.now()
        activeController = controller

        try {
          const headers: Record<string, string> = {
            authorization: `Bearer ${token}`,
          }
          if (lastEventId) {
            headers['Last-Event-ID'] = lastEventId
          }

          const response = await fetch(`${baseUrl}/api/events/stream`, {
            headers,
            signal: controller.signal,
          })

          if (!response.ok || !response.body) {
            throw new Error('Event stream unavailable')
          }

          await readSseStream(response.body, async (frame) => {
            try {
              if (frame.id) {
                lastEventId = frame.id
              }

              if (frame.data && frame.event && isMessageCreatedEvent(frame.event)) {
                await handleFrame(frame.data, suppressEventsBefore)
              }
            } catch {
              // A malformed event or notification failure must not break the stream.
            }
          })
        } catch {
          // Connection lost or rejected; retry below while the user remains signed in.
        } finally {
          if (activeController === controller) {
            activeController = null
          }
        }

        if (!cancelled) {
          await new Promise((resolve) => {
            window.setTimeout(resolve, RECONNECT_DELAY_MS)
          })
        }
      }
    }

    void connectStream()

    return () => {
      cancelled = true
      activeController?.abort()
    }
  }, [apiClient, currentUserId, notificationsEnabled, queryClient, token])
}
