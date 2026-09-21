import { ApiClientError, type ApiClient } from '@nessie/client-core'
import {
  TaskSetCreateSchema, TaskSetItemInputSchema, TaskSetUpdateSchema,
  type TaskSetItemRecord, type TaskSetProcessorOption, type TaskSetRecord,
} from '@nessie/schemas'

export const ids = {
  set: '00000000-0000-4000-8000-000000000001', host: '00000000-0000-4000-8000-000000000002',
  binding: '00000000-0000-4000-8000-000000000003', space: '00000000-0000-4000-8000-000000000004',
  page: '00000000-0000-4000-8000-000000000005', version: '00000000-0000-4000-8000-000000000006',
  agent: '00000000-0000-4000-8000-000000000007', channel: '00000000-0000-4000-8000-000000000008',
}
const now = '2026-09-21T10:00:00.000Z'
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'create'
const processors: TaskSetProcessorOption[] = [{
  id: 'local', label: 'Qwen 3 8B', provider: 'local/ollama', model: 'qwen3:8b',
  localInferenceBindingId: ids.binding, localInferenceHostId: ids.host,
  source: 'local', resourceLabel: 'Mac mini', available: true, reason: null, setupUrl: null,
}, {
  id: 'setup', label: 'Local model needs consent', provider: 'local/ollama', model: 'unbound',
  source: 'local', resourceLabel: null, available: false, reason: 'Requires exact model consent.',
  setupUrl: '/agents/executors',
}, {
  id: 'hosted', label: 'Hosted research model', provider: 'openai', model: 'research',
  source: 'ledger', resourceLabel: null, available: true, reason: null, setupUrl: null,
}]
let set: TaskSetRecord = {
  id: ids.set, name: 'Company enrichment', objective: 'Research every company in order.',
  instructions: 'Return a short summary and source URLs.',
  processor: { provider: 'local/ollama', model: 'qwen3:8b', localInferenceBindingId: ids.binding },
  source: null, output: { kind: 'journal' }, receiver: null,
  maxParallelRequests: 1, maxAttempts: 3, search: 'processor',
  status: scenario === 'blocked' ? 'blocked' : 'draft', reason: null,
  createdAt: now, statusChangedAt: now, totalItems: scenario === 'create' ? 0 : 30,
  completedItems: 0, skippedItems: 0, currentItemId: null, originThreadId: null,
  originMessageId: null, outputPageId: null, deliveryStatus: 'none',
}
let items: TaskSetItemRecord[] = Array.from({ length: set.totalItems }, (_, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, taskSetId: ids.set,
  sequence: index + 1, prompt: `Research company ${index + 1}`, input: { company: `Company ${index + 1}` },
  dependencies: [], sourceLocator: `Sheet Companies · row ${index + 2}`,
  status: index === 0 && scenario === 'blocked' ? 'failed' : 'pending',
  createdAt: now, statusChangedAt: now, attempts: index === 0 ? 3 : 0,
  reason: index === 0 && scenario === 'blocked' ? 'Dependency context exceeds the model capacity. Edit the input before retrying.' : null,
  result: null, outputPageId: null,
}))
let paused = false
let capacity = 1
let denyResume = false
let uncertain = false
const calls: Array<{ method: string; path: string; body?: unknown }> = []

const file = {
  id: ids.page, spaceId: ids.space, title: 'companies.xlsx', kind: 'file',
  latestVersion: { id: ids.version },
}
const host = () => ({
  id: ids.host, availability: 'online', executorId: 'mini', models: [{ name: 'qwen3:8b', manifestDigest: 'a'.repeat(64) }],
  paused, status: 'active', transport: 'executor', lastSeenAt: now,
  resource: { resourceId: ids.host, capacity, paused, controlRevision: 1,
    healthReason: uncertain ? 'termination_uncertain' : null },
})
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const responsePage = <T,>(all: T[], path: string) => {
  const params = new URLSearchParams(path.split('?')[1])
  const limit = Number(params.get('limit') ?? 25)
  const cursor = Number(params.get('cursor') ?? 0)
  const offset = params.get('direction') === 'backward' ? Math.max(0, cursor - limit) : cursor
  return { data: clone(all.slice(offset, offset + limit)), meta: {
    limit, total: all.length, hasMore: offset + limit < all.length,
    nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    prevCursor: offset > 0 ? String(offset) : null,
  } }
}
const post = async (path: string, body: unknown) => {
  calls.push({ method: 'POST', path, body: clone(body) })
  if (path === '/api/task-sets') {
    const input = TaskSetCreateSchema.parse(body)
    set = { ...set, ...input, source: input.source ?? null, receiver: input.receiver ?? null }
    return clone(set)
  }
  if (path.endsWith('/items')) {
    const input = TaskSetItemInputSchema.parse((body as { items: unknown[] }).items[0])
    const item: TaskSetItemRecord = {
      ...input, id: crypto.randomUUID(), taskSetId: ids.set, sequence: items.length + 1,
      input: input.input ?? null, dependencies: input.dependencies ?? [], sourceLocator: null,
      status: 'pending', createdAt: now, statusChangedAt: now, attempts: 0, reason: null, result: null, outputPageId: null,
    }
    items.push(item)
    set.totalItems = items.length
    return [clone(item)]
  }
  if (path.includes('/local-inference/hosts/')) {
    if (path.endsWith('/capacity')) capacity = (body as { capacity: number }).capacity
    else paused = path.endsWith('/pause')
    return {}
  }
  const action = (body as { action: string; itemId?: string }).action
  if (action === 'resume' && denyResume) {
    throw new ApiClientError('Source access was revoked. Choose an accessible source before resuming.', 'SOURCE_ACCESS_REVOKED', 403)
  }
  if (action === 'start' || action === 'resume' || action === 'retry') set.status = 'running'
  if (action === 'pause') set.status = 'paused'
  if (action === 'cancel') set.status = 'cancelled'
  if (action === 'skip') { items[0]!.status = 'skipped'; set.skippedItems += 1; set.status = 'paused' }
  set.reason = null
  set.statusChangedAt = new Date().toISOString()
  return clone(set)
}

export const client = {
  get: async (path: string) => {
    if (path === '/api/task-sets/processors') return clone(processors)
    if (path === '/api/local-inference/hosts') return { hosts: [host()], meta: { total: 1 } }
    if (path.startsWith('/api/agents')) return [{ id: ids.agent, name: 'Report writer' }]
    if (path === '/api/channels') return [{ id: ids.channel, label: 'Research team' }]
    if (path.startsWith('/api/knowledge-base/spaces/') && path.includes('/pages')) return [file]
    if (path.startsWith('/api/knowledge-base/pages/')) return file
    if (path.includes('/items/')) return clone(items.find((item) => path.endsWith(item.id)))
    if (path === `/api/task-sets/${ids.set}`) return clone(set)
    throw new Error(`Unexpected GET ${path}`)
  },
  getPage: async (path: string) => {
    calls.push({ method: 'GET', path })
    if (path.startsWith('/api/knowledge-base/spaces')) return responsePage([{ id: ids.space, name: 'Research' }], path)
    return path.includes('/items') ? responsePage(items, path) : responsePage([set], path)
  },
  post,
  patch: async (path: string, body: unknown) => {
    calls.push({ method: 'PATCH', path, body: clone(body) })
    if (path.includes('/items/')) {
      const item = items.find((candidate) => path.endsWith(candidate.id))!
      Object.assign(item, body)
      return clone(item)
    }
    Object.assign(set, TaskSetUpdateSchema.parse(body))
    return clone(set)
  },
} as unknown as ApiClient

/** Test-only worker events. This fixture proves UI and request wiring, not execution. */
Object.assign(window, { taskSetFixture: {
  calls, snapshot: () => clone({ set, items }),
  event: (name: string) => {
    if (name === 'denied') denyResume = true
    if (name === 'uncertain') uncertain = true
    if (name === 'waiting') { set.status = 'waiting'; set.reason = 'Waiting for Mac mini to reconnect.' }
    if (name === 'stopping') { set.status = 'paused'; set.currentItemId = items[0]?.id ?? null }
    if (name === 'completed') {
      set.status = 'completed'; set.completedItems = items.length; set.currentItemId = null; set.reason = null
      items = items.map((item) => ({ ...item, status: 'completed', reason: null,
        result: 'Verified company summary. Source: https://example.com' }))
    }
    if (name === 'delivery') { set.status = 'completed'; set.deliveryStatus = 'blocked'; set.reason = 'Output folder access was revoked.' }
    set.statusChangedAt = new Date().toISOString()
  },
} })
