import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  AgentBrowserRecord,
  AgentBrowserTabsResponse,
  CloudBrowserConnectionRecord,
  CloudBrowserScope,
  CloudBrowserSessionDetail,
  CloudBrowserSessionSummary,
  MyBrowserLoginRecord,
} from '../../lib/api-client'
import { browserCloudKeys } from './keys'
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
  /** Required at team scope. */
  teamId?: string
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

/** With the panel open: a browser that has just started must appear quickly. */
export const WATCHING_POLL_MS = 5_000
/** With it closed: the rail's dot can afford to be a little behind. */
export const RAIL_POLL_MS = 20_000

/**
 * Live sessions in a thread. Polled rather than pushed in phase 1: a session's
 * lifetime is minutes, so a short poll costs less than a new realtime event
 * family. The caller picks the rate from what it is doing with the answer.
 */
export const useThreadBrowserSessions = (
  threadId: string | null,
  options: { enabled?: boolean; refetchInterval?: number } = {},
) => {
  const apiClient = useApiClient()
  return useQuery<{ sessions: CloudBrowserSessionSummary[] }>({
    queryKey: browserCloudKeys.threadSessions(threadId ?? undefined),
    queryFn: () =>
      apiClient.get(`/api/threads/${threadId}/browser-sessions?active=1`),
    enabled: threadId !== null && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? WATCHING_POLL_MS,
    placeholderData: keepPreviousData,
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
    placeholderData: keepPreviousData,
  })
}

export const useAgentBrowser = (agentId: string | null) => {
  const apiClient = useApiClient()
  return useQuery<{ browser: AgentBrowserRecord | null }>({
    queryKey: browserCloudKeys.agentBrowser(agentId ?? undefined),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/browser`),
    enabled: agentId !== null,
    // Switching agents keeps the previous browser record painted rather than
    // blanking the panel between answers.
    placeholderData: keepPreviousData,
  })
}

/**
 * Where the agent's browser left off. Mounted only by the panel's idle face,
 * and always refetched on mount rather than served from the five-minute
 * cache: the face appears exactly when a session has just ended, which is
 * when these rows have just changed. Keyed by thread as well as agent because
 * the route authorizes through the thread.
 */
export const useAgentBrowserTabs = (threadId: string | null, agentId: string | null) => {
  const apiClient = useApiClient()
  return useQuery<AgentBrowserTabsResponse>({
    queryKey: browserCloudKeys.agentBrowserTabs(threadId ?? undefined, agentId ?? undefined),
    queryFn: () => apiClient.get(`/api/threads/${threadId}/agents/${agentId}/browser/tabs`),
    enabled: threadId !== null && agentId !== null,
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
  })
}

/**
 * Bring the browser back the way it was left. The thread's session list is
 * what the panel watches, so invalidating it is what swaps the idle face for
 * the live one. The face renders the failure itself, so `onError` is set to
 * keep the shell's generic toast from saying it a second time.
 */
export const useResumeAgentBrowser = (threadId: string | null, agentId: string | null) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ sessionId: string; restoredTabs: number }>(
        `/api/threads/${threadId}/agents/${agentId}/browser/resume`,
        {},
      ),
    onError: () => undefined,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: browserCloudKeys.threadSessions(threadId ?? undefined),
      })
    },
  })
}

/**
 * "Done" on a resumed session: the browser saves where it is and stops. Both
 * the session list and the stored tabs change, so both are refetched.
 */
export const useEndResumedSession = (threadId: string | null, agentId: string | null) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => apiClient.delete<void>(`/api/browser-sessions/${sessionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: browserCloudKeys.threadSessions(threadId ?? undefined),
      })
      void queryClient.invalidateQueries({
        queryKey: browserCloudKeys.agentBrowserTabs(threadId ?? undefined, agentId ?? undefined),
      })
    },
  })
}

export const useResetAgentBrowser = (agentId: string | null) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<void>(`/api/agents/${agentId}/browser/reset`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: browserCloudKeys.agentBrowser(agentId ?? undefined),
      })
      void queryClient.invalidateQueries({ queryKey: browserCloudKeys.myLogins })
    },
  })
}

/** Every sign-in this person performed, so revoking never means hunting. */
export const useMyBrowserLogins = () => {
  const apiClient = useApiClient()
  return useQuery<{ logins: MyBrowserLoginRecord[] }>({
    queryKey: browserCloudKeys.myLogins,
    queryFn: () => apiClient.get('/api/browser-cloud/my-logins'),
  })
}

/**
 * Take the controls, and keep them.
 *
 * The claim expires without a heartbeat so a closed laptop cannot hold a
 * team's browser hostage; this renews it while the viewer is mounted and
 * hands back on unmount.
 */
export const useBrowserControl = (sessionId: string | null) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const [controlling, setControlling] = useState(false)

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: browserCloudKeys.session(sessionId ?? undefined),
    })
  }

  const take = useMutation({
    mutationFn: () =>
      apiClient.post<{ controlling: boolean }>(`/api/browser-sessions/${sessionId}/control`, {}),
    onSuccess: () => {
      setControlling(true)
      invalidate()
    },
  })

  const handBack = useMutation({
    mutationFn: () => apiClient.delete<void>(`/api/browser-sessions/${sessionId}/control`),
    onSuccess: () => {
      setControlling(false)
      invalidate()
    },
  })

  useEffect(() => {
    if (!controlling || !sessionId) return undefined
    const timer = window.setInterval(() => {
      void apiClient.post(`/api/browser-sessions/${sessionId}/control`, {}).catch(() => {
        // A lost renewal simply lets the claim lapse, which is the safe end.
        setControlling(false)
      })
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [apiClient, controlling, sessionId])

  // Handing back on unmount matters more than it looks: a person who closes
  // the panel mid-claim would otherwise block the agent until the TTL. Read
  // through a ref so this runs once, at unmount — with `controlling` in the
  // dependencies it also ran on every hand-back, sending the release twice.
  const controllingRef = useRef(controlling)
  controllingRef.current = controlling
  useEffect(() => () => {
    if (!controllingRef.current || !sessionId) return
    void apiClient.delete(`/api/browser-sessions/${sessionId}/control`).catch(() => undefined)
  }, [apiClient, sessionId])

  return {
    controlling,
    error: take.error,
    handBack: () => handBack.mutate(),
    pending: take.isPending || handBack.isPending,
    take: () => take.mutate(),
  }
}
