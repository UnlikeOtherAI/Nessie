import type { ApiError, ApiResponse } from '@nessie/schemas'

export type ApiClient = {
  delete: <TData>(path: string) => Promise<TData>
  get: <TData>(path: string) => Promise<TData>
  patch: <TData>(path: string, body?: unknown) => Promise<TData>
  post: <TData>(path: string, body?: unknown) => Promise<TData>
  put: <TData>(path: string, body?: unknown) => Promise<TData>
}

export type ApiClientConfig = {
  // Absolute base URL the host app resolves (e.g. from Vite env on web,
  // from app config on React Native). Trailing slash is normalised away.
  baseUrl: string
  // Bearer token to attach, or null when unauthenticated.
  token: string | null
}

const normaliseBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/$/, '')

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

export const createApiClient = ({ baseUrl, token }: ApiClientConfig): ApiClient => {
  const resolvedBaseUrl = normaliseBaseUrl(baseUrl)

  const request = async <TData>(path: string, init?: RequestInit): Promise<TData> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('content-type') && init?.body) {
      headers.set('content-type', 'application/json')
    }
    if (token) {
      headers.set('authorization', `Bearer ${token}`)
    }

    const response = await fetch(`${resolvedBaseUrl}${path}`, {
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
    patch: (path, body) =>
      request(path, {
        method: 'PATCH',
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
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

// Re-export API data-shape types from their dedicated module so existing
// `import { ... } from '@nessie/client-core'` call sites keep working.
export type {
  AgentRecord,
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  AuthProviderDescriptor,
  BootstrapModeResponse,
  CallParticipantRecord,
  CallRecord,
  ChannelMetadataRecord,
  ChannelRecord,
  MessageReaction,
  MessageSearchResult,
  PersonalAssistantBootstrapResponse,
  PersonalAssistantConfigSummary,
  PersonalAssistantInstanceRecord,
  PersonalAssistantStateResponse,
  ProjectMemberRecord,
  ProjectRecord,
  SessionState,
  TeamRecord,
  ThreadMessageRecord,
  ThreadRecord,
  ToolDescriptor,
  UserRecord,
  WorkflowInstallationRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepRunRecord,
  WorkflowStepRunStatus,
  WorkflowTemplateRecord,
} from './api-types.js'

// Re-export schema-sourced types previously surfaced from this module.
export type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  MeResponse,
  ToolCallEntry,
} from '@nessie/schemas'
