import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  CloudBrowserConnectionRecord,
  CloudBrowserScope,
  CloudBrowserSessionDetail,
  CloudBrowserSessionSummary,
} from '../../lib/api-client'
import { browserCloudKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useCloudBrowserConnections = () => {
  const apiClient = useApiClient()
  return useQuery<{ connections: CloudBrowserConnectionRecord[] }>({
    queryKey: browserCloudKeys.connections,
    queryFn: () => apiClient.get('/api/browser-cloud/connections'),
  })
}

export type ConnectCloudBrowserInput = {
  scope: CloudBrowserScope
  apiKey: string
  projectId: string
}

export const useConnectCloudBrowser = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ConnectCloudBrowserInput) =>
      apiClient.post<{ id: string }>('/api/browser-cloud/connections', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: browserCloudKeys.connections })
    },
  })
}

export const useDisconnectCloudBrowser = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.delete<void>(`/api/browser-cloud/connections/${connectionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: browserCloudKeys.connections })
    },
  })
}

/**
 * Live sessions in a thread. Polled rather than pushed in phase 1: the panel
 * is only mounted while somebody is looking at it, and a session's lifetime is
 * minutes, so a short poll costs less than a new realtime event family.
 */
export const useThreadBrowserSessions = (threadId: string | null) => {
  const apiClient = useApiClient()
  return useQuery<{ sessions: CloudBrowserSessionSummary[] }>({
    queryKey: browserCloudKeys.threadSessions(threadId ?? undefined),
    queryFn: () =>
      apiClient.get(`/api/threads/${threadId}/browser-sessions?active=1`),
    enabled: threadId !== null,
    refetchInterval: 5_000,
  })
}

/**
 * The live view URL is minted per read, so this refetches on an interval
 * rather than caching: a stale URL points at a session that may be gone.
 */
export const useCloudBrowserSession = (sessionId: string | null) => {
  const apiClient = useApiClient()
  return useQuery<CloudBrowserSessionDetail>({
    queryKey: browserCloudKeys.session(sessionId ?? undefined),
    queryFn: () => apiClient.get(`/api/browser-sessions/${sessionId}`),
    enabled: sessionId !== null,
    refetchInterval: 15_000,
    staleTime: 0,
  })
}
