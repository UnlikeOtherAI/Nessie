import {
  ChannelIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  PushSurfaceSchema,
  type PushSurface,
} from '@nessie/schemas'
import { z } from 'zod'

export const PUSH_SURFACE_CHANGE_EVENT = 'nessie:push-surface-change'

export type PushSurfaceRoute = {
  pathname: string
  search: string
}

export type PushSurfaceReport = PushSurfaceRoute & {
  surface: PushSurface | null
}

let latestPushSurfaceReport: PushSurfaceReport | null = null

export const getPushSurfaceRouteKey = (route: PushSurfaceRoute): string =>
  `${route.pathname}${route.search}`

export const getLatestPushSurfaceReport = (): PushSurfaceReport | null =>
  latestPushSurfaceReport

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parsePushSurfaceReport = (value: unknown): PushSurfaceReport | null => {
  if (!isRecord(value) || typeof value.pathname !== 'string' || typeof value.search !== 'string') {
    return null
  }
  if (value.surface === null) {
    return { pathname: value.pathname, search: value.search, surface: null }
  }
  const surface = PushSurfaceSchema.safeParse(value.surface)
  return surface.success
    ? { pathname: value.pathname, search: value.search, surface: surface.data }
    : null
}

/** Returns a selected-surface override only while it belongs to this route. */
export const resolveReportedPushSurface = (
  report: PushSurfaceReport | null,
  route: PushSurfaceRoute,
): PushSurface | null | undefined =>
  report && getPushSurfaceRouteKey(report) === getPushSurfaceRouteKey(route)
    ? report.surface
    : undefined

/**
 * Route paths cannot identify the selected Knowledge space. The shared
 * workspace reports its structural target so another Docs space never
 * suppresses a notification for the document the user actually needs to see.
 * It also lets channel tabs explicitly clear their conversation target while
 * Files, Info, or Runs is focused without leaking that clear to another route.
 */
export const reportPushSurface = (
  surface: PushSurface | null,
  route: PushSurfaceRoute = { pathname: window.location.pathname, search: window.location.search },
): void => {
  latestPushSurfaceReport = { ...route, surface }
  window.dispatchEvent(new CustomEvent<PushSurfaceReport>(PUSH_SURFACE_CHANGE_EVENT, {
    detail: latestPushSurfaceReport,
  }))
}

const UUID_PATH_SEGMENT = '[0-9a-f-]{36}'
const THREAD_PATH = new RegExp(
  `^/channels/(${UUID_PATH_SEGMENT})/threads/(${UUID_PATH_SEGMENT})/replies/(${UUID_PATH_SEGMENT})/?$`,
  'i',
)
const PROJECT_BOARD_PATH = new RegExp(
  `^/projects/(${UUID_PATH_SEGMENT})/board/?$`,
  'i',
)

/** Maps only concrete, push-targetable routes to the structured API contract. */
export const resolvePushSurface = (pathname: string, search = ''): PushSurface | null => {
  const threadRoute = pathname.match(THREAD_PATH)
  const channelId = ChannelIdSchema.safeParse(threadRoute?.[1])
  const threadId = ThreadIdSchema.safeParse(threadRoute?.[2])
  const rootMessageId = z.string().uuid().safeParse(threadRoute?.[3])
  if (channelId.success && threadId.success && rootMessageId.success) {
    return {
      channelId: channelId.data,
      kind: 'channel',
      rootMessageId: rootMessageId.data,
      threadId: threadId.data,
    }
  }
  const project = pathname.match(PROJECT_BOARD_PATH)
  const projectId = ProjectIdSchema.safeParse(project?.[1])
  if (projectId.success) {
    return { kind: 'project_board', projectId: projectId.data }
  }
  if (pathname === '/knowledge-base' || /^\/projects\/[0-9a-f-]{36}\/docs\/?$/i.test(pathname)) {
    const spaceId = new URLSearchParams(search).get('spaceId')
    if (spaceId && z.string().uuid().safeParse(spaceId).success) {
      return { kind: 'knowledge_space', spaceId }
    }
  }
  return pathname === '/ops/usage' ? { kind: 'ops_usage' } : null
}
