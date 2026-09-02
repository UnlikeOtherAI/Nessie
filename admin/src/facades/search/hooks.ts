import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  ChannelRecord,
  MessageSearchResult,
  ProjectRecord,
  UserRecord,
} from '../../lib/api-client'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { searchKeys } from '../../lib/query-keys'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useChannels } from '../channels/hooks'
import { useProjects } from '../projects/hooks'
import { useUsers } from '../users/hooks'

const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 250
const SEARCH_MODE_STORAGE_KEY = 'nessie.search.mode'

export const GLOBAL_SEARCH_MODES = ['text', 'semantic'] as const

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
  channels: ChannelRecord[]
  people: UserRecord[]
  projects: ProjectRecord[]
  messages: MessageSearchResult[]
  knowledge: KnowledgeSearchHit[]
  thoughts: ThoughtSearchHit[]
  isLoading: boolean
  errorMessage: string | null
}

const includesQuery = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle)

export const parseGlobalSearchMode = (value: string | null): GlobalSearchMode | null =>
  value === 'semantic' || value === 'text' ? value : null

// The mode a reader last chose on this device. It is the *default* the two
// search surfaces start from — the full page then lets `?mode=` override it.
export const readStoredSearchMode = (): GlobalSearchMode => {
  if (typeof window === 'undefined') {
    return 'text'
  }
  return parseGlobalSearchMode(window.localStorage.getItem(SEARCH_MODE_STORAGE_KEY)) ?? 'text'
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

/**
 * Global search across channels, people, projects (filtered client-side from
 * already-loaded data), messages and knowledge pages in text mode, and memory
 * thoughts in semantic mode. The query is debounced internally; queries shorter
 * than two characters return empty results without touching the API.
 */
export const useGlobalSearch = (
  query: string,
  mode: GlobalSearchMode = 'text',
): GlobalSearchResults => {
  const apiClient = useApiClient()
  const isOwner = useIsOwner()

  const debounced = useDebouncedValue(query, DEBOUNCE_MS)
  const trimmed = debounced.trim()
  const needle = trimmed.toLowerCase()
  const active = trimmed.length >= MIN_QUERY_LENGTH
  const textMode = mode === 'text'
  const semanticMode = mode === 'semantic'

  const { data: channels = [] } = useChannels()
  const { data: users = [] } = useUsers(isOwner)
  const { data: projects = [] } = useProjects()

  const filteredChannels = useMemo(
    () =>
      active && textMode
        ? channels.filter(
            (channel) => channel.type !== 'dm' && includesQuery(channel.label, needle),
          )
        : [],
    [active, channels, needle, textMode],
  )

  const filteredPeople = useMemo(
    () =>
      active && textMode
        ? users.filter(
            (user) =>
              includesQuery(user.displayName, needle) || includesQuery(user.email, needle),
          )
        : [],
    [active, users, needle, textMode],
  )

  const filteredProjects = useMemo(
    () =>
      active && textMode
        ? projects.filter((project) => includesQuery(project.name, needle))
        : [],
    [active, needle, projects, textMode],
  )

  const messagesQuery = useQuery<MessageSearchResult[]>({
    queryKey: searchKeys.messages(trimmed, mode),
    queryFn: () =>
      apiClient.get(`/api/messages/search?query=${encodeURIComponent(trimmed)}&limit=20`),
    enabled: active && textMode,
  })

  // Text mode uses keyword search; semantic mode uses hybrid search so
  // knowledge results (with highlighted passages) surface alongside thoughts.
  const knowledgeQuery = useQuery<KnowledgeSearchHit[]>({
    queryKey: searchKeys.knowledge(trimmed, mode),
    queryFn: () =>
      apiClient.post<KnowledgeSearchHit[]>('/api/knowledge-base/search', {
        query: trimmed,
        mode: textMode ? 'keyword' : 'hybrid',
        limit: 20,
      }),
    enabled: active,
  })

  const thoughtsQuery = useQuery<ThoughtSearchHit[]>({
    queryKey: searchKeys.thoughts(trimmed, mode),
    queryFn: () =>
      apiClient.post<ThoughtSearchHit[]>('/api/thoughts/search', {
        limit: 20,
        mode: 'semantic',
        query: trimmed,
      }),
    enabled: active && semanticMode,
  })

  return {
    channels: filteredChannels,
    people: filteredPeople,
    projects: filteredProjects,
    messages: active && textMode ? messagesQuery.data ?? [] : [],
    knowledge: active ? knowledgeQuery.data ?? [] : [],
    thoughts: active && semanticMode ? thoughtsQuery.data ?? [] : [],
    isLoading:
      active &&
      (textMode
        ? messagesQuery.isFetching || knowledgeQuery.isFetching
        : thoughtsQuery.isFetching || knowledgeQuery.isFetching),
    errorMessage: active
      ? queryErrorMessage(messagesQuery.error)
        ?? queryErrorMessage(knowledgeQuery.error)
        ?? queryErrorMessage(thoughtsQuery.error)
      : null,
  }
}
