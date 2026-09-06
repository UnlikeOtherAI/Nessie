import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { WebSearchCard } from '@nessie/schemas'

import { webSearchKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * A page of web results, fetched because a person asked for it.
 *
 * The card a run posted already carries the page the agent fetched, so this
 * only runs when the reader has paged away from it — a thread full of search
 * cards costs nothing to open, and every search here is one somebody clicked
 * for. Pages stay cached under their own key so paging back is free.
 */
export const useWebSearchPage = (
  input: { count: number; page: number; query: string } | null,
) => {
  const apiClient = useApiClient()

  return useQuery<WebSearchCard>({
    enabled: input !== null,
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiClient.post<WebSearchCard>('/api/web-search', {
        count: input!.count,
        page: input!.page,
        query: input!.query,
      }),
    queryKey: webSearchKeys.page(input?.query ?? '', input?.page ?? 0, input?.count ?? 0),
    // A page of search results does not change while somebody reads it, and
    // refetching one spends a provider credit.
    staleTime: 10 * 60 * 1000,
  })
}
