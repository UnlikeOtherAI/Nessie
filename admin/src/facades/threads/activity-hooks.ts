import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { getBaseUrl } from '../../lib/api-client'
import { readSseStream } from '../../lib/sse'
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
const baseUrl = getBaseUrl()

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

export const useThreadActivityEvents = (): void => {
  const queryClient = useQueryClient()
  const { token } = useAuthSession()
  useEffect(() => {
    if (!token) return
    let cancelled = false
    let controller: AbortController | null = null
    let lastEventId = ''
    const connect = async () => {
      while (!cancelled) {
        controller = new AbortController()
        try {
          const response = await fetch(`${baseUrl}/api/events/stream`, {
            headers: { authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error('Event stream unavailable')
          await readSseStream(response.body, (frame) => {
            if (frame.id) lastEventId = frame.id
            if (frame.event === 'message.reply.meta' || frame.event === 'message.reply' || frame.event === 'message.deleted' || frame.event === 'alert.created' || frame.event === 'thread.read') {
              // Pages are keyset slices. An activity change can move an item
              // across a saved boundary, so retain only page one before
              // refetching rather than flattening stale pages into duplicates.
              void queryClient.resetQueries({ queryKey: ['threads', 'activity'] })
            }
          })
        } catch {
          // Reconnect below; REST remains the source of truth.
        }
        if (!cancelled) await new Promise((resolve) => window.setTimeout(resolve, 2_000))
      }
    }
    void connect()
    return () => { cancelled = true; controller?.abort() }
  }, [queryClient, token])
}
