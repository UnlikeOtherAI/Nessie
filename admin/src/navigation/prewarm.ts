// Prewarm: put a destination's first query in flight before the push starts.
//
// The stack slides for 300 ms and, until this existed, nothing used that time —
// no `prefetchQuery` or `ensureQueryData` appeared anywhere in the admin, so a
// tap started its fetch after the slide had already begun and the screen landed
// empty. Every row that navigates already holds the destination id at render,
// so the fetch can start on `pointerdown` — before the click, before the push.
//
// Two rules make this safe to wire onto ordinary rows:
//
// 1. **Never a second fetcher.** A registry entry calls the exact `fetch*`
//    function the destination's hook calls, under the exact key from
//    `lib/query-keys.ts`. Spelling a URL here would fill the cache under the
//    right key with a shape that drifts the first time the hook changes.
// 2. **No storms.** `pointerdown` and `focus` both fire cheaply and often, so a
//    short-TTL set remembers what was recently prewarmed and a repeat inside
//    the window is a no-op. `prefetchQuery` additionally honours `staleTime`,
//    so a warm entry costs no request even if the set has expired.
//
// Rulebook: `docs/navigation.md` §"Arriving with content". Plan: step 10 of
// `docs/done/2026-09-01-navigation-motion-system.md` (§4.10).

import { useCallback, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ApiClient, ChannelRecord } from '../lib/api-client'
import {
  appKeys,
  channelKeys,
  dashboardKeys,
  knowledgeKeys,
  projectKeys,
  agentKeys,
  threadKeys,
} from '../lib/query-keys'
import { useApiClient } from '../providers/ApiClientProvider'
import { fetchAgentStatus } from '../facades/agents/queries'
import { fetchApp } from '../facades/apps/hooks'
import { fetchProjectBoard } from '../facades/board/hooks'
import { fetchDashboard } from '../facades/dashboards/hooks'
import {
  fetchKnowledgeSpace,
  fetchKnowledgeSpacePages,
} from '../facades/knowledge/hooks'
import { fetchThreadMessages } from '../facades/threads/queries'
import { normalizeNavigationPathname } from './surfaces'

/**
 * How long a prewarmed destination stays "recently prewarmed". Long enough to
 * absorb the focus/pointerdown/click burst of one interaction and a person
 * running down a list, short enough that coming back to a row a few seconds
 * later re-checks freshness.
 */
export const PREWARM_TTL_MS = 10_000

type PrewarmContext = {
  apiClient: ApiClient
  queryClient: QueryClient
}

type PrewarmEntry = {
  /** Which destinations this entry answers for; the capture is the entity id. */
  pattern: RegExp
  run: (id: string, context: PrewarmContext) => void
}

const prefetch = (
  { queryClient }: PrewarmContext,
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
): void => {
  // Deliberately fire-and-forget with the rejection swallowed: a prewarm that
  // fails is not an error a person should ever see — the screen's own query
  // runs on arrival and owns the error state.
  void queryClient
    .prefetchQuery({ queryFn, queryKey, staleTime: PREWARM_TTL_MS })
    .catch(() => undefined)
}

/**
 * Destination path → the queries that destination's screen reads first.
 *
 * A channel's own record comes from the already-cached channel list, so what is
 * worth warming is the thread behind it: the feed is the screen. The id is read
 * out of that cached list rather than fetched, because a prewarm that has to
 * fetch to know what to fetch is slower than the screen itself.
 */
export const PREWARM_REGISTRY: PrewarmEntry[] = [
  {
    pattern: /^\/channels\/([^/]+)$/,
    run: (channelId, context) => {
      const channels = context.queryClient.getQueryData<ChannelRecord[]>(channelKeys.all)
      const threadId = channels?.find((channel) => channel.id === channelId)?.defaultThreadId
      if (!threadId) return
      prefetch(context, threadKeys.messages(threadId), () =>
        fetchThreadMessages(context.apiClient, threadId))
    },
  },
  {
    // The seven project section routes are one screen (`surfaces.ts` gives them
    // one tabHost identity), and every one of them reads the board.
    pattern: /^\/projects\/([^/]+)(?:\/(?:board|backlog|insights|docs|executors|settings))?$/,
    run: (projectId, context) => {
      prefetch(context, projectKeys.board(projectId), () =>
        fetchProjectBoard(context.apiClient, projectId))
    },
  },
  {
    pattern: /^\/agents\/([^/]+)$/,
    run: (agentId, context) => {
      prefetch(context, agentKeys.status(agentId), () =>
        fetchAgentStatus(context.apiClient, agentId))
    },
  },
  {
    pattern: /^\/dashboards\/([^/]+)$/,
    run: (dashboardId, context) => {
      prefetch(context, dashboardKeys.detail(dashboardId), () =>
        fetchDashboard(context.apiClient, dashboardId))
    },
  },
  {
    pattern: /^\/knowledge-base\/spaces\/([^/]+)$/,
    run: (spaceId, context) => {
      prefetch(context, knowledgeKeys.space(spaceId), () =>
        fetchKnowledgeSpace(context.apiClient, spaceId))
      prefetch(context, knowledgeKeys.pages(spaceId), () =>
        fetchKnowledgeSpacePages(context.apiClient, spaceId))
    },
  },
  {
    pattern: /^\/apps\/([^/]+)$/,
    run: (slug, context) => {
      prefetch(context, appKeys.detail(slug), () => fetchApp(context.apiClient, slug))
    },
  },
]

/** The registry row a destination path resolves to, or null. */
export const matchPrewarm = (
  to: string,
): { entry: PrewarmEntry; id: string } | null => {
  const pathname = normalizeNavigationPathname(to)
  for (const entry of PREWARM_REGISTRY) {
    const match = entry.pattern.exec(pathname)
    // A screen that pushes no id (`/agents/designer`) is not a prewarm target;
    // the surface registry owns those as their own rows.
    if (match?.[1]) return { entry, id: decodeURIComponent(match[1]) }
  }
  return null
}

/**
 * `prewarm(to)` — call it from a navigating row's `pointerdown`, `touchstart`
 * or `focus`, with the same path the row's click will push.
 */
export const usePrewarm = (): ((to: string) => void) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  // Per-hook rather than module-global: the map is cleared with the component
  // tree, so a signed-out session leaves nothing behind.
  const recent = useRef(new Map<string, number>())

  return useCallback((to: string) => {
    const matched = matchPrewarm(to)
    if (!matched) return

    const now = Date.now()
    const seen = recent.current.get(to)
    if (seen !== undefined && now - seen < PREWARM_TTL_MS) return
    for (const [path, at] of recent.current) {
      if (now - at >= PREWARM_TTL_MS) recent.current.delete(path)
    }
    recent.current.set(to, now)

    matched.entry.run(matched.id, { apiClient, queryClient })
  }, [apiClient, queryClient])
}

export type PrewarmRowHandlers = {
  onFocus: () => void
  onPointerDown: () => void
  onTouchStart: () => void
}

/**
 * The handlers a navigating row spreads onto its element. `pointerdown` fires
 * before `click`, `touchstart` before either on iOS, and `focus` covers
 * keyboard navigation — all three land on the same TTL-guarded call, so a row
 * that fires two of them still prewarms once.
 *
 * A plain function rather than a hook: rows are built inside `.map()`, where a
 * hook cannot be called.
 */
export const prewarmRowHandlers = (
  prewarm: (to: string) => void,
  to: string,
): PrewarmRowHandlers => {
  const fire = () => prewarm(to)
  return { onFocus: fire, onPointerDown: fire, onTouchStart: fire }
}
