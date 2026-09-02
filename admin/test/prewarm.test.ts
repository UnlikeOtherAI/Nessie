import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { QueryClient } from '@tanstack/react-query'

import type { ApiClient } from '../src/lib/api-client.js'
import {
  PREWARM_REGISTRY,
  PREWARM_TTL_MS,
  matchPrewarm,
  prewarmRowHandlers,
} from '../src/navigation/prewarm.js'
import {
  agentKeys,
  appKeys,
  channelKeys,
  dashboardKeys,
  knowledgeKeys,
  projectKeys,
  threadKeys,
} from '../src/lib/query-keys.js'

// Step 10 of docs/done/2026-09-01-navigation-motion-system.md (§4.10),
// docs/navigation.md §"Arriving with content".

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const runFor = async (
  to: string,
  queryClient: QueryClient,
  apiClient: ApiClient,
): Promise<void> => {
  const matched = matchPrewarm(to)
  assert.ok(matched, `${to} resolves to a prewarm entry`)
  matched.entry.run(matched.id, { apiClient, queryClient })
  // `prefetchQuery` resolves on a microtask chain; one turn of the loop is
  // enough for the fetcher to have been called and the cache written.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const fakeApiClient = (calls: string[]): ApiClient => ({
  delete: async (path: string) => {
    calls.push(`DELETE ${path}`)
    return null as never
  },
  get: async (path: string) => {
    calls.push(`GET ${path}`)
    return [] as never
  },
  patch: async (path: string) => {
    calls.push(`PATCH ${path}`)
    return null as never
  },
  post: async (path: string) => {
    calls.push(`POST ${path}`)
    return null as never
  },
  put: async (path: string) => {
    calls.push(`PUT ${path}`)
    return null as never
  },
})

test('the registry maps each destination to its screen\'s own keys and fetchers', async () => {
  const calls: string[] = []
  const apiClient = fakeApiClient(calls)
  const queryClient = new QueryClient()
  // The channel entry resolves its thread out of the cached channel list, the
  // way the screen does — a prewarm that had to fetch to know what to fetch
  // would be slower than the screen it is warming.
  queryClient.setQueryData(channelKeys.all, [
    { defaultThreadId: 'thread-9', id: 'chan-1' },
  ])

  await runFor('/channels/chan-1', queryClient, apiClient)
  await runFor('/projects/proj-1/board', queryClient, apiClient)
  await runFor('/agents/agent-1', queryClient, apiClient)
  await runFor('/dashboards/dash-1', queryClient, apiClient)
  await runFor('/knowledge-base/spaces/space-1', queryClient, apiClient)
  await runFor('/apps/linear', queryClient, apiClient)

  assert.deepEqual(calls, [
    'GET /api/threads/thread-9/messages',
    'GET /api/projects/proj-1/board',
    'GET /api/agents/agent-1/status',
    'GET /api/dashboards/dash-1',
    'GET /api/knowledge-base/spaces/space-1',
    'GET /api/knowledge-base/spaces/space-1/pages',
    'GET /api/apps/linear',
  ])

  // Written under the exact keys the destination's hooks read, or the screen
  // would fetch it all again on arrival.
  for (const key of [
    threadKeys.messages('thread-9'),
    projectKeys.board('proj-1'),
    agentKeys.status('agent-1'),
    dashboardKeys.detail('dash-1'),
    knowledgeKeys.space('space-1'),
    knowledgeKeys.pages('space-1'),
    appKeys.detail('linear'),
  ]) {
    assert.notEqual(
      queryClient.getQueryState([...key]),
      undefined,
      `prewarm wrote ${JSON.stringify(key)}`,
    )
  }
})

test('a channel with no cached record warms nothing rather than guessing', async () => {
  const calls: string[] = []
  const queryClient = new QueryClient()
  await runFor('/channels/unknown', queryClient, fakeApiClient(calls))
  assert.deepEqual(calls, [])
})

test('every project section route warms the same board, and a screen with no id does not match', () => {
  for (const section of ['', '/board', '/backlog', '/insights', '/docs', '/executors', '/settings']) {
    const matched = matchPrewarm(`/projects/proj-7${section}`)
    assert.equal(matched?.id, 'proj-7', `/projects/proj-7${section}`)
  }
  // Query and hash are not part of the destination's identity.
  assert.equal(matchPrewarm('/channels/chan-2?tab=files')?.id, 'chan-2')
  // Roots and id-less screens have nothing to warm.
  for (const path of ['/channels', '/projects', '/dashboards', '/apps', '/settings', '/']) {
    assert.equal(matchPrewarm(path), null, path)
  }
})

test("a row's pointerdown prefetches once inside the TTL", async () => {
  const calls: string[] = []
  const apiClient = fakeApiClient(calls)
  const queryClient = new QueryClient()

  // The hook's body, without React: the same TTL map, the same guard.
  const recent = new Map<string, number>()
  const prewarm = (to: string) => {
    const matched = matchPrewarm(to)
    if (!matched) return
    const now = Date.now()
    const seen = recent.get(to)
    if (seen !== undefined && now - seen < PREWARM_TTL_MS) return
    recent.set(to, now)
    matched.entry.run(matched.id, { apiClient, queryClient })
  }

  const handlers = prewarmRowHandlers(prewarm, '/apps/linear')
  handlers.onFocus()
  handlers.onPointerDown()
  handlers.onTouchStart()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(calls, ['GET /api/apps/linear'], 'the burst costs one request')

  // A different destination is not suppressed by the first one's entry.
  prewarm('/dashboards/dash-2')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['GET /api/apps/linear', 'GET /api/dashboards/dash-2'])
})

test('prewarm never spells a fetch of its own', () => {
  const source = readSource('../src/navigation/prewarm.ts')
  // Every entry calls an imported `fetch*` from the destination's own facade.
  // A URL literal here would be a second fetcher, and the first divergence
  // would fill the cache under the right key with the wrong shape.
  assert.doesNotMatch(source, /['"`]\/api\//)
  assert.match(source, /import \{ fetchThreadMessages \} from/)
})

test('navigating rows prewarm before the click', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  // Each of these renders rows that push a prewarmable destination. Adding a
  // new navigating list means wiring it here too — an unwarmed row is a screen
  // that lands empty after a 300 ms slide.
  const wiredRows = [
    'admin/src/layouts/admin-shell/SidebarChannelsSection.tsx',
    'admin/src/layouts/admin-shell/SidebarProjectsSection.tsx',
    'admin/src/layouts/admin-shell/SidebarDmSection.tsx',
    'admin/src/layouts/admin-shell/SidebarStarredSection.tsx',
    'admin/src/components/features/knowledge/KnowledgeSpaceList.tsx',
    'admin/src/components/features/agents/AgentListRow.tsx',
    'admin/src/components/features/apps/AppCard.tsx',
    'admin/src/pages/DashboardsPage.tsx',
  ]
  const tracked = new Set(
    execSync("git ls-files 'admin/src/*'", { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )

  for (const file of wiredRows) {
    assert.ok(tracked.has(file), `${file} is tracked`)
    const content = readFileSync(`${repoRoot}/${file}`, 'utf8')
    assert.match(content, /prewarmRowHandlers\(/, `${file} wires prewarm onto its rows`)
  }
})

test('the registry is a small closed set, not a growing switch', () => {
  assert.equal(PREWARM_REGISTRY.length, 6)
})
