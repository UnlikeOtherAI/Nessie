/**
 * Data access for the dashboards surface.
 *
 * Widget data is fetched per widget rather than inlined into the dashboard
 * response: each widget resolves its own authorization server-side, so one
 * widget the viewer cannot see renders a lock tile instead of failing the whole
 * page.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DashboardLayout,
  DashboardWidgetProjection,
  WidgetDefinition,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

export type DashboardRecord = {
  id: string
  title: string
  description: string | null
  home: 'organization' | 'project' | 'team' | 'channel' | 'personal'
  projectId: string | null
  teamId: string | null
  channelId: string | null
  ownerUserId: string | null
  layout: DashboardLayout
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
  origin: string
  path: string
  transform: string
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

export const dashboardKeys = {
  all: ['dashboards'] as const,
  detail: (id: string) => ['dashboards', id] as const,
  widgetData: (id: string) => ['dashboard-widget-data', id] as const,
  sources: ['dashboard-sources'] as const,
  versions: (id: string) => ['dashboards', id, 'versions'] as const,
}

export const useDashboards = (filter?: { home?: string; projectId?: string }) => {
  const client = useApiClient()
  const query = new URLSearchParams()
  if (filter?.home) query.set('home', filter.home)
  if (filter?.projectId) query.set('projectId', filter.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ''

  return useQuery({
    queryKey: [...dashboardKeys.all, suffix],
    queryFn: () => client.get<DashboardRecord[]>(`/api/dashboards${suffix}`),
  })
}

export const useDashboard = (dashboardId: string | undefined) => {
  const client = useApiClient()
  return useQuery({
    enabled: Boolean(dashboardId),
    queryKey: dashboardKeys.detail(dashboardId ?? ''),
    queryFn: () =>
      client.get<DashboardRecord & { widgets: DashboardWidgetRecord[] }>(
        `/api/dashboards/${dashboardId}`,
      ),
  })
}

export const useWidgetData = (widgetId: string, options?: { compact?: boolean }) => {
  const client = useApiClient()
  const suffix = options?.compact ? '?compact=true' : ''
  return useQuery({
    queryKey: [...dashboardKeys.widgetData(widgetId), suffix],
    queryFn: () =>
      client.get<DashboardWidgetProjection>(`/api/dashboard-widgets/${widgetId}/data${suffix}`),
    // Viewing never triggers an outbound fetch; this only re-reads the cache
    // the refresh job maintains.
    refetchInterval: 60_000,
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
    enabled: Boolean(dashboardId),
    queryKey: dashboardKeys.versions(dashboardId ?? ''),
    queryFn: () =>
      client.get<DashboardVersionRecord[]>(`/api/dashboards/${dashboardId}/versions`),
  })
}

export const useCreateDashboard = () => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      title: string
      home: string
      projectId?: string
      teamId?: string
      channelId?: string
    }) => client.post<DashboardRecord>('/api/dashboards', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.all }),
  })
}

export const useSaveLayout = (dashboardId: string) => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (layout: DashboardLayout) =>
      client.put<DashboardRecord>(`/api/dashboards/${dashboardId}/layout`, layout),
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
