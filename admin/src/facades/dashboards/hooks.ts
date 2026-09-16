/**
 * Data access for the dashboards surface.
 *
 * Widget data is fetched per widget rather than inlined into the dashboard
 * response: each widget resolves its own authorization server-side, so one
 * widget the viewer cannot see renders a lock tile instead of failing the whole
 * page.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DashboardLayout,
  DashboardPresentation,
  DashboardWidgetProjection,
  WidgetDefinition,
} from '@nessie/schemas'
import type { ApiClient } from '../../lib/api-client'
import { dashboardKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type DashboardRecord = {
  id: string
  title: string
  description: string | null
  /** A dashboard lives in a project, and that project's members are its audience. */
  projectId: string
  layout: DashboardLayout
  presentation: DashboardPresentation
  revision: number
  createdBy: string
  createdByType: 'user' | 'agent'
  updatedAt: string
}

export type DashboardWidgetRecord = {
  id: string
  dashboardId: string
  sourceId: string
  kind: string
  schemaVersion: number
  spec: WidgetDefinition
  lockedAt: string | null
}

export type DashboardSourceRecord = {
  id: string
  name: string
  kind: 'http' | 'static'
  origin: string | null
  path: string | null
  transform: string | null
  outputColumns: { key: string; label: string; type: string; nullable: boolean }[]
  refreshMode: 'manual' | 'interval'
  intervalMinutes: number | null
  lastValidatedAt: string | null
  lastErrorCode: string | null
  credentialMode: string | null
}

export type DashboardVersionRecord = {
  id: string
  versionNumber: number
  summary: string
  authorType: 'user' | 'agent'
  authorId: string
  runId: string | null
  createdAt: string
}

export type DashboardSourceNote = {
  id: string
  name: string
  kind: 'http' | 'static'
  lastValidatedAt: string | null
  sourceReference: string | null
  canonicalUrl: string | null
  parser: string | null
  contentDigest: string | null
  originalAttachmentId: string | null
}

/**
 * The dashboards of one project. `projectId` is not optional: every surface
 * that shows dashboards is a project surface, and an unscoped read would be a
 * list nothing renders.
 */
export const useDashboards = (projectId: string | undefined) => {
  const client = useApiClient()
  const suffix = `?projectId=${encodeURIComponent(projectId ?? '')}`

  return useQuery({
    enabled: Boolean(projectId),
    // Id-keyed, so it carries the previous project's answer while the next one
    // loads rather than flashing empty (`docs/standards` → admin query
    // conventions).
    placeholderData: keepPreviousData,
    queryKey: dashboardKeys.list(suffix),
    queryFn: () => client.get<DashboardRecord[]>(`/api/dashboards${suffix}`),
  })
}

export type DashboardDetailRecord = DashboardRecord & {
  widgets: DashboardWidgetRecord[]
}

/** Shared with `navigation/prewarm.ts`; see `fetchThreadMessages` for why. */
export const fetchDashboard = (
  client: ApiClient,
  dashboardId: string,
): Promise<DashboardDetailRecord> =>
  client.get<DashboardDetailRecord>(`/api/dashboards/${dashboardId}`)

export const useDashboard = (dashboardId: string | undefined) => {
  const client = useApiClient()
  return useQuery({
    placeholderData: keepPreviousData,
    enabled: Boolean(dashboardId),
    queryKey: dashboardKeys.detail(dashboardId),
    queryFn: () => fetchDashboard(client, dashboardId ?? ''),
  })
}

export const useWidgetData = (widgetId: string, options?: { compact?: boolean }) => {
  const client = useApiClient()
  const suffix = options?.compact ? '?compact=true' : ''
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: dashboardKeys.widgetDataView(widgetId, suffix),
    queryFn: () =>
      client.get<DashboardWidgetProjection>(`/api/dashboard-widgets/${widgetId}/data${suffix}`),
    // Dashboard websocket invalidations refresh both the compact card and
    // workspace panel. Focus/reconnect also refetches through React Query;
    // no background poll keeps a static dashboard warm.
    refetchOnWindowFocus: true,
  })
}

export const useRefreshWidgetData = () => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (widgetId: string) =>
      client.post<{ enqueued: boolean; reason?: string }>(
        `/api/dashboard-widgets/${widgetId}/refresh`,
        {},
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.widgetDataAll })
    },
  })
}

export const useDashboardSources = () => {
  const client = useApiClient()
  return useQuery({
    queryKey: dashboardKeys.sources,
    queryFn: () => client.get<DashboardSourceRecord[]>('/api/dashboard-sources'),
  })
}

export const useDashboardVersions = (dashboardId: string | undefined) => {
  const client = useApiClient()
  return useQuery({
    placeholderData: keepPreviousData,
    enabled: Boolean(dashboardId),
    queryKey: dashboardKeys.versions(dashboardId ?? ''),
    queryFn: () =>
      client.get<DashboardVersionRecord[]>(`/api/dashboards/${dashboardId}/versions`),
  })
}

export const useDashboardSourceNotes = (dashboardId: string | undefined) => {
  const client = useApiClient()
  return useQuery({
    placeholderData: keepPreviousData,
    enabled: Boolean(dashboardId),
    queryKey: dashboardKeys.sourceNotes(dashboardId),
    queryFn: () => client.get<DashboardSourceNote[]>(`/api/dashboards/${dashboardId}/source-notes`),
  })
}

export const useCreateDashboard = () => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      title: string
      description?: string
      projectId: string
    }) => client.post<DashboardRecord>('/api/dashboards', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.all }),
  })
}

export const useSaveLayout = (dashboardId: string) => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    // `If-Match` carries the revision the editor started from, so a save that
    // lost a race is refused (409 DASHBOARD_REVISION_CONFLICT) rather than
    // overwriting a widget somebody else moved.
    mutationFn: ({ layout, revision }: { layout: DashboardLayout; revision?: number }) =>
      client.put<DashboardRecord>(
        `/api/dashboards/${dashboardId}/layout`,
        layout,
        revision === undefined ? undefined : { 'if-match': String(revision) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboardId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.versions(dashboardId) })
    },
  })
}

export const useRemoveWidget = (dashboardId: string) => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (widgetId: string) => client.delete(`/api/dashboard-widgets/${widgetId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboardId) }),
  })
}

export const useSetWidgetLock = (dashboardId: string) => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { widgetId: string; locked: boolean }) =>
      client.put(`/api/dashboard-widgets/${input.widgetId}/lock`, { locked: input.locked }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.detail(dashboardId) }),
  })
}
