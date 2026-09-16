import { useCallback } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  KnowledgeItemInfo,
  KnowledgeRoot,
  KnowledgeSharedRow,
  KnowledgeVirtualRow,
  PaginationMeta,
  TransferResult,
  TransferStatus,
} from '@nessie/schemas'
import { knowledgeKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { KnowledgePageRecord, KnowledgeSpaceRecord } from './hooks'

/**
 * The Documents Finder's reads and writes
 * (docs/plans/2026-09-16-documents-finder-ui/browser-ui.md §11,
 * data-and-api.md §3, §4, §5, §7).
 *
 * They live beside `hooks.ts` rather than inside it because that file is
 * already the whole knowledge surface and this is a new one; they share the
 * one `keys.ts`, which is what actually has to be shared — a second key module
 * would be a second cache identity for the same rows.
 */

const BASE = '/api/knowledge-base'

const search = (params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(name, value)
  }
  const rendered = query.toString()
  return rendered ? `?${rendered}` : ''
}

// ── The root column ─────────────────────────────────────────────────────────

/**
 * One read for the whole root column. `staleTime` is 30s because the root
 * changes when a project is joined or a folder is shared — neither of which
 * happens while a person is looking at it — and `keepPreviousData` stops the
 * column blanking on every refetch.
 */
export const useKnowledgeRoot = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeRoot>({
    enabled,
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get(`${BASE}/root`),
    queryKey: knowledgeKeys.root,
    staleTime: 30_000,
  })
}

/**
 * Opening a project's folder for the first time. `GET /root` deliberately
 * leaves `space: null` for a project nobody has opened — a read that writes N
 * rows for N projects is a read that gets slower every time somebody joins a
 * project — so the folder is provisioned on the way in.
 */
export const useEnsureProjectDocuments = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (projectId: string) =>
      apiClient.post<KnowledgeSpaceRecord>(
        `${BASE}/projects/${encodeURIComponent(projectId)}/documents`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.root })
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.spaces })
    },
  })
}

// ── The virtual folders ─────────────────────────────────────────────────────

type VirtualPage<TRow> = { data: TRow[]; meta?: PaginationMeta }

const nextCursorOf = <TRow>(page: VirtualPage<TRow>): string | undefined =>
  page.meta?.hasMore ? page.meta.nextCursor ?? undefined : undefined

/**
 * Latest — every readable document and file, newest modified first, folders
 * excluded. Keyset-paged: a count over every readable space per keystroke is
 * exactly the cost the cap exists to avoid, so there is no total and the
 * status bar says "Showing 50 of more" instead.
 */
export const useLatestPages = (projectId?: string, enabled = true) => {
  const apiClient = useApiClient()

  return useInfiniteQuery<VirtualPage<KnowledgeVirtualRow>>({
    enabled,
    getNextPageParam: nextCursorOf,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.getPage<KnowledgeVirtualRow[]>(
        `${BASE}/latest${search({ cursor: pageParam as string | undefined, projectId })}`,
      ),
    queryKey: knowledgeKeys.latest(projectId),
  })
}

/** Shared with me — pages another person granted the viewer, newest first. */
export const useSharedWithMe = (enabled = true) => {
  const apiClient = useApiClient()

  return useInfiniteQuery<VirtualPage<KnowledgeSharedRow>>({
    enabled,
    getNextPageParam: nextCursorOf,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiClient.getPage<KnowledgeSharedRow[]>(
        `${BASE}/shared-with-me${search({ cursor: pageParam as string | undefined })}`,
      ),
    queryKey: knowledgeKeys.sharedWithMe,
  })
}

/** Flattens the pages an infinite query holds into the rows a column draws. */
export const virtualRows = <TRow>(
  pages: { pages: VirtualPage<TRow>[] } | undefined,
): TRow[] => (pages?.pages ?? []).flatMap((page) => page.data)

// ── Get Info ────────────────────────────────────────────────────────────────

export const usePageInfo = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeItemInfo>({
    enabled: Boolean(pageId),
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get(`${BASE}/pages/${pageId}/info`),
    queryKey: knowledgeKeys.pageInfo(pageId),
  })
}

export const useSpaceInfo = (spaceId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeItemInfo>({
    enabled: Boolean(spaceId),
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get(`${BASE}/spaces/${spaceId}/info`),
    queryKey: knowledgeKeys.spaceInfo(spaceId),
  })
}

export const useReindexPage = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (pageId: string) =>
      apiClient.post<KnowledgePageRecord>(`${BASE}/pages/${pageId}/reindex`, {}),
    onSuccess: (page) => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pageInfo(page.id) })
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(page.spaceId) })
    },
  })
}

// ── Rename and in-space move ────────────────────────────────────────────────

const invalidateFinder = (
  queryClient: ReturnType<typeof useQueryClient>,
  spaceId: string | undefined,
): void => {
  if (spaceId) void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.root })
}

export type RenamePageInput = {
  pageId: string
  spaceId: string
  title: string
  /** The row's `revision`, sent as `If-Match` so a stale rename is refused. */
  revision?: number
}

/**
 * Rename in place. Optimistic: the row shows the new name the moment Enter is
 * pressed, and a 409 `KNOWLEDGE_PAGE_REVISION_CONFLICT` puts the old one back.
 * A rename that waited for a round trip would show the old name under a
 * cursor that has already left the field.
 */
export const useRenamePage = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ pageId, revision, title }: RenamePageInput) =>
      apiClient.patch<KnowledgePageRecord>(
        `${BASE}/pages/${pageId}`,
        { title },
        revision === undefined ? undefined : { 'If-Match': String(revision) },
      ),
    onMutate: async ({ pageId, spaceId, title }) => {
      const key = knowledgeKeys.pages(spaceId)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<KnowledgePageRecord[]>(key)
      if (previous) {
        queryClient.setQueryData<KnowledgePageRecord[]>(
          key,
          previous.map((page) => (page.id === pageId ? { ...page, title } : page)),
        )
      }
      return { key, previous }
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous)
    },
    onSettled: (_page, _error, input) => invalidateFinder(queryClient, input.spaceId),
  })
}

export type MovePagesInput = {
  spaceId: string
  /** Source rows, in the order they were selected. */
  pageIds: string[]
  /** The folder they land in; `null` is the space root. */
  parentPageId: string | null
  /** Revisions by page id, for `If-Match`. */
  revisions?: Record<string, number | undefined>
}

/**
 * Moving rows inside one root folder. Sequential rather than parallel: the
 * server assigns `position` on each write, and two concurrent moves into one
 * folder would race for it. The first failure stops the run and is reported —
 * a half-moved selection that reports success is worse than a partial move
 * that says so.
 */
export const useMovePages = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ pageIds, parentPageId, revisions }: MovePagesInput) => {
      const moved: KnowledgePageRecord[] = []
      for (const pageId of pageIds) {
        const revision = revisions?.[pageId]
        moved.push(
          await apiClient.post<KnowledgePageRecord>(
            `${BASE}/pages/${pageId}/move`,
            { parentPageId },
            revision === undefined ? undefined : { 'If-Match': String(revision) },
          ),
        )
      }
      return moved
    },
    onMutate: async ({ pageIds, parentPageId, spaceId }) => {
      const key = knowledgeKeys.pages(spaceId)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<KnowledgePageRecord[]>(key)
      if (previous) {
        const moving = new Set(pageIds)
        queryClient.setQueryData<KnowledgePageRecord[]>(
          key,
          previous.map((page) => (moving.has(page.id) ? { ...page, parentPageId } : page)),
        )
      }
      return { key, previous }
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous)
    },
    onSettled: (_pages, _error, input) => invalidateFinder(queryClient, input.spaceId),
  })
}

// ── Cross-root transfers (transfer.md §2-§5) ────────────────────────────────

export type TransferPagesInput = {
  operation: 'move' | 'copy'
  /** The selected roots; descendants are the server's business. */
  pageIds: string[]
  /** Where they are leaving, so the cache entry they are leaving is refreshed. */
  sourceSpaceId: string
  target: { spaceId: string; parentPageId: string | null }
}

/**
 * The one write both doorways make: the drop-point prompt and Move to…'s
 * two-button footer.
 *
 * `acknowledged: true` is set here and nowhere else — it is the client saying
 * it has already shown the audience line and, where it applies, the sentence
 * that sharing ends. The server refuses the body without it so no caller can
 * widen an audience blind, which is why it is not a parameter.
 *
 * **No optimistic write.** An in-space move can put a row back where it was;
 * a transfer cannot, because a refusal may arrive after the server has already
 * counted a 600-page subtree, and because a copy's result is rows that did not
 * exist to put back. The rows move when the server says they moved.
 */
export const useTransferPages = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation<TransferResult, Error, TransferPagesInput>({
    mutationFn: ({ operation, pageIds, target }) =>
      apiClient.post<TransferResult>(`${BASE}/transfers`, {
        acknowledged: true,
        operation,
        pageIds,
        target,
      }),
    onSuccess: (result, input) => {
      // Both ends of the transfer, plus every corpus computed across spaces.
      // A queued transfer invalidates the same keys: the roots are stamped
      // `metadata.transfer` by the same request, and the rows have to start
      // reading "Moving…" before the job has done anything.
      invalidateTransferReach(queryClient, input)
      if (result.status !== 'done') return
      for (const page of result.pages) {
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pageInfo(page.sourcePageId) })
        void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pageInfo(page.pageId) })
      }
    },
  })
}

const invalidateTransferReach = (
  queryClient: ReturnType<typeof useQueryClient>,
  input: TransferPagesInput,
): void => {
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(input.sourceSpaceId) })
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(input.target.spaceId) })
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.root })
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.latest() })
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.sharedWithMe })
}

/** Re-read both ends of a transfer that finished somewhere else (the worker). */
export const useInvalidateTransferReach = () => {
  const queryClient = useQueryClient()
  return useCallback(
    (input: TransferPagesInput) => invalidateTransferReach(queryClient, input),
    [queryClient],
  )
}

/** Below this the tray is idle; at or above it the poll is running. */
export const TRANSFER_POLL_MS = 2_000

/**
 * A queued transfer's progress, polled every 2 s while it is `queued` or
 * `running` and never afterwards. `done`/`total` are pages, not bytes, and a
 * failed **move** keeps the batches that committed — the caller must not
 * render them as "nothing happened".
 */
export const useTransferStatus = (transferId?: string) => {
  const apiClient = useApiClient()

  return useQuery<TransferStatus>({
    enabled: Boolean(transferId),
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get(`${BASE}/transfers/${transferId}`),
    queryKey: knowledgeKeys.transfer(transferId),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'queued' || status === 'running' ? TRANSFER_POLL_MS : false
    },
  })
}
