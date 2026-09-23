import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiClientError } from '@nessie/client-core'
import {
  ChannelDirectoryEntrySchema,
  ProjectDirectoryEntrySchema,
  type AgentRecord,
  type AppSummaryRecord,
  type ChannelDirectoryEntry,
  type ProjectDirectoryEntry,
} from '@nessie/schemas'
import type {
  MessageSearchResult,
  UserRecord,
} from '../../lib/api-client'
import type { TaskRecord } from '../tasks/hooks'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { searchKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useUsers } from '../users/hooks'
import { useAgents } from '../agents/queries'
import { useApps } from '../apps/hooks'
import { usePagedList, usePagedListReset, type PagedList } from '../pagination/usePagedList'

const MIN_QUERY_LENGTH = 2
const MAX_QUERY_LENGTH = 200
const DEBOUNCE_MS = 250
const SEARCH_MODE_STORAGE_KEY = 'nessie.search.mode'

export const GLOBAL_SEARCH_MODES = ['fulltext', 'semantic'] as const

export type GlobalSearchMode = (typeof GLOBAL_SEARCH_MODES)[number]

// A passage of a knowledge page matched by hybrid search, with its position in
// the source page and a per-passage relevance score (ranking metadata only —
// never rendered directly).
export interface KnowledgeSearchPassage {
  content: string
  startOffset: number
  endOffset: number
  score: number
}

// Shape returned by POST /api/knowledge-base/search — one hit per readable page.
// `passages` and `score` are only populated in hybrid mode.
export interface KnowledgeSearchHit {
  page: {
    id: string
    spaceId: string
    title: string
    summary: string | null
  }
  snippet: string
  passages?: KnowledgeSearchPassage[]
  score?: number
}

// Shape returned by POST /api/thoughts/search for semantic memory recall.
export interface ThoughtSearchHit {
  id: string
  content: string
  ownerType: string
  visibility: string
  importance: number
  metadata: unknown
  similarity: number
  createdAt: string
  rankPosition: number
  retrievalMode: 'semantic' | 'lexical' | 'hybrid'
  recallId?: string
}

export interface GlobalSearchResults {
  appliedQuery: string
  agents: AgentRecord[]
  apps: AppSummaryRecord[]
  channels: ChannelDirectoryEntry[]
  people: UserRecord[]
  projects: ProjectDirectoryEntry[]
  messages: MessageSearchResult[]
  knowledge: KnowledgeSearchHit[]
  thoughts: ThoughtSearchHit[]
  tasks: TaskRecord[]
  taskPagination: PagedList<TaskRecord>
  invalidTaskCursor: boolean
  restartTaskSearch: () => void
  isLoading: boolean
  errorMessage: string | null
}

const includesQuery = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle)

export const parseGlobalSearchMode = (value: string | null): GlobalSearchMode | null =>
  value === 'semantic' || value === 'fulltext'
    ? value
    // Device storage and old deep links used `text`; preserve the preference
    // while giving the mode the precise name shown in the UI.
    : value === 'text' ? 'fulltext' : null

// The mode a reader last chose on this device. It is the *default* the two
// search surfaces start from — the full page then lets `?mode=` override it.
export const readStoredSearchMode = (): GlobalSearchMode => {
  if (typeof window === 'undefined') {
    return 'fulltext'
  }
  return parseGlobalSearchMode(window.localStorage.getItem(SEARCH_MODE_STORAGE_KEY)) ?? 'fulltext'
}

export const writeStoredSearchMode = (nextMode: GlobalSearchMode): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SEARCH_MODE_STORAGE_KEY, nextMode)
}

// The top-bar search overlay's own mode. It is not a tab host: the overlay
// floats over whatever route the reader is on, and writing `?mode=` onto that
// route would be a claim about the page underneath. The full-page search at
// /search does put the mode in its URL, through the one tab-state hook.
export const usePersistedGlobalSearchMode = (): readonly [GlobalSearchMode, (nextMode: GlobalSearchMode) => void] => {
  const [mode, setMode] = useState<GlobalSearchMode>(readStoredSearchMode)

  const updateMode = (nextMode: GlobalSearchMode) => {
    setMode(nextMode)
    writeStoredSearchMode(nextMode)
  }

  return [mode, updateMode] as const
}

const queryErrorMessage = (error: unknown): string | null =>
  error instanceof Error ? error.message : null

export const isInvalidTaskSearchCursor = (error: unknown): boolean =>
  error instanceof ApiClientError && error.code === 'TASK_SEARCH_CURSOR_INVALID'

/**
 * One entitled corpus in two ranking modes. Structural records remain literal
 * in both; prose-heavy messages, tickets, documents and memory add their vector
 * arm in semantic mode. Queries shorter than two characters touch no search
 * endpoint.
 */
export const useGlobalSearch = (
  query: string,
  mode: GlobalSearchMode = 'fulltext',
): GlobalSearchResults => {
  const apiClient = useApiClient()

  const debounced = useDebouncedValue(query, DEBOUNCE_MS)
  const requested = query.trim().slice(0, MAX_QUERY_LENGTH)
  const trimmed = debounced.trim().slice(0, MAX_QUERY_LENGTH)
  const needle = trimmed.toLowerCase()
  const active = trimmed.length >= MIN_QUERY_LENGTH
  const current = requested === trimmed
  const requestedActive = requested.length >= MIN_QUERY_LENGTH
  const fulltextMode = mode === 'fulltext'

  const usersQuery = useUsers(active)
  const agentsQuery = useAgents({ enabled: active, scope: 'all' })
  const appsQuery = useApps({ query: active ? trimmed : undefined }, active)

  const filteredPeople = useMemo(
    () =>
      active
        ? (usersQuery.data ?? []).filter(
            (user) =>
              includesQuery(user.displayName, needle) || includesQuery(user.email, needle),
          )
        : [],
    [active, needle, usersQuery.data],
  )

  const filteredAgents = useMemo(
    () =>
      active
        ? (agentsQuery.data ?? []).filter((agent) =>
            includesQuery(agent.name, needle) || includesQuery(agent.role, needle))
        : [],
    [active, agentsQuery.data, needle],
  )

  const channelsQuery = useQuery({
    queryKey: searchKeys.channels(trimmed),
    queryFn: () => apiClient.get(
      `/api/channels/search?query=${encodeURIComponent(trimmed)}&limit=20`,
      ChannelDirectoryEntrySchema.array(),
    ),
    enabled: active,
  })

  const projectsQuery = useQuery({
    queryKey: searchKeys.projects(trimmed),
    queryFn: () => apiClient.get(
      `/api/projects/search?query=${encodeURIComponent(trimmed)}&limit=20`,
      ProjectDirectoryEntrySchema.array(),
    ),
    enabled: active,
  })

  const messagesQuery = useQuery<MessageSearchResult[]>({
    queryKey: searchKeys.messages(trimmed, mode),
    queryFn: () =>
      apiClient.get(
        `/api/messages/search?query=${encodeURIComponent(trimmed)}`
          + `&mode=${mode}&limit=20`,
      ),
    enabled: active,
  })

  const taskPagination = usePagedList<TaskRecord>({
    enabled: active,
    params: { mode, query: trimmed },
    paramPrefix: 'tasks-',
    path: '/api/tasks/search',
    queryKey: searchKeys.tasks(trimmed, mode),
    scope: `task-search:${mode}:${trimmed}`,
  })
  const restartTaskSearch = usePagedListReset('tasks-')
  const invalidTaskCursor = isInvalidTaskSearchCursor(taskPagination.query.error)

  // Full text is provider-owned deterministic search. Semantic is hybrid, not
  // vector-only: exact document matches remain in the fused result set.
  const knowledgeQuery = useQuery<KnowledgeSearchHit[]>({
    queryKey: searchKeys.knowledge(trimmed, mode),
    queryFn: () =>
      apiClient.post<KnowledgeSearchHit[]>('/api/knowledge-base/search', {
        query: trimmed,
        mode: fulltextMode ? 'keyword' : 'hybrid',
        limit: 20,
      }),
    enabled: active,
  })

  const thoughtsQuery = useQuery<ThoughtSearchHit[]>({
    queryKey: searchKeys.thoughts(trimmed, mode),
    queryFn: () =>
      apiClient.post<ThoughtSearchHit[]>('/api/thoughts/search', {
        limit: 20,
        mode: fulltextMode ? 'lexical' : 'hybrid',
        query: trimmed,
      }),
    enabled: active,
  })

  const appliedAppQuery = appsQuery.data?.applied.query?.trim() ?? ''

  return {
    appliedQuery: trimmed,
    agents: current ? filteredAgents : [],
    apps: active && current && appliedAppQuery === trimmed
      ? appsQuery.data?.response.apps ?? []
      : [],
    channels: active && current ? channelsQuery.data ?? [] : [],
    people: current ? filteredPeople : [],
    projects: active && current ? projectsQuery.data ?? [] : [],
    messages: active && current ? messagesQuery.data ?? [] : [],
    tasks: active && current ? taskPagination.items : [],
    taskPagination,
    invalidTaskCursor,
    restartTaskSearch,
    knowledge: active && current ? knowledgeQuery.data ?? [] : [],
    thoughts: active && current ? thoughtsQuery.data ?? [] : [],
    isLoading:
      requestedActive && (
        !current
        || (
          agentsQuery.isFetching
          || appsQuery.isFetching
          || channelsQuery.isFetching
          || knowledgeQuery.isFetching
          || messagesQuery.isFetching
          || projectsQuery.isFetching
          || taskPagination.query.isFetching
          || thoughtsQuery.isFetching
          || usersQuery.isFetching
        )
      ),
    errorMessage: active && current
      ? queryErrorMessage(channelsQuery.error)
        ?? queryErrorMessage(projectsQuery.error)
        ?? queryErrorMessage(messagesQuery.error)
        ?? queryErrorMessage(taskPagination.query.error)
        ?? queryErrorMessage(knowledgeQuery.error)
        ?? queryErrorMessage(thoughtsQuery.error)
        ?? queryErrorMessage(agentsQuery.error)
        ?? queryErrorMessage(appsQuery.error)
        ?? queryErrorMessage(usersQuery.error)
      : null,
  }
}
