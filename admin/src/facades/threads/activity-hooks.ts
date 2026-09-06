import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { threadKeys } from './keys'
import { useEventStream } from '../realtime/event-stream'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export type ThreadActivity = {
  rootMessageId: string
  threadId: string
  channelId: string
  channelLabel: string
  root: { id: string; content: string; createdAt: string; author?: { displayName: string }; agentId?: string }
  latestReply: { id: string; content: string; createdAt: string; author?: { displayName: string }; agentId?: string }
  replyCount: number
  unread: boolean
}

export type ThreadActivityResponse = {
  hasMore: boolean
  items: ThreadActivity[]
  nextCursor?: string
  unreadTotal: number
}

type ThreadActivityCache = InfiniteData<ThreadActivityResponse>

// Keep the inbox mounted while a read marker is acknowledged. A query reset
// clears every page and makes the scroll container jump before its refetch
// completes; the marker only changes one card's unread treatment instead.
export const markThreadActivityReadInCache = (
  cache: ThreadActivityCache | undefined,
  input: { rootMessageId?: string; threadId: string; unreadOnly?: boolean },
): ThreadActivityCache | undefined => {
  if (!cache?.pages.length || !input.rootMessageId) return cache

  let markedUnreadCount = 0
  const pagesWithReadState = cache.pages.map((page) => {
    let pageChanged = false
    const items = page.items.flatMap((item) => {
      if (
        item.threadId !== input.threadId
        || item.rootMessageId !== input.rootMessageId
        || !item.unread
      ) {
        return [item]
      }
      pageChanged = true
      markedUnreadCount += 1
      return input.unreadOnly ? [] : [{ ...item, unread: false }]
    })
    return pageChanged ? { ...page, items } : page
  })

  if (markedUnreadCount === 0) return cache

  return {
    ...cache,
    pages: pagesWithReadState.map((page) => ({
      ...page,
      unreadTotal: Math.max(0, page.unreadTotal - markedUnreadCount),
    })),
  }
}

const parseThreadReadEvent = (
  frameData: string | undefined,
): { rootMessageId: string; threadId: string } | null => {
  if (!frameData) return null
  try {
    const envelope = JSON.parse(frameData) as unknown
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return null
    const data = 'data' in envelope ? envelope.data : envelope
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const { rootMessageId, threadId } = data as Record<string, unknown>
    return typeof rootMessageId === 'string' && typeof threadId === 'string'
      ? { rootMessageId, threadId }
      : null
  } catch {
    return null
  }
}

export const useThreadActivity = ({ unreadOnly = false }: { unreadOnly?: boolean } = {}) => {
  const apiClient = useApiClient()
  const query = useInfiniteQuery<ThreadActivityResponse>({
    queryKey: threadKeys.activity(unreadOnly),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : undefined
      const query = new URLSearchParams()
      if (cursor) query.set('cursor', cursor)
      if (unreadOnly) query.set('unread', 'true')
      const suffix = query.size > 0 ? `?${query.toString()}` : ''
      return apiClient.get(`/api/threads/activity${suffix}`)
    },
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    // SSE provides immediacy; the modest refresh also reconciles a channel
    // membership change without relying on a permanent browser connection.
    refetchInterval: 15_000,
  })
  const firstPage = query.data?.pages[0]
  return {
    ...query,
    data: firstPage
      ? {
          hasMore: query.hasNextPage,
          items: (query.data?.pages ?? []).flatMap((page) => page.items),
          unreadTotal: firstPage.unreadTotal,
        }
      : undefined,
  }
}

// A subscriber on the one shared /api/events/stream connection, not a second
// socket. This hook opened its own fetch with a flat 2s retry and no terminal
// classification, which is exactly the pair of connections — each parsing every
// frame and discarding the other's events, each retrying a 403 forever — that
// facades/realtime/event-stream.ts exists to collapse. The event filter and the
// reset policy stay here, where they belong.
const ACTIVITY_EVENTS = new Set([
  'alert.created',
  'message.deleted',
  'message.reply',
  'message.reply.meta',
])
const UNREAD_DIRECT_MESSAGE_EVENTS = new Set([
  'message.deleted',
  'message.new',
  'message.reply',
  'thread.read',
])

export const useThreadActivityEvents = (): void => {
  const queryClient = useQueryClient()
  const { token } = useAuthSession()

  useEventStream({
    enabled: Boolean(token),
    onFrame: (frame) => {
      if (!frame.event) return
      if (frame.event === 'thread.read') {
        const read = parseThreadReadEvent(frame.data)
        if (!read) return
        let needsRefresh = false
        for (const unreadOnly of [false, true]) {
          const key = threadKeys.activity(unreadOnly)
          const cached = queryClient.getQueryData<ThreadActivityCache>(key)
          const next = markThreadActivityReadInCache(cached, { ...read, unreadOnly })
          if (next === cached) {
            needsRefresh ||= cached !== undefined
          } else {
            queryClient.setQueryData(key, next)
          }
        }
        if (needsRefresh) {
          void queryClient.invalidateQueries({ queryKey: threadKeys.activityRoot })
        }
        return
      }
      if (ACTIVITY_EVENTS.has(frame.event)) {
        // Pages are keyset slices. An activity change can move an item across a
        // saved boundary, so retain only page one before refetching rather than
        // flattening stale pages into duplicates.
        void queryClient.resetQueries({ queryKey: threadKeys.activityRoot })
      }
      if (UNREAD_DIRECT_MESSAGE_EVENTS.has(frame.event)) {
        void queryClient.invalidateQueries({ queryKey: threadKeys.unreadDirectMessages })
      }
    },
  })
}
