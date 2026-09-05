import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { SseFrame } from '../../lib/sse'
import { alertKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useEventStream } from '../realtime/event-stream'

export type UserAlertRecord = {
  id: string
  kind:
    | 'mention'
    | 'task_assigned'
    | 'knowledge_published'
    | 'trigger_health'
    | 'call_missed'
    | 'team_invitation'
    | 'approval_requested'
    | 'automatic_membership_health'
    | 'board_source_health'
  messageId: string | null
  rootMessageId: string | null
  threadId: string | null
  channelId: string | null
  channelLabel: string | null
  projectId: string | null
  taskId: string | null
  knowledgePageId: string | null
  triggerId: string | null
  boardSourceId: string | null
  metadata: {
    inviteId: string
    organizationId: string
    teamId: string
    teamName: string
    invitedBy?: string
    expiresAt?: string
  } | null
  actorUserId: string | null
  actorAgentId: string | null
  actorDisplayName: string | null
  readAt: string | null
  createdAt: string
}

export type AttentionSummary = {
  assignedWork: AttentionSummarySection
  knowledge: AttentionSummarySection
  unreadCount: number
}

type AttentionSummarySection = {
  projects: Record<string, number>
  total: number
  versions?: Record<string, string>
}

/**
 * A page of alerts. The endpoint answers the shared paged-list contract, so
 * `data` is the array itself; the unread count is the attention summary's
 * answer (`useAttentionSummary`), never a field inside a page.
 */
export type AlertsListResponse = UserAlertRecord[]

type MarkAlertsReadResponse = {
  read: number
  unreadCount: number
}

const ATTENTION_REFRESH_MS = 15_000

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
// limit up front instead. The full-page list uses `usePagedList`, which reads
// the same route through `getPage` and keeps the cursors.
export const useAlerts = (options?: { limit?: number; unreadOnly?: boolean }) => {
  const apiClient = useApiClient()
  const limit = options?.limit ?? 50
  const unreadOnly = options?.unreadOnly ?? false

  return useQuery<AlertsListResponse>({
    queryKey: alertKeys.list(limit, unreadOnly),
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (unreadOnly) {
        params.set('unread', 'true')
      }
      return apiClient.get(`/api/alerts?${params.toString()}`)
    },
    refetchInterval: ATTENTION_REFRESH_MS,
  })
}

export const useAttentionSummary = () => {
  const apiClient = useApiClient()
  return useQuery<AttentionSummary>({
    queryKey: alertKeys.summary,
    queryFn: () => apiClient.get('/api/alerts/summary'),
    refetchInterval: ATTENTION_REFRESH_MS,
  })
}

export const useMarkAlertsRead = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      ids?: string[]
      all?: boolean
      surface?: {
        kind: 'task_assigned' | 'knowledge_published'
        projectId: string
      }
    }) =>
      apiClient.post<MarkAlertsReadResponse>(
        '/api/alerts/read',
        input.all ? { all: true } : input.surface ? { surface: input.surface } : { ids: input.ids ?? [] },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: alertKeys.all })
    },
  })
}

// Live badge updates: alert.created / alert.read frames are per-recipient on
// the shared events stream, so only frames for the signed-in user invalidate.
export const useAlertEvents = (): void => {
  const queryClient = useQueryClient()
  const { me } = useAuthSession()
  const currentUserId = me?.user.id

  const onFrame = useCallback((frame: SseFrame): void => {
    try {
      if (
        !currentUserId
        || !frame.data
        || (frame.event !== 'alert.created' && frame.event !== 'alert.read')
      ) {
        return
      }

      const data = parseAlertEventData(frame.data)
      if (data && data.userId === currentUserId) {
        void queryClient.invalidateQueries({ queryKey: alertKeys.all })
      }
    } catch {
      // A malformed event must not break the stream.
    }
  }, [currentUserId, queryClient])

  useEventStream({ enabled: Boolean(currentUserId), onFrame })
}

// Deep-link target for an alert. Every durable attention kind has one owning
// surface, so the bell and /alerts list never turn a user action into a dead
// row that merely marks itself read.
export const getAlertLink = (
  alert: UserAlertRecord,
): { to: string; state?: { highlightMessageId: string } } | null => {
  if (alert.kind === 'trigger_health' && alert.triggerId) {
    // The Triggers page selects by hash, so the row opens the schedule that
    // stopped rather than a list the reader has to search.
    return { to: `/agents/triggers#${alert.triggerId}` }
  }
  if (alert.kind === 'board_source_health' && alert.projectId && alert.boardSourceId) {
    // Straight to the source that stopped, with its remedy on screen — not to
    // a settings page the reader then has to search.
    return {
      to: `/projects/${alert.projectId}/settings?section=sources&source=${alert.boardSourceId}`,
    }
  }
  if (alert.kind === 'task_assigned' && alert.projectId) {
    return { to: `/projects/${alert.projectId}/board` }
  }
  if (alert.kind === 'knowledge_published' && alert.projectId && alert.knowledgePageId) {
    return { to: `/projects/${alert.projectId}/docs?pageId=${alert.knowledgePageId}` }
  }
  if (alert.kind === 'call_missed' && alert.channelId) {
    // A missed call belongs to its channel's call record/message, never to a
    // reply thread. Keep this separate from generic mentions so this durable
    // attention kind has an explicit owning surface.
    return {
      to: `/channels/${alert.channelId}`,
      state: alert.messageId ? { highlightMessageId: alert.messageId } : undefined,
    }
  }
  if (alert.channelId) {
    if (alert.threadId && alert.rootMessageId) {
      return { to: `/channels/${alert.channelId}/threads/${alert.threadId}/replies/${alert.rootMessageId}` }
    }
    return {
      to: `/channels/${alert.channelId}`,
      state: alert.messageId ? { highlightMessageId: alert.messageId } : undefined,
    }
  }
  return null
}
