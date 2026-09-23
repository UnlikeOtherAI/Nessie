import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiClientError } from '@nessie/client-core'
import {
  DeepWaterBriefViewSchema,
  DeepWaterResearchRunListSchema,
  DeepWaterResearchRunViewSchema,
  type DeepWaterBriefView,
  type DeepWaterResearchReadiness,
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
 * of any other shape is the list's error, never rows.
 */
export const useResearchRunList = () => {
  const scope = useDeepWaterViewerScope()
  return usePagedList<DeepWaterResearchRunView, DeepWaterResearchRunList>({
    enabled: scope !== null,
    items: listItems,
    meta: listMeta,
    path: RESEARCH_RUNS_PATH,
    queryKey: scope ? deepWaterKeys.list(scope) : deepWaterKeys.lists,
    schema: DeepWaterResearchRunListSchema,
  })
}

export type DeepWaterReadiness = DeepWaterResearchReadiness & {
  isLoading: boolean
  /** The deep-water products entry, for the owner's team controls. */
  product: IntegratedProductResponse | null
  /**
   * The viewer holds the owner role: the only standing `PATCH
   * …/team-enablement` accepts, so turning DeepWater on, off or updating it —
   * and the not-ready screen's way to do that — is offered on this alone.
   * `viewerCanChangeTeam` (owners and admins) is the cancel standing only.
   */
  viewerIsOwner: boolean
}

/**
 * Can this viewer open a research brief here, and who could change that — the
 * server's one verdict on the deep-water products entry (nessie.md §7.1). An
 * entry without the verdict, or no entry at all, is `unavailable`: the admin
 * never guesses readiness from the enablement and connector fields.
 */
export const useDeepWaterReadiness = (): DeepWaterReadiness => {
  const products = useIntegratedProducts()
  const viewerIsOwner = useIsOwner()
  return useMemo(() => {
    const product = products.data?.find((entry) => entry.slug === DEEP_WATER_PRODUCT_SLUG) ?? null
    const verdict = product?.research ?? null
    return {
      isLoading: products.isPending,
      product,
      state: verdict?.state ?? 'unavailable',
      viewerCanChangeTeam: verdict?.viewerCanChangeTeam ?? false,
      viewerIsOwner,
    }
  }, [products.data, products.isPending, viewerIsOwner])
}
