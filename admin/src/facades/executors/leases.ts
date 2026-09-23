import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExecutorConversationLeaseRecordSchema,
  ExecutorLeaseEndResponseSchema,
  ExecutorMachineLeaseRecordSchema,
  WsEventSchema,
  type ExecutorConversationLeaseRecord,
} from '@nessie/schemas'

import type { SseFrame } from '../../lib/sse'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useEventStream } from '../realtime/event-stream'
import { executorKeys } from './keys'

// Executor conversation leases: the holder's own, beside the composer, and a
// machine's, on its detail page (docs/plans/2026-09-22-executor-local-apps/
// conversation-lease.md §4). The server answers everyone but the holder with
// an empty list, so nothing here decides who may see a lease.

/** The longest a shown expiry is trusted before it is read again. */
const LEASE_RECHECK_MAX_MS = 5 * 60_000

/**
 * When to read the viewer's leases again without being told to. A lease's
 * window moves with every executor command, which publishes nothing, so a
 * shown "until" is re-read at the latest when it would pass — and a lease
 * really past it disappears then rather than lingering as a reach that is
 * gone. With nothing held there is nothing to expire, and the change notice
 * announces the next launch.
 */
export const executorLeaseRecheckDelay = (
  leases: readonly Pick<ExecutorConversationLeaseRecord, 'expiresAt'>[] | undefined,
  now = Date.now(),
): number | false => {
  if (!leases || leases.length === 0) return false
  const soonest = Math.min(...leases.map((lease) => Date.parse(lease.expiresAt)))
  return Math.min(Math.max(soonest - now + 1_000, 1_000), LEASE_RECHECK_MAX_MS)
}

/** `executor.lease.changed`, read off the shared per-session event stream. */
export const parseExecutorLeaseChangedFrame = (frame: SseFrame): { threadId: string } | null => {
  if (frame.event !== 'executor.lease.changed' || !frame.data) return null
  try {
    const parsed = WsEventSchema.safeParse(JSON.parse(frame.data))
    return parsed.success && parsed.data.event === 'executor.lease.changed'
      ? { threadId: parsed.data.data.threadId }
      : null
  } catch {
    // One malformed persisted event must not end the stream for everyone else.
    return null
  }
}

/**
 * The viewer's own live leases in one conversation. The notice arrives on the
 * holder's own user scope only, so a colleague in the same room never hears
 * of it — and would be answered with an empty list if they asked.
 */
export const useOwnExecutorLeases = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const onFrame = useCallback((frame: SseFrame) => {
    const changed = parseExecutorLeaseChangedFrame(frame)
    if (changed) void queryClient.invalidateQueries({ queryKey: executorKeys.conversationLeases(changed.threadId) })
  }, [queryClient])
  useEventStream({ enabled: Boolean(threadId), onFrame })
  return useQuery({
    // A lease reaches one conversation; another's must never stand beside this
    // composer, where it would claim a reach this room lacks and End it from here.
    placeholderData: undefined,
    queryKey: executorKeys.conversationLeases(threadId),
    queryFn: () => apiClient.get(
      `/api/executor-leases?threadId=${encodeURIComponent(threadId as string)}`,
      ExecutorConversationLeaseRecordSchema.array(),
    ),
    enabled: Boolean(threadId),
    refetchInterval: (query) => executorLeaseRecheckDelay(query.state.data),
  })
}

export const useExecutorMachineLeases = (executorId: string) => {
  const apiClient = useApiClient()
  return useQuery({
    // One machine's leases are never listed, or ended, from another's page.
    placeholderData: undefined,
    queryKey: executorKeys.machineLeases(executorId),
    queryFn: () => apiClient.get(
      `/api/executors/${executorId}/leases`,
      ExecutorMachineLeaseRecordSchema.array(),
    ),
  })
}

/** End, by the holder or by someone who manages the machine; both lists re-read. */
export const useEndExecutorLease = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (leaseId: string) => apiClient.post(
      `/api/executor-leases/${leaseId}/end`, {}, undefined, ExecutorLeaseEndResponseSchema,
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeys.all })
    },
  })
}
