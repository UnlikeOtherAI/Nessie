/**
 * Thread reads as plain functions, apart from the hooks that call them.
 *
 * `hooks.ts` owns the SSE stream and reads `import.meta.env` at module scope,
 * so anything importing it drags that in. `navigation/prewarm.ts` needs only
 * the fetcher — and it must be the *same* fetcher the hook uses, or the prewarm
 * would fill the cache under the right key with a shape that drifts.
 */

import {
  infiniteQueryOptions,
  type InfiniteData,
} from '@tanstack/react-query'
import type { ApiResponse } from '@nessie/schemas'
import type { ApiClient, ThreadMessageRecord } from '../../lib/api-client'
import { threadKeys } from '../../lib/query-keys'

export type ThreadMessagePage = ApiResponse<ThreadMessageRecord[]>
export type ThreadMessagePages = InfiniteData<ThreadMessagePage, string | undefined>
type ThreadMessageQueryKey =
  | ReturnType<typeof threadKeys.messages>
  | ReturnType<typeof threadKeys.repliesOf>

const messageHistoryPath = (
  threadId: string,
  before?: string,
  rootMessageId?: string,
): string => {
  const search = new URLSearchParams()
  if (before) search.set('before', before)
  if (rootMessageId) search.set('rootMessageId', rootMessageId)
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  return `/api/threads/${encodeURIComponent(threadId)}/messages${suffix}`
}

/** One message-history page, retaining the cursor envelope for older reads. */
export const fetchThreadMessages = (
  apiClient: ApiClient,
  threadId: string,
  before?: string,
  rootMessageId?: string,
): Promise<ThreadMessagePage> =>
  apiClient.getPage<ThreadMessageRecord[]>(
    messageHistoryPath(threadId, before, rootMessageId),
  )

/**
 * The exact infinite-query contract shared by the screen and navigation
 * prewarm. Pages arrive newest first from the API; consumers flatten them into
 * chronological order with `flattenThreadMessagePages` below.
 */
export const threadMessagesInfiniteQueryOptions = (
  apiClient: ApiClient,
  threadId: string,
  rootMessageId?: string,
) => infiniteQueryOptions<
  ThreadMessagePage,
  Error,
  ThreadMessagePages,
  ThreadMessageQueryKey,
  string | undefined
>({
  getNextPageParam: (lastPage) =>
    lastPage.meta?.hasMore ? lastPage.meta.nextCursor ?? undefined : undefined,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    fetchThreadMessages(apiClient, threadId, pageParam, rootMessageId),
  queryKey: rootMessageId
    ? threadKeys.repliesOf(threadId, rootMessageId)
    : threadKeys.messages(threadId),
})

/** Chronological, duplicate-free rows from newest-page-first query data. */
export const flattenThreadMessagePages = (
  pages: ThreadMessagePages | undefined,
): ThreadMessageRecord[] => {
  if (!pages) return []

  const byId = new Map<string, ThreadMessageRecord>()
  for (const page of pages.pages) {
    for (const message of page.data) {
      // Pages are stored newest-window first. If a boundary shifts while stale
      // pages refetch, keep the copy from the more recent window.
      if (!byId.has(message.id)) byId.set(message.id, message)
    }
  }
  return [...byId.values()].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt)
    return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt
  })
}

/** Put a just-finished streamed message in the newest page until REST settles. */
export const upsertNewestThreadMessage = (
  pages: ThreadMessagePages | undefined,
  message: ThreadMessageRecord,
): ThreadMessagePages => {
  if (!pages?.pages[0]) {
    return {
      pageParams: [undefined],
      pages: [{
        data: [message],
        meta: { hasMore: false, nextCursor: null, prevCursor: null },
      }],
    }
  }

  const withoutMessage = pages.pages.map((page) => ({
    ...page,
    data: page.data.filter((entry) => entry.id !== message.id),
  }))
  const firstPage = withoutMessage[0]
  if (!firstPage) return pages
  return {
    ...pages,
    pages: [
      {
        ...firstPage,
        data: [...firstPage.data, message],
      },
      ...withoutMessage.slice(1),
    ],
  }
}
