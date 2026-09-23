import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  TICKET_WORK_LIVE_STATUSES,
  type BoardTicketWorkRecord,
  type TaskTicketWorkRecord,
  type TicketWorkThreadGate,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { taskKeys } from '../tasks/keys'
import { threadKeys } from '../threads/keys'

/**
 * What the project sees of an agent's ticket work
 * (docs/standards/ticket-work.md → "What the project sees"): the ticket
 * dialog's chip, the board's column badges and card dots, and whether a work
 * thread's reader may write in it. Each read is the ticket's, board's or
 * thread's own; none needs the owner-only Triggers routes.
 *
 * Work moves in the worker, after the move that started it has already
 * answered, and nothing announces it yet — so an open chip re-reads while its
 * work is live, and a board re-reads while anything on it can start or is
 * doing work. An idle ticket or board asks nothing more: a move from the
 * dialog closes it, and the next open reads fresh.
 */

export type { BoardTicketWorkRecord, TaskTicketWorkRecord, TicketWorkThreadGate }

const LIVE = new Set<string>(TICKET_WORK_LIVE_STATUSES)

/** How often an open ticket with live work re-reads its chip. */
export const TICKET_WORK_LIVE_POLL_MS = 10_000
/** How often a board with start-work columns re-reads its badges and dots. */
export const BOARD_TICKET_WORK_POLL_MS = 20_000

export const useTaskTicketWork = (taskId?: string) => {
  const apiClient = useApiClient()
  return useQuery<TaskTicketWorkRecord>({
    queryKey: taskKeys.work(taskId),
    queryFn: () => apiClient.get(`/api/tasks/${taskId}/work`),
    enabled: Boolean(taskId),
    refetchInterval: (query) =>
      query.state.data?.records.some((record) => LIVE.has(record.status)) ? TICKET_WORK_LIVE_POLL_MS : false,
  })
}

export const useBoardTicketWork = (projectId?: string, boardId?: string) => {
  const apiClient = useApiClient()
  return useQuery<BoardTicketWorkRecord>({
    placeholderData: keepPreviousData,
    queryKey: taskKeys.boardWork(projectId, boardId),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/boards/${boardId}/ticket-work`),
    enabled: Boolean(projectId && boardId),
    // A board nothing starts work from, and no work is live on, has nothing to watch.
    refetchInterval: (query) =>
      (query.state.data?.pickups.length ?? 0) > 0
      || (query.state.data?.cards ?? []).some((card) => LIVE.has(card.status))
        ? BOARD_TICKET_WORK_POLL_MS
        : false,
  })
}

/** Null data: an ordinary thread. Asked only for a conversation that names a ticket. */
export const useTicketWorkThreadGate = (threadId: string | null | undefined, enabled: boolean) => {
  const apiClient = useApiClient()
  return useQuery<TicketWorkThreadGate | null>({
    queryKey: threadKeys.ticketWork(threadId ?? undefined),
    queryFn: () => apiClient.get(`/api/threads/${threadId}/ticket-work`),
    enabled: enabled && Boolean(threadId),
  })
}
