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
  // Optional 401 recovery: silently renew the access token (via the refresh
  // cookie) and return the new one, or null if renewal failed. When provided, a
  // 401 triggers a single renew-and-retry before the error surfaces.
  onUnauthorized?: () => Promise<string | null>
}

const normaliseBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/$/, '')

/** A rejected API response with the server's stable error code intact. */
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

const toApiError = async (response: Response): Promise<ApiClientError> => {
  const text = await response.text()
  if (!text) {
    return new ApiClientError(`${response.status} ${response.statusText}`, undefined, response.status)
  }

  try {
    const payload = JSON.parse(text) as ApiError
    if (payload.error?.message) {
      return new ApiClientError(payload.error.message, payload.error.code, response.status)
    }
  } catch {
    // Fall through to raw body.
  }

  return new ApiClientError(text, undefined, response.status)
}

export const createApiClient = ({ baseUrl, token, onUnauthorized }: ApiClientConfig): ApiClient => {
  const resolvedBaseUrl = normaliseBaseUrl(baseUrl)
  // Mutable so a successful 401 recovery can swap in the renewed token for the
  // retry and any subsequent calls made through this client instance.
  let activeToken = token

  const request = async <TData>(
    path: string,
    init?: RequestInit,
    retried = false,
  ): Promise<TData> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('content-type') && init?.body) {
      headers.set('content-type', 'application/json')
    }
    if (activeToken) {
      headers.set('authorization', `Bearer ${activeToken}`)
    }

    const response = await fetch(`${resolvedBaseUrl}${path}`, {
      ...init,
      headers,
      // Send the httpOnly refresh cookie so cross-subdomain auth flows (and
      // context switches that rotate it) work; CORS already allows credentials.
      credentials: 'include',
    })

    if (response.status === 401 && onUnauthorized && !retried) {
      const renewedToken = await onUnauthorized()
      if (renewedToken) {
        activeToken = renewedToken
        return request<TData>(path, init, true)
      }
    }

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
  FavoriteRecord,
  FavoriteTargetType,
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
  UserActiveStatus,
  UserRecord,
  UserStatusRecord,
  UserStatusRuleRecord,
  UserStatusRuleScope,
  UserStatusScheduleKind,
  UserStatusScheduleRecord,
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
  BuildMeProjectHandoffIntent,
  BuildMeProjectHandoffRequest,
  DeepTestReviewDepth,
  DeepTestReviewHandoffRequest,
  DeepWaterResearchDepth,
  DeepWaterResearchLaunchRequest,
  DeepWaterResearchRunRecord,
  IntegratedProductAuthMode,
  IntegratedProductCategory,
  IntegratedProductHealthStatus,
  IntegratedProductInstallState,
  IntegratedProductResponse,
  IntegrationPluginAvailability,
  IntegrationPluginInstallMode,
  IntegrationPluginManifest,
  IntegrationPluginPrivacyTier,
  IntegrationPluginSurfaceStatus,
  IntegrationUiCard,
  IntegrationUiCardAction,
  IntegrationUiCardField,
  IntegrationUiCardStatus,
  MeResponse,
  ProductAccountLinkRecord,
  ProductAccountLinkStatus,
  ProductIntegrationRunStatus,
  ProductMcpInstallationRecord,
  ProductTeamEnablementAuthority,
  ProductTeamEnablementRecord,
  SetProductTeamEnablementRequest,
  ToolCallEntry,
} from '@nessie/schemas'
