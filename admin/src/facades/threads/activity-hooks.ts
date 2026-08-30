import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { threadKeys } from '../../lib/query-keys'
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

type ThreadActivityResponse = {
  hasMore: boolean
  items: ThreadActivity[]
  nextCursor?: string
  unreadTotal: number
}

export const useThreadActivity = () => {
  const apiClient = useApiClient()
  const query = useInfiniteQuery<ThreadActivityResponse>({
    queryKey: ['threads', 'activity'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : undefined
      return apiClient.get(
        `/api/threads/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
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
  'thread.read',
])

export const useThreadActivityEvents = (): void => {
  const queryClient = useQueryClient()
  const { token } = useAuthSession()

  useEventStream({
    enabled: Boolean(token),
    onFrame: (frame) => {
      if (!frame.event || !ACTIVITY_EVENTS.has(frame.event)) return
      // Pages are keyset slices. An activity change can move an item across a
      // saved boundary, so retain only page one before refetching rather than
      // flattening stale pages into duplicates.
      void queryClient.resetQueries({ queryKey: threadKeys.activity })
    },
  })
}
