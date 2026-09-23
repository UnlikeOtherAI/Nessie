import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ZodIssue } from 'zod'
import { ApiClientError } from '@nessie/client-core'
import {
  DeepWaterBriefViewSchema,
  DeepWaterResearchReadinessSchema,
  DeepWaterResearchRunListSchema,
  DeepWaterResearchRunViewSchema,
  type DeepWaterBriefView,
  type DeepWaterResearchReadinessState,
  type DeepWaterResearchRunList,
  type DeepWaterResearchRunView,
  type IntegratedProductResponse,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useIsOwner } from '../auth/hooks'
import { useIntegratedProducts } from '../integrations/hooks'
import { usePagedList } from '../pagination/usePagedList'
import { deepWaterKeys, type DeepWaterViewerScope } from './keys'

/**
 * The reads behind every DeepWater research surface in the admin: the
 * Knowledge › Research list, the research card in a thread, and the brief
 * dialog (Water plan nessie.md §7.1–7.2). Each is the viewer's own read — the
 * server decides what this person may see, and a 404 is the answer for a
 * research they may not — so nothing here filters or infers visibility.
 *
 * Nothing polls. A change reaches these through `integration.run.updated`,
 * handled once in the shell (`useDeepWaterRunEvents`).
 */

export const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
export const RESEARCH_RUNS_PATH = '/api/integrations/products/deep-water/research-runs'

export const researchRunPath = (runId: string): string =>
  `${RESEARCH_RUNS_PATH}/${encodeURIComponent(runId)}`

export const useDeepWaterViewerScope = (): DeepWaterViewerScope | null => {
  const { me } = useAuthSession()
  return useMemo(
    () => (me
      ? { organizationId: me.context.organizationId, teamId: me.context.teamId, userId: me.user.id }
      : null),
    [me],
  )
}

/** A research this viewer may not see answers 404, which is final for this read. */
export const isResearchNotFound = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 404

const retryUnlessNotFound = (failureCount: number, error: unknown): boolean =>
  !isResearchNotFound(error) && failureCount < 2

/**
 * One research as the viewer sees it — what a card and a list row render.
 * Deliberately no `keepPreviousData` (see test/skeleton.test.ts): a card or a
 * dialog showing another run under this run's id would offer that run's
 * actions and artifacts as this one's.
 */
export const useResearchRun = (runId: string | null) => {
  const api = useApiClient()
  const scope = useDeepWaterViewerScope()
  return useQuery<DeepWaterResearchRunView>({
    enabled: Boolean(runId && scope),
    queryFn: () => api.get(researchRunPath(runId ?? ''), DeepWaterResearchRunViewSchema),
    queryKey: runId && scope ? deepWaterKeys.view(runId, scope) : deepWaterKeys.run('none'),
    retry: retryUnlessNotFound,
  })
}

/** The brief — the research view plus the conversation with DeepWater's planner. */
export const useResearchBrief = (runId: string | null) => {
  const api = useApiClient()
  const scope = useDeepWaterViewerScope()
  return useQuery<DeepWaterBriefView>({
    enabled: Boolean(runId && scope),
    queryFn: () => api.get(`${researchRunPath(runId ?? '')}/brief`, DeepWaterBriefViewSchema),
    queryKey: runId && scope ? deepWaterKeys.brief(runId, scope) : deepWaterKeys.run('none'),
    retry: retryUnlessNotFound,
  })
}

const listItems = (list: DeepWaterResearchRunList) => list.items
const listMeta = (list: DeepWaterResearchRunList) => list.meta

/**
 * Knowledge › Research: every research this viewer may see, newest first,
 * paged. The list's data is `{items, meta}` (nessie.md §7.1), so its cursors
 * are read from inside it, and every page is read through its schema: a body
 * of any other shape is the list's error, never rows. The server keeps only
 * the rows this viewer may see, so it pages forwards only (`prevCursor` is
 * always null); Previous walks back along the cursors kept in the address.
 * It reads a bounded number of rows per request, so a page can be short, or
 * empty, while `hasMore` is true.
 */
export const useResearchRunList = () => {
  const scope = useDeepWaterViewerScope()
  return usePagedList<DeepWaterResearchRunView, DeepWaterResearchRunList>({
    backward: 'trail',
    enabled: scope !== null,
    items: listItems,
    meta: listMeta,
    path: RESEARCH_RUNS_PATH,
    queryKey: scope ? deepWaterKeys.list(scope) : deepWaterKeys.lists,
    schema: DeepWaterResearchRunListSchema,
  })
}

const logged = new WeakSet<object>()

/** Log a failure the first time it is seen: the same query error or verdict reaches every composer. */
const logOnce = (subject: unknown, message: string, detail?: unknown): void => {
  if (subject !== null && typeof subject === 'object') {
    if (logged.has(subject)) return
    logged.add(subject)
  }
  console.error(`[deep-water] ${message}`, subject, ...(detail === undefined ? [] : [detail]))
}

export type DeepWaterReadiness = {
  /**
   * The server's verdict: can this viewer open a research brief here. Null
   * while it loads, and when it could not be read (`isError`) — never a
   * guess, so no doorway says DeepWater is off or unavailable without the
   * server having said so.
   */
  state: DeepWaterResearchReadinessState | null
  isLoading: boolean
  /** The products list could not be read, or its DeepWater verdict broke the contract. */
  isError: boolean
  /** Read the verdict again, for a screen that says it could not be loaded. */
  retry: () => void
  /** The deep-water products entry, for the owner's team controls. */
  product: IntegratedProductResponse | null
  /** The verdict's cancel standing: team owners and admins (amendments N8.5). */
  viewerCanChangeTeam: boolean
  /**
   * The viewer holds the owner role: the only standing `PATCH
   * …/team-enablement` accepts, so turning DeepWater on, off or updating it —
   * and the not-ready screen's way to do that — is offered on this alone.
   * `viewerCanChangeTeam` (owners and admins) is the cancel standing only.
   */
  viewerIsOwner: boolean
}

/** The verdict as read from one state of the products query, before the hook adds its actions. */
export type DeepWaterReadinessRead = Pick<
  DeepWaterReadiness,
  'isError' | 'isLoading' | 'product' | 'state' | 'viewerCanChangeTeam'
> & {
  /** The contract the sent verdict broke, for the log; null when it was read, or none was sent. */
  issues: ZodIssue[] | null
}

/**
 * Can this viewer open a research brief here, and who could change that — the
 * server's one verdict on the deep-water products entry (nessie.md §7.1),
 * read through its schema. No entry, or an entry the server sent without a
 * verdict (it gives none outside a team), is `unavailable`: research cannot
 * start here. A products read that failed with nothing read before it, or a
 * verdict that does not match the contract (an admin and API deployed at
 * different versions), is `isError` — never presented as DeepWater being off
 * or unreachable, and never guessed from the enablement and connector fields.
 * A later read that failed keeps the verdict the last one read, as the query
 * keeps its data. Pure, so every case is tested without a query.
 */
export const readDeepWaterReadiness = (products: {
  data: IntegratedProductResponse[] | undefined
  isError: boolean
  isPending: boolean
}): DeepWaterReadinessRead => {
  const product = products.data?.find((entry) => entry.slug === DEEP_WATER_PRODUCT_SLUG) ?? null
  const sent: unknown = product?.research
  const verdict = sent === undefined ? null : DeepWaterResearchReadinessSchema.safeParse(sent)
  const issues = verdict !== null && !verdict.success ? verdict.error.issues : null
  const read = verdict?.success ? verdict.data : null
  const isError = (products.isError && products.data === undefined) || issues !== null
  return {
    isError,
    isLoading: products.isPending,
    issues,
    product,
    state: isError || products.isPending ? null : read?.state ?? 'unavailable',
    viewerCanChangeTeam: read?.viewerCanChangeTeam ?? false,
  }
}

/** The verdict for this viewer (`readDeepWaterReadiness`), with a way to read it again; failures are logged. */
export const useDeepWaterReadiness = (): DeepWaterReadiness => {
  const products = useIntegratedProducts()
  const viewerIsOwner = useIsOwner()
  const { data, error, isError, isPending, refetch } = products
  const read = useMemo(() => readDeepWaterReadiness({ data, isError, isPending }), [data, isError, isPending])
  const { issues, product } = read

  // Every composer reads the verdict, so each failure is logged once, not once per composer.
  useEffect(() => {
    if (error) logOnce(error, 'the products list could not be read for research readiness')
  }, [error])
  useEffect(() => {
    if (issues) logOnce(product?.research, 'the products list sent a research readiness verdict outside the contract', issues)
  }, [issues, product])

  return useMemo(() => ({
    isError: read.isError,
    isLoading: read.isLoading,
    product: read.product,
    retry: () => void refetch(),
    state: read.state,
    viewerCanChangeTeam: read.viewerCanChangeTeam,
    viewerIsOwner,
  }), [read, refetch, viewerIsOwner])
}
