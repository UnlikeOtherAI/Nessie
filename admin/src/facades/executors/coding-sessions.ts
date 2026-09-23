import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExecutorCodingSessionCloseAcceptedSchema,
  ExecutorCodingSessionListResponseSchema,
  type ExecutorCodingSessionCloseBody,
  type ExecutorCodingSessionListResponse,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { executorKeys } from './keys'

// The coding sessions open on one machine, listed in its Local apps section
// (docs/executor-protocol/host-coding-sessions.md → "The executor page"). The
// server decides who may read the list, who may Close, and which driving
// agent it may name, so nothing here decides any of them.

/**
 * How soon to read the list again while a Close waits for the machine. The
 * request rides the next heartbeat (every 20 s) and the session leaves the
 * list with the next local-MCP report, so "Closing…" is re-read at the
 * heartbeat's pace and goes when the report drops it. With nothing closing
 * there is nothing to wait for.
 */
export const EXECUTOR_CODING_SESSION_CLOSING_RECHECK_MS = 20_000

export const executorCodingSessionsRecheckDelay = (
  list: Pick<ExecutorCodingSessionListResponse, 'sessions'> | undefined,
): number | false => list?.sessions.some((session) => session.closing)
  ? EXECUTOR_CODING_SESSION_CLOSING_RECHECK_MS
  : false

export const useExecutorCodingSessions = (executorId: string) => {
  const apiClient = useApiClient()
  return useQuery({
    // One machine's sessions are never listed, or closed, from another's page.
    placeholderData: undefined,
    queryKey: executorKeys.codingSessions(executorId),
    queryFn: () => apiClient.get(
      `/api/executors/${executorId}/coding-sessions`,
      ExecutorCodingSessionListResponseSchema,
    ),
    refetchInterval: (query) => executorCodingSessionsRecheckDelay(query.state.data),
  })
}

/**
 * The pairing owner's Close on one session. It stays pending until the list
 * has been read again, so the row goes straight from the press to the
 * server's "Closing…" — and a refusal because the session already left the
 * report re-reads the list too, which drops it.
 */
export const useCloseExecutorCodingSession = (executorId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (session: ExecutorCodingSessionCloseBody) => apiClient.post(
      `/api/executors/${executorId}/coding-sessions/close`,
      session,
      undefined,
      ExecutorCodingSessionCloseAcceptedSchema,
    ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: executorKeys.codingSessions(executorId) }),
  })
}
