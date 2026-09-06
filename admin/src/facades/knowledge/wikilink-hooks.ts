import { useQuery } from '@tanstack/react-query'
import type { KnowledgeSearchHit } from '../search/hooks'
import { knowledgeKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

const WIKILINK_SUGGESTION_LIMIT = 6

// Keyword-search suggestions for the `[[` wikilink popup. ACL filtering
// happens server-side (POST /api/knowledge-base/search), so the client never
// needs to scope by space itself.
export const useWikilinkSuggestions = (query: string, enabled: boolean) => {
  const apiClient = useApiClient()
  const trimmed = query.trim()

  return useQuery<KnowledgeSearchHit[]>({
    queryKey: knowledgeKeys.wikilinkSuggestions(trimmed),
    queryFn: () =>
      apiClient.post<KnowledgeSearchHit[]>('/api/knowledge-base/search', {
        query: trimmed,
        mode: 'keyword',
        limit: WIKILINK_SUGGESTION_LIMIT,
      }),
    enabled: enabled && trimmed.length > 0,
  })
}
