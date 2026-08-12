import {
  ChannelIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  type PushSurface,
} from '@nessie/schemas'
import { z } from 'zod'

export const PUSH_SURFACE_CHANGE_EVENT = 'nessie:push-surface-change'

/**
 * Route paths cannot identify the selected Knowledge space. The shared
 * workspace reports its structural target so another Docs space never
 * suppresses a notification for the document the user actually needs to see.
 */
export const reportPushSurface = (surface: PushSurface | null): void => {
  window.dispatchEvent(new CustomEvent<PushSurface | null>(PUSH_SURFACE_CHANGE_EVENT, {
    detail: surface,
  }))
}

const UUID_PATH_SEGMENT = '[0-9a-f-]{36}'
const THREAD_PATH = new RegExp(
  `^/channels/(${UUID_PATH_SEGMENT})/threads/(${UUID_PATH_SEGMENT})/replies/${UUID_PATH_SEGMENT}/?$`,
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
  if (channelId.success && threadId.success) {
    return { channelId: channelId.data, kind: 'channel', threadId: threadId.data }
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
