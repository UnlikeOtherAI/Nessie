import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExecutorCodingSessionCloseAcceptedSchema,
  ExecutorCodingSessionListResponseSchema,
  ExecutorSessionViewResponseSchema,
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
 * How often the list is read again while it is on screen. It is the
 * machine's last local-MCP report, which any heartbeat (every 20 s) may
 * replace, so an open section follows it at that pace: a session that ended
 * leaves, one that started arrives, "Closing…" goes when the report drops the
 * row, and each row's age moves on. Nothing is read while the section is not
 * mounted or the tab is in the background.
 */
export const EXECUTOR_CODING_SESSIONS_RECHECK_MS = 20_000

export const useExecutorSessionView = (executorId: string, sessionId: string) => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorKeys.sessionView(executorId, sessionId),
    queryFn: () => apiClient.get(
      `/api/executors/${executorId}/coding-sessions/${sessionId}/view`, ExecutorSessionViewResponseSchema,
    ),
    enabled: Boolean(executorId && sessionId),
    placeholderData: undefined,
    gcTime: 0,
    retry: false,
    refetchInterval: 1_000,
  })
}

export const useExecutorCodingSessions = (executorId: string) => {
  const apiClient = useApiClient()
  return useQuery({
    // One machine's sessions are never listed, or closed, from another's page.
    placeholderData: undefined,
    queryKey: executorKeys.codingSessions(executorId),
    queryFn: (): Promise<ExecutorCodingSessionListResponse> => apiClient.get(
      `/api/executors/${executorId}/coding-sessions`,
      ExecutorCodingSessionListResponseSchema,
    ),
    refetchInterval: EXECUTOR_CODING_SESSIONS_RECHECK_MS,
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
