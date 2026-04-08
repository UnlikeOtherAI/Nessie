import type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  ApiError,
  ApiResponse,
  MeResponse,
  ToolCallEntry,
} from '@nessie/schemas'

export type AuthProviderDescriptor = {
  autoRedirect: boolean
  enabled: boolean
  label: string
  providerId: string
  type: string
}

export type BootstrapModeResponse = {
  bootstrapMode: true
  bootstrapUrl: '/admin/bootstrap'
}

export type ChannelRecord = {
  createdAt: string
  defaultThreadId: string
  id: string
  label: string
  organizationId: string
  teamId: string
  updatedAt: string
  visibility: 'private' | 'protected' | 'public'
}

export type AgentRecord = {
  channelIds: string[]
  createdAt: string
  currentRunId?: string
  currentToolName?: string
  currentToolStartedAt?: string
  id: string
  lastActivityAt: string
  model?: string
  name: string
  parentAgentId?: string | null
  provider?: string
  role: string
  status: AgentStatusResponse['status']
  systemPrompt?: string
  updatedAt: string
}

export type UserRecord = {
  channelIds: string[]
  createdAt: string
  displayName: string
  email: string
  id: string
  role: string
  updatedAt: string
}

export type MessageReaction = {
  id: string
  messageId: string
  agentId?: string | null
  userId?: string | null
  emoji: string
  createdAt: string
}

export type ThreadMessageRecord = {
  agentId?: string | null
  content: string
  createdAt: string
  id: string
  reactions?: MessageReaction[]
  role: 'assistant' | 'system' | 'user'
  threadId: string
  userId?: string | null
}

export type AgentCategoryRecord = {
  agentIds: string[]
  authorAgentId: string | null
  createdAt: string
  createdById: string
  description: string | null
  id: string
  name: string
  organizationId: string
  updatedAt: string
  visibility: 'private' | 'public'
}

export type ToolDescriptor = {
  description: string
  id: string
  label: string
  safe: boolean
}

export type SessionState =
  | {
      data: BootstrapModeResponse
      kind: 'bootstrap'
    }
  | {
      data: MeResponse
      kind: 'authenticated'
    }

export type ApiClient = {
  delete: <TData>(path: string) => Promise<TData>
  get: <TData>(path: string) => Promise<TData>
  post: <TData>(path: string, body?: unknown) => Promise<TData>
  put: <TData>(path: string, body?: unknown) => Promise<TData>
}

export const getBaseUrl = (): string => {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
  return configuredBaseUrl ? configuredBaseUrl.replace(/\/$/, '') : ''
}

const toApiError = async (response: Response): Promise<Error> => {
  const text = await response.text()
  if (!text) {
    return new Error(`${response.status} ${response.statusText}`)
  }

  try {
    const payload = JSON.parse(text) as ApiError
    if (payload.error?.message) {
      return new Error(payload.error.message)
    }
  } catch {
    // Fall through to raw body.
  }

  return new Error(text)
}

export const createApiClient = (token: string | null): ApiClient => {
  const baseUrl = getBaseUrl()

  const request = async <TData>(path: string, init?: RequestInit): Promise<TData> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('content-type') && init?.body) {
      headers.set('content-type', 'application/json')
    }
    if (token) {
      headers.set('authorization', `Bearer ${token}`)
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      throw await toApiError(response)
    }

    if (response.status === 204) {
      return undefined as TData
    }

    const payload = (await response.json()) as ApiResponse<TData>
    return payload.data
  }

  return {
    delete: (path) => request(path, { method: 'DELETE' }),
    get: (path) => request(path, { method: 'GET' }),
    post: (path, body) =>
      request(path, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    put: (path, body) =>
      request(path, {
        method: 'PUT',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  }
}

export type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  MeResponse,
  ToolCallEntry,
}
