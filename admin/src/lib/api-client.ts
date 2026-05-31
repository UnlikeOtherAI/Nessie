import type { ApiError, ApiResponse } from '@nessie/schemas'

export type ApiClient = {
  delete: <TData>(path: string) => Promise<TData>
  get: <TData>(path: string) => Promise<TData>
  patch: <TData>(path: string, body?: unknown) => Promise<TData>
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
// `import { ... } from '../lib/api-client'` call sites keep working.
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
} from './api-types'

// Re-export schema-sourced types previously surfaced from this module.
export type {
  AgentActivityResponse,
  AgentChild,
  AgentMessage,
  AgentStatusResponse,
  MeResponse,
  ToolCallEntry,
} from '@nessie/schemas'
