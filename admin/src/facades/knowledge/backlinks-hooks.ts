import { useQuery } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type KnowledgeBacklink = {
  pageId: string
  title: string
  spaceId: string
  snippet: string | null
}

export type KnowledgeMention = {
  pageId: string
  title: string
  spaceId: string
}

// Pages that link to this page via a resolved wikilink (ACL-filtered
// server-side).
export const useKnowledgeBacklinks = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeBacklink[]>({
    queryKey: ['knowledge-backlinks', pageId ?? 'none'],
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}/backlinks`),
    enabled: Boolean(pageId),
  })
}

// Pages whose text mentions this page's title but don't link it — surfaced so
// the author can decide whether to turn the mention into a real wikilink.
export const useKnowledgeMentions = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeMention[]>({
    queryKey: ['knowledge-mentions', pageId ?? 'none'],
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}/mentions`),
    enabled: Boolean(pageId),
  })
}
