import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ExecutorRecordResponse, ExecutorStatusChanged } from '@nessie/schemas'
import { subscribeAgentActivity } from '../agents/activity-socket'
import { executorKeys } from './keys'

export const patchExecutorStatus = (
  current: ExecutorRecordResponse, update: ExecutorStatusChanged,
): ExecutorRecordResponse => {
  if (current.id !== update.executorId || current.updatedAt > update.updatedAt) return current
  return {
    ...current, status: update.status, updatedAt: update.updatedAt,
    lastSeenAt: update.lastSeenAt ?? undefined, statusDetail: update.statusDetail ?? undefined,
  }
}

/** One shell subscription updates the inventory and every mounted detail view. */
export const subscribeExecutorRealtime = (queryClient: QueryClient, token: string, organizationId: string) =>
  subscribeAgentActivity(token, {
    scope: { channelIds: [], dashboardIds: [], organizationId, executorInventory: true },
    onState: () => undefined,
    onMessage: (message) => {
      if (message.type === 'subscribed'
        || (message.type === 'event' && message.event === 'executor.inventory.changed')) {
        // Live-only presence has no replay log. Re-read after every handshake to
        // recover disconnects and permission changes, including a removed assignment.
        void queryClient.invalidateQueries({ queryKey: executorKeys.all })
        return
      }
      if (message.type !== 'event' || message.event !== 'executor.status.changed') return
      const update = message.data
      const current = queryClient.getQueryData<ExecutorRecordResponse[]>(executorKeys.all)
      if (current && !current.some((executor) => executor.id === update.executorId) && !update.removed) {
        void queryClient.invalidateQueries({ queryKey: executorKeys.all })
        return
      }
      queryClient.setQueryData<ExecutorRecordResponse[]>(executorKeys.all, (records) => records
        ?.filter((record) => !(update.removed && record.id === update.executorId
          && record.updatedAt <= update.updatedAt))
        .map((record) => patchExecutorStatus(record, update)))
      if (update.removed) {
        void queryClient.invalidateQueries({ queryKey: executorKeys.detail(update.executorId) })
      }
    },
  })

export const useExecutorRealtime = (token: string | null, organizationId: string | undefined): void => {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!token || !organizationId) return
    return subscribeExecutorRealtime(queryClient, token, organizationId).unsubscribe
  }, [organizationId, queryClient, token])
}
