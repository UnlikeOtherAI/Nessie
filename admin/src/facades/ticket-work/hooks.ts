import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
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
 * answered, and nothing announces it yet — so an open chip and a board
 * re-read while work on them is live, and the viewer's own move or status
 * change is followed by two late re-reads (`followTicketWorkAfterMove`), which
 * is when a pickup lands. An idle ticket or board asks nothing more, however
 * many columns could start work.
 */

export type { BoardTicketWorkRecord, TaskTicketWorkRecord, TicketWorkThreadGate }

const LIVE = new Set<string>(TICKET_WORK_LIVE_STATUSES)

/** How often an open ticket with live work re-reads its chip. */
export const TICKET_WORK_LIVE_POLL_MS = 10_000
/** How often a board with live work re-reads its badges and dots. */
export const BOARD_TICKET_WORK_POLL_MS = 20_000
/** After the viewer's own move: when the dispatcher has usually decided it, and a late backstop. */
export const TICKET_WORK_AFTER_MOVE_MS = [3_000, 10_000] as const

/**
 * A move or a status change may start, park or end work a moment after it
 * answered: re-read the ticket's chip and every board's badges then, instead
 * of polling a board forever for a pickup that may never happen.
 */
export const followTicketWorkAfterMove = (queryClient: QueryClient, taskId: string): void => {
  for (const delay of TICKET_WORK_AFTER_MOVE_MS) {
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.boardWorkAll })
      void queryClient.invalidateQueries({ queryKey: taskKeys.work(taskId) })
    }, delay)
  }
}

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
    // Only live work moves on its own; a pickup follows the viewer's own move.
    refetchInterval: (query) =>
      (query.state.data?.cards ?? []).some((card) => LIVE.has(card.status)) ? BOARD_TICKET_WORK_POLL_MS : false,
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

/**
 * Cancel the agent's pending reminder on a ticket's live work — the chip's
 * Cancel, offered only to a viewer who can edit the board, as the route asks.
 */
export const useCancelTicketWorkReminder = (taskId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reminderId: string) => apiClient.delete(`/api/tasks/${taskId}/work/reminders/${reminderId}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.work(taskId) }),
  })
}
