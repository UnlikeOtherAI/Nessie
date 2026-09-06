import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { knowledgeKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { KnowledgePageKind } from './hooks'

/**
 * A row of "what was last written down in this project" — the flattened
 * projection `GET /api/knowledge-base/recent-pages` returns across every space
 * of the project the caller can read. Deliberately not a `KnowledgePageRecord`:
 * no body, no version envelopes, no summary.
 */
export type RecentKnowledgePage = {
  id: string
  spaceId: string
  spaceName: string
  title: string
  kind: KnowledgePageKind
  status: 'draft' | 'published' | 'archived'
  updatedAt: string
}

export const useProjectRecentPages = (projectId?: string, limit = 5) => {
  const apiClient = useApiClient()

  return useQuery<RecentKnowledgePage[]>({
    placeholderData: keepPreviousData,
    queryKey: knowledgeKeys.recentPages(projectId, limit),
    queryFn: () =>
      apiClient.get(
        `/api/knowledge-base/recent-pages?projectId=${encodeURIComponent(projectId ?? '')}`
        + `&limit=${limit}`,
      ),
    enabled: Boolean(projectId),
  })
}
