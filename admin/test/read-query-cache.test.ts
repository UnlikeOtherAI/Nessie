import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { MeResponse } from '@nessie/schemas'
import {
  createReadQueryCache, READ_CACHE_KEY, READ_CACHE_MAX_AGE, READ_CACHE_MAX_CHARS,
} from '../src/lib/read-query-cache.js'
import { projectCachedRead, readCacheScope } from '../src/providers/read-cache-policy.js'
import { projectKeys } from '../src/facades/projects/keys.js'
import { threadKeys } from '../src/facades/threads/keys.js'
import { taskKeys } from '../src/facades/tasks/keys.js'

const createStore = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
const NOW = 1_800_000_000_000
const project = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  name: 'Saved project', avatarEmoji: null, avatarAttachmentId: null,
  memberCount: 1, createdAt: '2026-09-26T00:00:00.000Z',
}
const harness = (storage = createStore(), now = NOW) => {
  const queryClient = client()
  const cache = createReadQueryCache({
    queryClient, storage: () => storage, project: projectCachedRead, now: () => now,
  })
  cache.start()
  cache.activate('account-a')
  return { queryClient, cache, storage }
}
const save = () => {
  const state = harness()
  state.queryClient.setQueryData(projectKeys.all, [project], { updatedAt: NOW })
  state.cache.stop()
  return state.storage
}

test('reload renders the exact cached project immediately and revalidates even Infinity-fresh reads', async () => {
  const { cache, queryClient } = harness(save())
  let resolve: ((data: typeof project[]) => void) | undefined
  const observer = new QueryObserver(queryClient, {
    queryKey: projectKeys.all,
    queryFn: () => new Promise<typeof project[]>((done) => { resolve = done }),
    staleTime: Infinity,
  })
  const unsubscribe = observer.subscribe(() => undefined)
  assert.deepEqual(observer.getCurrentResult().data, [project])
  assert.equal(observer.getCurrentResult().isLoading, false)
  assert.equal(observer.getCurrentResult().isFetching, true)
  resolve?.([{ ...project, name: 'Updated project' }])
  await new Promise((done) => setTimeout(done, 0))
  assert.equal(observer.getCurrentResult().data?.[0]?.name, 'Updated project')
  unsubscribe()
  cache.stop()
  queryClient.clear()
})

test('snapshots exclude private content, membership decisions and malformed records', () => {
  const { cache, queryClient, storage } = harness()
  queryClient.setQueryData(projectKeys.all, [project], { updatedAt: NOW })
  queryClient.setQueryData(projectKeys.members(project.id), [{ role: 'owner' }], { updatedAt: NOW })
  queryClient.setQueryData(threadKeys.messages('room'), { content: 'Private message' }, { updatedAt: NOW })
  queryClient.setQueryData(taskKeys.checklist('ticket'), { result: 'Private research' }, { updatedAt: NOW })
  queryClient.setQueryData(projectKeys.boards(project.id), [{ invalid: true }], { updatedAt: NOW })
  cache.stop()
  const raw = storage.getItem(READ_CACHE_KEY) ?? ''
  assert.equal(JSON.parse(raw).entries.length, 1)
  assert.ok(!raw.includes('Private'))
  queryClient.clear()
})

test('a different account, expired snapshot, future date, or malformed storage restores nothing', () => {
  for (const mode of ['account', 'expired', 'future', 'corrupt', 'version']) {
    const storage = save()
    const raw = JSON.parse(storage.getItem(READ_CACHE_KEY)!)
    if (mode === 'account') raw.scope = 'another-account'
    if (mode === 'future') raw.entries[0].updatedAt = NOW + 1
    if (mode === 'version') raw.version = 900
    storage.setItem(READ_CACHE_KEY, mode === 'corrupt' ? '{' : JSON.stringify(raw))
    const state = harness(storage, mode === 'expired' ? NOW + READ_CACHE_MAX_AGE : NOW)
    assert.equal(state.queryClient.getQueryData(projectKeys.all), undefined, mode)
    state.cache.stop()
    state.queryClient.clear()
  }
})

test('logout fences scheduled saves and late completions before clearing memory', () => {
  const { cache, queryClient, storage } = harness(save())
  queryClient.setQueryData(projectKeys.all, [project], { updatedAt: NOW })
  cache.clear()
  queryClient.setQueryData(projectKeys.all, [{ ...project, name: 'Late old response' }], { updatedAt: NOW })
  cache.flush()
  cache.stop()
  assert.equal(storage.getItem(READ_CACHE_KEY), null)
  queryClient.clear()
})

test('server denial removes stale content and its disk copy; a network failure preserves the last read', async () => {
  for (const status of [403, 404, 500]) {
    const { cache, queryClient, storage } = harness(save())
    await assert.rejects(queryClient.fetchQuery({
      queryKey: projectKeys.all,
      queryFn: () => Promise.reject(Object.assign(new Error('read failed'), { status })),
    }))
    assert.equal(queryClient.getQueryData(projectKeys.all) !== undefined, status === 500)
    cache.stop()
    assert.equal(JSON.parse(storage.getItem(READ_CACHE_KEY)!).entries.length, status === 500 ? 1 : 0)
    queryClient.clear()
  }
})

test('storage denial never prevents live query use', () => {
  const queryClient = client()
  const cache = createReadQueryCache({
    queryClient, project: projectCachedRead,
    storage: () => { throw new Error('storage denied') }, now: () => NOW,
  })
  cache.start()
  assert.doesNotThrow(() => cache.activate('account-a'))
  queryClient.setQueryData(projectKeys.all, [project], { updatedAt: NOW })
  assert.doesNotThrow(cache.stop)
  assert.deepEqual(queryClient.getQueryData(projectKeys.all), [project])
  queryClient.clear()
})

test('oversized entries cannot crowd smaller reads out of the bounded snapshot', () => {
  const { cache, queryClient, storage } = harness()
  queryClient.setQueryData(projectKeys.all, [{ ...project, description: 'x'.repeat(READ_CACHE_MAX_CHARS) }],
    { updatedAt: NOW })
  queryClient.setQueryData(projectKeys.boards(project.id), [], { updatedAt: NOW })
  cache.stop()
  const raw = storage.getItem(READ_CACHE_KEY)!
  assert.ok(raw.length <= READ_CACHE_MAX_CHARS)
  assert.deepEqual(JSON.parse(raw).entries.map((entry: { key: unknown }) => entry.key),
    [projectKeys.boards(project.id)])
  queryClient.clear()
})

test('quota failure removes the old snapshot while memory remains usable', () => {
  const storage = save()
  const queryClient = client()
  const cache = createReadQueryCache({
    queryClient, now: () => NOW, project: projectCachedRead,
    storage: () => ({ ...storage, setItem: () => { throw new Error('quota exceeded') } }),
  })
  cache.activate('account-a')
  cache.flush()
  assert.equal(storage.getItem(READ_CACHE_KEY), null)
  assert.deepEqual(queryClient.getQueryData(projectKeys.all), [project])
  cache.stop()
  queryClient.clear()
})

test('scope follows server, person, tenant and entitlements, but ignores token rotation and display names', () => {
  const me = {
    user: { id: 'person', roleIds: ['member'], superAdmin: false, displayName: 'First' },
    context: { organizationId: 'org', projectId: 'project', teamId: 'team' },
    memberships: [{ organizationId: 'org', role: 'member', projects: [] }],
  } as unknown as MeResponse
  const scope = readCacheScope('https://server-a', me)
  assert.equal(readCacheScope('https://server-a', { ...me, user: { ...me.user, displayName: 'Renamed' } }), scope)
  assert.notEqual(readCacheScope('https://server-b', me), scope)
  assert.notEqual(readCacheScope('https://server-a', { ...me, user: { ...me.user, id: 'other' as never } }), scope)
  assert.notEqual(readCacheScope('https://server-a', { ...me, context: { ...me.context, teamId: 'other' as never } }), scope)
  assert.notEqual(readCacheScope('https://server-a', { ...me, user: { ...me.user, roleIds: ['owner'] } }), scope)
})
