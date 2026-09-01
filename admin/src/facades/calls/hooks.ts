import {
  CallInviteUpdatedEventSchema,
  CallUpdatedEventSchema,
  type CallInviteUpdatedEvent,
  type CallUpdatedEvent,
} from '@nessie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { CallRecord } from '../../lib/api-client'
import { callKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { SseFrame } from '../../lib/sse'
import { useEventStream } from '../realtime/event-stream'

type CallRealtimeEvent =
  | { data: CallInviteUpdatedEvent; event: 'call.invite.updated' }
  | { data: CallUpdatedEvent; event: 'call.updated' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseCallRealtimeEvent = (frame: SseFrame): CallRealtimeEvent | null => {
  if (!frame.data || (frame.event !== 'call.invite.updated' && frame.event !== 'call.updated')) {
    return null
  }

  try {
    const envelope = JSON.parse(frame.data) as unknown
    if (!isRecord(envelope) || envelope.type !== 'event' || envelope.event !== frame.event) {
      return null
    }
    if (frame.event === 'call.invite.updated') {
      const parsed = CallInviteUpdatedEventSchema.safeParse(envelope.data)
      return parsed.success ? { data: parsed.data, event: frame.event } : null
    }
    const parsed = CallUpdatedEventSchema.safeParse(envelope.data)
    return parsed.success ? { data: parsed.data, event: frame.event } : null
  } catch {
    return null
  }
}

export const useActiveCall = (channelId: string | undefined) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const queryKey = callKeys.forChannel(channelId)

  const onFrame = useCallback((frame: SseFrame): void => {
    const event = parseCallRealtimeEvent(frame)
    if (!event) return

    queryClient.setQueryData<CallRecord | null>(queryKey, (call) => {
      if (!call || call.id !== event.data.callId || call.channelId !== channelId) return call
      if (event.data.revision < call.revision) return call

      if (event.event === 'call.updated') {
        return {
          ...call,
          meetingUri: event.data.meetingUri,
          revision: event.data.revision,
          status: event.data.status,
        }
      }

      return {
        ...call,
        invites: call.invites.map((invite) =>
          invite.userId === event.data.userId
            ? { ...invite, state: event.data.state }
            : invite,
        ),
        revision: event.data.revision,
      }
    })
  }, [channelId, queryClient, queryKey])

  useEventStream({ enabled: Boolean(channelId), onFrame })

  return useQuery<CallRecord | null>({
    queryKey,
    queryFn: async () => {
      try {
        return await apiClient.get<CallRecord | null>(
          `/api/channels/${channelId}/call`,
        )
      } catch {
        return null
      }
    },
    enabled: !!channelId,
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data ? 5_000 : 30_000),
  })
}

export const useStartCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.post<CallRecord>(`/api/channels/${channelId}/call`),
    onSuccess: (data, channelId) => {
      queryClient.setQueryData(callKeys.forChannel(channelId), data)
      void queryClient.invalidateQueries({ queryKey: callKeys.forChannel(channelId) })
    },
  })
}

export const useEndCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (channelId: string) =>
      apiClient.delete<CallRecord>(`/api/channels/${channelId}/call`),
    onSuccess: (_data, channelId) => {
      void queryClient.invalidateQueries({ queryKey: callKeys.forChannel(channelId) })
    },
  })
}

export const useCancelCall = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (callId: string) =>
      apiClient.post<CallRecord>(`/api/calls/${callId}/cancel`, {}),
    onSuccess: (data) => {
      queryClient.setQueryData(callKeys.forChannel(data.channelId), data)
      void queryClient.invalidateQueries({ queryKey: callKeys.forChannel(data.channelId) })
    },
  })
}
