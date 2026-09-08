import { useMemo } from 'react'
import {
  infiniteQueryOptions,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query'
import type {
  AgentModelOption,
  AgentActivityResponse,
  AgentChild,
  AgentConversationRecord,
  AgentDocumentsResponse,
  AgentMessagePage,
  AgentStatusResponse,
  ApiResponse,
  ToolCallEntry,
} from '@nessie/schemas'
import type { AgentRecord, ApiClient } from '../../lib/api-client'
import { agentKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type AgentListScope = 'all' | 'visible'

export type PausedPrivateAgentCount = { count: number }

/**
 * The agents the caller is entitled to see. Default (`visible`) is the
 * non-system list every surface has always used. `all` additionally pulls the
 * read-only system tier (Personal Assistant + `systemManaged` agents) via
 * `?scope=all`, for the Agents page's Personal / Global tabs; it is cached
 * under its own key so it never overwrites the default list the rest of the app
 * reads.
 */
export const useAgents = (options?: { scope?: AgentListScope }) => {
  const apiClient = useApiClient()
  const scope = options?.scope ?? 'visible'

  return useQuery<AgentRecord[]>({
    queryKey: scope === 'all' ? agentKeys.allScopes : agentKeys.all,
    queryFn: () =>
      apiClient.get(scope === 'all' ? '/api/agents?scope=all' : '/api/agents'),
  })
}

/**
 * The agents a channel can hold: the ordinary list, plus the app-provided
 * shared agents (the Agent Designer, the Librarian) that `bindAgentToChannel`
 * now places like any other.
 *
 * `GET /api/agents` omits every `systemManaged` row, so the members popup, the
 * channel roster and the @mention typeahead were all structurally blind to a
 * global agent — the same defect class as the address book. `?scope=all` is the
 * superset, and the identity directory already holds that exact query, so this
 * costs no extra request.
 *
 * The filter is `surfacePolicy`, which is precisely this question in the
 * record: `dm_only` is the Personal Assistant (added through its own presence
 * control) and an external-agent product (added by its integration), which are
 * exactly the two agents `isChannelBindableAgent` refuses on the server. One
 * sentence, both sides.
 */
export const useChannelPlaceableAgents = () => {
  const visible = useAgents()
  const allScopes = useAgents({ scope: 'all' })

  const data = useMemo(() => {
    const rows = visible.data ?? []
    if (!allScopes.data) return rows
    const known = new Set(rows.map((agent) => agent.id))
    return [
      ...rows,
      ...allScopes.data.filter((agent) =>
        !known.has(agent.id)
        && agent.systemManaged === true
        && agent.surfacePolicy !== 'dm_only'),
    ]
  }, [allScopes.data, visible.data])

  // Only the ordinary list decides pending/error: the system tier is additive,
  // so a failed `scope=all` read must degrade to today's list rather than blank
  // a channel roster that has nothing to do with global agents.
  return { data, isError: visible.isError, isPending: visible.isPending }
}

/** Owner-only aggregate for the Members tree; it never fetches private rows. */
export const usePausedPrivateAgentCount = (enabled: boolean) => {
  const apiClient = useApiClient()

  return useQuery<PausedPrivateAgentCount>({
    enabled,
    queryKey: agentKeys.pausedPrivateCount,
    queryFn: () => apiClient.get('/api/agents/paused-private-count'),
  })
}

export const useAgentModelOptions = () => {
  const apiClient = useApiClient()

  return useQuery<AgentModelOption[]>({
    queryKey: agentKeys.models,
    queryFn: () => apiClient.get('/api/agents/models'),
    staleTime: 60_000,
  })
}

/** Shared with `navigation/prewarm.ts`; see `fetchThreadMessages` for why. */
export const fetchAgentStatus = (
  apiClient: ApiClient,
  agentId: string,
): Promise<AgentStatusResponse> => apiClient.get(`/api/agents/${agentId}/status`)

export const useAgentStatus = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentStatusResponse>({
    placeholderData: keepPreviousData,
    queryKey: agentKeys.status(agentId),
    queryFn: () => fetchAgentStatus(apiClient, agentId ?? ''),
    enabled: Boolean(agentId),
  })
}

export const useAgentActivity = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentActivityResponse>({
    placeholderData: keepPreviousData,
    queryKey: agentKeys.activity(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/activity`),
    enabled: Boolean(agentId),
  })
}

export const useAgentMessages = (agentId?: string, limit = 25, offset = 0) => {
  const apiClient = useApiClient()

  return useQuery<AgentMessagePage>({
    placeholderData: keepPreviousData,
    queryKey: agentKeys.messagePage(agentId, limit, offset),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/messages?limit=${limit}&offset=${offset}`),
    enabled: Boolean(agentId),
  })
}

export const useAgentChildren = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentChild[]>({
    placeholderData: keepPreviousData,
    queryKey: agentKeys.children(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/children`),
    enabled: Boolean(agentId),
  })
}

export const useAgentDocuments = (agentId?: string) => {
  const apiClient = useApiClient()

  return useQuery<AgentDocumentsResponse>({
    placeholderData: keepPreviousData,
    queryKey: agentKeys.documents(agentId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/docs`),
    enabled: Boolean(agentId),
  })
}

export type AgentConversationPage = ApiResponse<AgentConversationRecord[]>
export type AgentConversationPages = InfiniteData<AgentConversationPage, string | undefined>

const agentConversationsPath = (agentId: string, cursor?: string): string => {
  const search = new URLSearchParams()
  if (cursor) search.set('cursor', cursor)
  const suffix = search.size > 0 ? `?${search.toString()}` : ''
  return `/api/agents/${encodeURIComponent(agentId)}/conversations${suffix}`
}

/**
 * The keyset page contract for an agent's conversations, in one place: the
 * rail's column and the agent page's tab are the same list, so they must not
 * describe it twice.
 */
export const agentConversationsInfiniteQueryOptions = (
  apiClient: ApiClient,
  agentId: string,
) => infiniteQueryOptions<
  AgentConversationPage,
  Error,
  AgentConversationPages,
  ReturnType<typeof agentKeys.conversations>,
  string | undefined
>({
  getNextPageParam: (lastPage) =>
    lastPage.meta?.hasMore ? lastPage.meta.nextCursor ?? undefined : undefined,
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    apiClient.getPage<AgentConversationRecord[]>(agentConversationsPath(agentId, pageParam)),
  queryKey: agentKeys.conversations(agentId),
})

/** Every page fetched so far, in the order the server returned them. */
export const flattenAgentConversationPages = (
  pages: AgentConversationPages | undefined,
): AgentConversationRecord[] => {
  if (!pages) return []
  const byId = new Map<string, AgentConversationRecord>()
  for (const page of pages.pages) {
    for (const conversation of page.data) {
      if (!byId.has(conversation.id)) byId.set(conversation.id, conversation)
    }
  }
  return [...byId.values()]
}

/**
 * The conversations this agent is in that the caller may see.
 *
 * The caller picks the cadence from what it is doing with the answer, exactly
 * as `useThreadBrowserSessions` does: `RAIL_POLL_MS` for a rail dot,
 * `WATCHING_POLL_MS` while the column is open. `placeholderData` is
 * `keepPreviousData` because the key carries an id — switching agents must not
 * blank a list that is about to be replaced.
 */
export const useAgentConversations = (
  agentId?: string,
  options: { enabled?: boolean; refetchInterval?: number } = {},
) => {
  const apiClient = useApiClient()

  const query = useInfiniteQuery({
    ...agentConversationsInfiniteQueryOptions(apiClient, agentId ?? ''),
    enabled: Boolean(agentId) && (options.enabled ?? true),
    placeholderData: keepPreviousData,
    ...(options.refetchInterval === undefined
      ? {}
      : { refetchInterval: options.refetchInterval }),
  })
  const conversations = useMemo(
    () => flattenAgentConversationPages(query.data),
    [query.data],
  )
  return { ...query, data: conversations }
}

export const useRunToolCalls = (agentId?: string, runId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ToolCallEntry[]>({
    placeholderData: keepPreviousData,
    queryKey: agentKeys.runTools(agentId, runId),
    queryFn: () => apiClient.get(`/api/agents/${agentId}/runs/${runId}/tools`),
    enabled: Boolean(agentId && runId),
  })
}
