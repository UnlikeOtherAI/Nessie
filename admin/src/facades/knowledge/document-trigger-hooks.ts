import { useMemo } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { DocumentReviewRecord, SpaceDocumentTriggersRecord } from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import type { KnowledgePageRecord } from './hooks'
import { knowledgeKeys } from './keys'

/**
 * What a document browser shows of document triggers
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Finder and
 * project docs"): the row badge *"Sent to CTO for review · v5"*, then
 * *"Reviewed by CTO · v5"*, on each page of a listed folder a document
 * trigger sent to an agent, and whether the viewer may set up a trigger,
 * which decides whether "Tell an agent when this changes…" is offered.
 *
 * One read per listed folder, with the ids of the rows it can badge — never a
 * read per row — behind the space's own read rule rather than the owner-only
 * Triggers routes. The answer carries no document text.
 */

export type { DocumentReviewRecord, SpaceDocumentTriggersRecord }

/** The server reads at most this many page ids at once. */
export const DOCUMENT_TRIGGER_READ_MAX_PAGES = 100

/**
 * The rows of a listed folder a review can be about: documents and files,
 * the first hundred as the folder lists them. A folder is never reviewed, and
 * a spreadsheet never wakes a document trigger. Sorted for the cache key, so
 * re-sorting the folder asks nothing again.
 */
export const reviewablePageIds = (
  rows: readonly Pick<KnowledgePageRecord, 'id' | 'kind'>[],
): string[] =>
  rows
    .filter((row) => row.kind === 'document' || row.kind === 'file')
    .slice(0, DOCUMENT_TRIGGER_READ_MAX_PAGES)
    .map((row) => row.id)
    .sort()

const readPath = (spaceId: string, pageIds: string): string =>
  `/api/knowledge-base/spaces/${encodeURIComponent(spaceId)}/document-triggers`
  + (pageIds ? `?pageIds=${pageIds}` : '')

const useSpaceDocumentTriggers = (spaceId: string | undefined, pageIds: string) => {
  const apiClient = useApiClient()
  return useQuery<SpaceDocumentTriggersRecord>({
    enabled: Boolean(spaceId),
    // A folder's badges may stay up while the next folder of the same space
    // loads — they are matched to rows by page id, so a stale answer paints
    // nothing on a row it is not about — but never across spaces, whose
    // doorway answer (`viewerCanCreateTriggers`) is that space's own.
    placeholderData: (previousData, previousQuery) => (
      previousQuery?.queryKey[1] === (spaceId ?? 'none') ? previousData : undefined
    ),
    queryFn: () => apiClient.get(readPath(spaceId ?? '', pageIds)),
    queryKey: knowledgeKeys.documentTriggers(spaceId, pageIds),
    staleTime: 30_000,
  })
}

/**
 * The review badges of one listed folder, by page id. The rows are one
 * folder's, so they share a space; an empty folder asks nothing.
 */
export const useFolderDocumentReviews = (
  rows: readonly KnowledgePageRecord[],
): ReadonlyMap<string, DocumentReviewRecord> => {
  const pageIds = reviewablePageIds(rows).join(',')
  const query = useSpaceDocumentTriggers(pageIds ? rows[0]?.spaceId : undefined, pageIds)
  return useMemo(
    () => new Map((query.data?.reviews ?? []).map((review) => [review.pageId, review])),
    [query.data],
  )
}

/**
 * The project a viewer may set up a document trigger in, for this space — or
 * null for a viewer the Triggers routes would refuse, or while it is asked.
 * The same read without page ids, once per space.
 */
export const useDocumentTriggerAccess = (spaceId: string | undefined): string | null => {
  const { data } = useSpaceDocumentTriggers(spaceId, '')
  return data?.viewerCanCreateTriggers ? data.projectId : null
}

/**
 * A listed page's review, from the folder reads already held — what a row's
 * menu offers as "Open review thread". A page no listed folder has read has
 * none.
 */
export const findDocumentReview = (
  queryClient: QueryClient,
  spaceId: string | undefined,
  pageId: string,
): DocumentReviewRecord | null => {
  if (!spaceId) return null
  const reads = queryClient.getQueriesData<SpaceDocumentTriggersRecord>({
    queryKey: knowledgeKeys.documentTriggersAll(spaceId),
  })
  for (const [, data] of reads) {
    const review = data?.reviews.find((candidate) => candidate.pageId === pageId)
    if (review) return review
  }
  return null
}
