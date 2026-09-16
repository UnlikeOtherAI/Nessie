import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  KnowledgePageShareAccess,
  KnowledgePageShareRecord,
} from '@nessie/schemas'
import { knowledgeKeys } from '../../../../facades/knowledge/keys'
import { useApiClient } from '../../../../providers/ApiClientProvider'

/**
 * Person-to-person sharing, from the admin's side (data-and-api.md §2).
 *
 * **There is no approval step here, and there must not be one.** A person
 * handing their own document to another person is a grant: the row is written
 * on the request and takes effect on the next read. The agent publication gate
 * (`knowledge.page.publish`, `kb_publish_request`) is a different mechanism for
 * a different actor, and an implementer routing a share into it has misread
 * the ask (menus-and-dialogs.md §4, "The gate that is not involved").
 *
 * These live beside the dialog rather than in `facades/knowledge/finder-hooks.ts`
 * only because that file has another owner this wave; they share the one
 * `keys.ts`, which is what actually has to be shared — a second key module
 * would be a second cache identity for the same rows.
 */

const BASE = '/api/knowledge-base'

const sharesPath = (pageId: string): string =>
  `${BASE}/pages/${encodeURIComponent(pageId)}/shares`

/**
 * Who a page is shared with. Only the owner may read it — a grantee asking who
 * else has access gets the same 403 as a stranger — so the query is enabled
 * from the call site's own `canShare`, never speculatively.
 */
export const usePageShares = (pageId: string | undefined, enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgePageShareRecord[]>({
    enabled: Boolean(pageId) && enabled,
    // An id-keyed query without this blanks the list every time the dialog's
    // target changes, which reads as "nobody has access" for one frame.
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get(sharesPath(pageId as string)),
    queryKey: knowledgeKeys.pageShares(pageId),
  })
}

/** Everything that changes a page's audience invalidates the same three reads. */
const useShareInvalidation = (): ((pageId: string, spaceId?: string) => void) => {
  const queryClient = useQueryClient()
  return (pageId, spaceId) => {
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pageShares(pageId) })
    // The row's `shareCount` glyph and Get Info's Sharing line both come from
    // the listing, not from the share list.
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pageInfo(pageId) })
    if (spaceId) void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.sharedWithMe })
  }
}

export type AddPageShareInput = {
  pageId: string
  spaceId?: string
  granteeUserId: string
  access: KnowledgePageShareAccess
}

/**
 * Add a person, at a level. Idempotent on the server and also the
 * change-level path, so re-adding somebody already listed is a level change
 * rather than an error.
 */
export const useAddPageShare = () => {
  const apiClient = useApiClient()
  const invalidate = useShareInvalidation()

  return useMutation({
    mutationFn: ({ access, granteeUserId, pageId }: AddPageShareInput) =>
      apiClient.post<KnowledgePageShareRecord>(sharesPath(pageId), { access, granteeUserId }),
    onSuccess: (_share, input) => invalidate(input.pageId, input.spaceId),
  })
}

export type SetPageShareAccessInput = {
  pageId: string
  spaceId?: string
  granteeUserId: string
  access: KnowledgePageShareAccess
}

export const useSetPageShareAccess = () => {
  const apiClient = useApiClient()
  const invalidate = useShareInvalidation()

  return useMutation({
    mutationFn: ({ access, granteeUserId, pageId }: SetPageShareAccessInput) =>
      apiClient.patch<KnowledgePageShareRecord>(
        `${sharesPath(pageId)}/${encodeURIComponent(granteeUserId)}`,
        { access },
      ),
    onSuccess: (_share, input) => invalidate(input.pageId, input.spaceId),
  })
}

export type RemovePageShareInput = {
  pageId: string
  spaceId?: string
  granteeUserId: string
}

/**
 * Remove a person — and the same route a grantee uses to decline a share they
 * were given ("Remove from Shared with me"), which is why the grantee id is
 * explicit rather than implied by the caller.
 */
export const useRemovePageShare = () => {
  const apiClient = useApiClient()
  const invalidate = useShareInvalidation()

  return useMutation({
    mutationFn: ({ granteeUserId, pageId }: RemovePageShareInput) =>
      apiClient.delete<void>(`${sharesPath(pageId)}/${encodeURIComponent(granteeUserId)}`),
    onSuccess: (_result, input) => invalidate(input.pageId, input.spaceId),
  })
}
