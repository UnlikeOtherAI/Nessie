/**
 * Thread reads as plain functions, apart from the hooks that call them.
 *
 * `hooks.ts` owns the SSE stream and reads `import.meta.env` at module scope,
 * so anything importing it drags that in. `navigation/prewarm.ts` needs only
 * the fetcher — and it must be the *same* fetcher the hook uses, or the prewarm
 * would fill the cache under the right key with a shape that drifts.
 */

import type { ApiClient, ThreadMessageRecord } from '../../lib/api-client'

/** The thread's first page of messages: what a channel screen shows on arrival. */
export const fetchThreadMessages = (
  apiClient: ApiClient,
  threadId: string,
): Promise<ThreadMessageRecord[]> =>
  apiClient.get(`/api/threads/${threadId}/messages`)
