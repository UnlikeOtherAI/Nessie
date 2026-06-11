import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCredentials } from './employee.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const API_URL = process.env.NESSIE_API ?? 'http://localhost:5454'

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000
const TOKEN_CACHE_PATH = resolve(__dirname, '../state/tokens.json')

type CacheEntry = { token: string; userId: string; obtainedAt: number }
const tokenCache: Map<string, CacheEntry> = (() => {
  const m = new Map<string, CacheEntry>()
  if (existsSync(TOKEN_CACHE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf8')) as Record<string, CacheEntry>
      for (const [k, v] of Object.entries(raw)) m.set(k, v)
    } catch {
      // ignore corrupt cache
    }
  }
  return m
})()

const persistTokens = (): void => {
  mkdirSync(dirname(TOKEN_CACHE_PATH), { recursive: true })
  const obj: Record<string, CacheEntry> = {}
  for (const [k, v] of tokenCache.entries()) obj[k] = v
  writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(obj, null, 2), 'utf8')
}

type LoginResponse = {
  data: {
    token: string
    me: { user: { id: string } }
  }
}

const login = async (slug: string): Promise<{ token: string; userId: string }> => {
  const credentials = getCredentials(slug)
  const res = await fetch(`${API_URL}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  })
  if (!res.ok) throw new Error(`login ${slug} ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as LoginResponse
  return { token: body.data.token, userId: body.data.me.user.id }
}

export const getToken = async (slug: string): Promise<{ token: string; userId: string }> => {
  const cached = tokenCache.get(slug)
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) {
    return { token: cached.token, userId: cached.userId }
  }
  const fresh = await login(slug)
  tokenCache.set(slug, { ...fresh, obtainedAt: Date.now() })
  persistTokens()
  return fresh
}

const request = async <T>(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> => {
  const wantsBody = method !== 'GET' && method !== 'DELETE'
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(wantsBody ? { 'content-type': 'application/json' } : {}),
    },
    body: wantsBody ? JSON.stringify(body ?? {}) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!text) return undefined as T
  const parsed = JSON.parse(text) as { data?: T } | T
  return ((parsed as { data?: T }).data ?? (parsed as T))
}

export const invalidateToken = (slug: string): void => {
  tokenCache.delete(slug)
  persistTokens()
}

export type Channel = {
  id: string
  label: string
  type: 'standard' | 'dm'
  visibility: 'public' | 'protected' | 'private'
  defaultThreadId: string
  systemChannelType?: string
}

export type Agent = {
  id: string
  name: string
  role: string
  systemPrompt?: string
  provider?: string
  model?: string
  channelIds: string[]
  agentKind?: string
}

export type WorkflowTemplate = {
  id: string
  name: string
  description?: string | null
}

export type WorkflowInstallation = {
  id: string
  workflowTemplateId: string
  name: string
}

export const listChannels = (token: string): Promise<Channel[]> => request(token, 'GET', '/api/channels')

export const createChannel = (
  token: string,
  body: { label: string; visibility?: 'public' | 'protected' | 'private' },
): Promise<Channel> => request(token, 'POST', '/api/channels', body)

export const listAgents = (token: string): Promise<Agent[]> => request(token, 'GET', '/api/agents')

export const listUsers = (token: string): Promise<{ id: string; email: string; displayName: string }[]> =>
  request(token, 'GET', '/api/users')

export const createAgent = (
  token: string,
  body: { name: string; role?: string; systemPrompt?: string; provider?: string; model?: string },
): Promise<Agent> => request(token, 'POST', '/api/agents', body)

export const bindAgent = (token: string, agentId: string, channelId: string): Promise<unknown> =>
  request(token, 'POST', `/api/agents/${agentId}/bindings`, { channelId })

export const createDmChannel = (token: string, targetUserId: string): Promise<Channel> =>
  request(token, 'POST', `/api/dm/${targetUserId}`)

export const postMessage = (token: string, threadId: string, content: string): Promise<unknown> =>
  request(token, 'POST', `/api/threads/${threadId}/messages`, { content })

export const bootstrapPersonalAssistant = (token: string): Promise<unknown> =>
  request(token, 'POST', '/api/personal-assistant/bootstrap', {})

export const getPersonalAssistant = (token: string): Promise<{ agent: Agent | null; channel: Channel | null }> =>
  request(token, 'GET', '/api/personal-assistant')

export const listWorkflows = (token: string): Promise<WorkflowTemplate[]> =>
  request(token, 'GET', '/api/workflows')

export const createWorkflow = (
  token: string,
  body: { name: string; description?: string; graph?: { steps: { id: string; type: string; title?: string; input?: Record<string, unknown> }[] } },
): Promise<WorkflowTemplate> => request(token, 'POST', '/api/workflows', body)

export const addChannelMember = (
  token: string,
  channelId: string,
  userId: string,
): Promise<unknown> => request(token, 'POST', `/api/channels/${channelId}/members`, { userId })

export const installWorkflow = (
  token: string,
  templateId: string,
  body: { name?: string; config?: unknown },
): Promise<WorkflowInstallation> =>
  request(token, 'POST', `/api/workflows/${templateId}/install`, body)

export const runWorkflowInstallation = (
  token: string,
  installationId: string,
  body: { input?: unknown } = {},
): Promise<unknown> =>
  request(token, 'POST', `/api/workflow-installations/${installationId}/run`, body)

export const listInstallations = (token: string): Promise<WorkflowInstallation[]> =>
  request(token, 'GET', '/api/workflow-installations')

export const createAgentTrigger = (
  token: string,
  agentId: string,
  body: {
    type: string
    name?: string
    description?: string
    enabled?: boolean
    config?: Record<string, unknown>
    nextRunAt?: string
    targetChannelId?: string
  },
): Promise<unknown> => request(token, 'POST', `/api/agents/${agentId}/triggers`, body)

export const fireTrigger = (
  token: string,
  triggerId: string,
  body: { prompt?: string; payload?: unknown; source?: string } = {},
): Promise<unknown> => request(token, 'POST', `/api/triggers/${triggerId}/fire`, body)
