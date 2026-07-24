import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { getBaseUrl } from '../../lib/api-client'
import { readSseStream } from '../../lib/sse'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export type UserAlertRecord = {
  id: string
  kind: 'mention'
  messageId: string | null
  threadId: string | null
  channelId: string | null
  channelLabel: string | null
  actorUserId: string | null
  actorAgentId: string | null
  actorDisplayName: string | null
  readAt: string | null
  createdAt: string
}

export type AlertsListResponse = {
  alerts: UserAlertRecord[]
  unreadCount: number
}

type MarkAlertsReadResponse = {
  read: number
  unreadCount: number
}

const RECONNECT_DELAY_MS = 2_000

const baseUrl = getBaseUrl()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Event frames on /api/events/stream carry the full realtime envelope
// ({ type: 'event', event, data, ts }); the alert payload sits in `data`.
const parseAlertEventData = (frameData: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(frameData) as unknown
    if (!isRecord(parsed)) {
      return null
    }
    if (parsed.type === 'event' && isRecord(parsed.data)) {
      return parsed.data
    }
    return parsed
  } catch {
    return null
  }
}

// The shared apiClient unwraps the { data, meta } envelope and returns only
// `data`, so pagination cursors are not reachable through it — callers pick a
// limit up front instead.
export const useAlerts = (options?: { limit?: number; unreadOnly?: boolean }) => {
  const apiClient = useApiClient()
  const limit = options?.limit ?? 50
  const unreadOnly = options?.unreadOnly ?? false

  return useQuery<AlertsListResponse>({
    queryKey: ['alerts', { limit, unreadOnly }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (unreadOnly) {
        params.set('unread', 'true')
      }
      return apiClient.get(`/api/alerts?${params.toString()}`)
    },
  })
}

export const useMarkAlertsRead = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { ids?: string[]; all?: boolean }) =>
      apiClient.post<MarkAlertsReadResponse>(
        '/api/alerts/read',
        input.all ? { all: true } : { ids: input.ids ?? [] },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    },
  })
}

// Live badge updates: alert.created / alert.read frames are per-recipient on
// the shared events stream, so only frames for the signed-in user invalidate.
export const useAlertEvents = (): void => {
  const queryClient = useQueryClient()
  const { me, token } = useAuthSession()
  const currentUserId = me?.user.id

  useEffect(() => {
    if (!currentUserId || !token) {
      return
    }

    let cancelled = false
    let lastEventId = ''
    let activeController: AbortController | null = null

    const handleFrame = (frameData: string): void => {
      const data = parseAlertEventData(frameData)
      if (!data || data.userId !== currentUserId) {
        return
      }
      void queryClient.invalidateQueries({ queryKey: ['alerts'] })
    }

    const connectStream = async (): Promise<void> => {
      while (!cancelled) {
        const controller = new AbortController()
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

          await readSseStream(response.body, (frame) => {
            try {
              if (frame.id) {
                lastEventId = frame.id
              }
              if (
                (frame.event === 'alert.created' || frame.event === 'alert.read')
                && frame.data
              ) {
                handleFrame(frame.data)
              }
            } catch {
              // A malformed event must not break the stream.
            }
          })
        } catch {
          // Connection lost or rejected; retry below while signed in.
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
  }, [currentUserId, queryClient, token])
}

// Deep-link target for an alert: the channel route plus the message id to
// highlight (consumed and cleared by ChannelsPage). Null when the alert has
// no channel to open.
export const getAlertLink = (
  alert: UserAlertRecord,
): { to: string; state?: { highlightMessageId: string } } | null => {
  if (!alert.channelId) {
    return null
  }
  return {
    to: `/channels/${alert.channelId}`,
    state: alert.messageId ? { highlightMessageId: alert.messageId } : undefined,
  }
}
