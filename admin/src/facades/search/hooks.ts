import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  ChannelRecord,
  MessageSearchResult,
  ProjectRecord,
  UserRecord,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useChannels } from '../channels/hooks'
import { useProjects } from '../projects/hooks'
import { useUsers } from '../users/hooks'

const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 250

// Shape returned by POST /api/knowledge-base/search — one hit per readable page.
export interface KnowledgeSearchHit {
  page: {
    id: string
    spaceId: string
    title: string
    summary: string | null
  }
  snippet: string
}

export interface GlobalSearchResults {
  channels: ChannelRecord[]
  people: UserRecord[]
  projects: ProjectRecord[]
  messages: MessageSearchResult[]
  knowledge: KnowledgeSearchHit[]
  isLoading: boolean
}

// Debounce a value so we do not fire a search request on every keystroke.
const useDebounced = (value: string, delayMs: number): string => {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

const includesQuery = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle)

/**
 * Global search across channels, people, projects (filtered client-side from
 * already-loaded data) plus messages and knowledge pages (via the API). The
 * query is debounced internally; queries shorter than two characters return
 * empty results without touching the API.
 */
export const useGlobalSearch = (query: string): GlobalSearchResults => {
  const apiClient = useApiClient()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds?.includes('owner') ?? false

  const debounced = useDebounced(query, DEBOUNCE_MS)
  const trimmed = debounced.trim()
  const needle = trimmed.toLowerCase()
  const active = trimmed.length >= MIN_QUERY_LENGTH

  const { data: channels = [] } = useChannels()
  const { data: users = [] } = useUsers(isOwner)
  const { data: projects = [] } = useProjects()

  const filteredChannels = useMemo(
    () =>
      active
        ? channels.filter(
            (channel) => channel.type !== 'dm' && includesQuery(channel.label, needle),
          )
        : [],
    [active, channels, needle],
  )

  const filteredPeople = useMemo(
    () =>
      active
        ? users.filter(
            (user) =>
              includesQuery(user.displayName, needle) || includesQuery(user.email, needle),
          )
        : [],
    [active, users, needle],
  )

  const filteredProjects = useMemo(
    () => (active ? projects.filter((project) => includesQuery(project.name, needle)) : []),
    [active, needle, projects],
  )

  const messagesQuery = useQuery<MessageSearchResult[]>({
    queryKey: ['search', 'messages', trimmed],
    queryFn: () =>
      apiClient.get(`/api/messages/search?query=${encodeURIComponent(trimmed)}&limit=20`),
    enabled: active,
  })

  const knowledgeQuery = useQuery<KnowledgeSearchHit[]>({
    queryKey: ['search', 'knowledge', trimmed],
    queryFn: () =>
      apiClient.post<KnowledgeSearchHit[]>('/api/knowledge-base/search', { query: trimmed }),
    enabled: active,
  })

  return {
    channels: filteredChannels,
    people: filteredPeople,
    projects: filteredProjects,
    messages: active ? messagesQuery.data ?? [] : [],
    knowledge: active ? knowledgeQuery.data ?? [] : [],
    isLoading: active && (messagesQuery.isFetching || knowledgeQuery.isFetching),
  }
}
