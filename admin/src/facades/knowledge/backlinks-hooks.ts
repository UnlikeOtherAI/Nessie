import { useQuery } from '@tanstack/react-query'
import { knowledgeKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type KnowledgeBacklink = {
  pageId: string
  title: string
  spaceId: string
  snippet: string | null
}

// Pages that link to this page via a resolved wikilink (ACL-filtered
// server-side).
export const useKnowledgeBacklinks = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeBacklink[]>({
    // A previous page's links are not this page's relationships and may name
    // documents the new page never references.
    placeholderData: undefined,
    queryKey: knowledgeKeys.backlinks(pageId),
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}/backlinks`),
    enabled: Boolean(pageId),
  })
}
