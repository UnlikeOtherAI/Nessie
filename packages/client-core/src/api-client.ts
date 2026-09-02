import type { ApiError, ApiResponse } from '@nessie/schemas'

export type ApiClient = {
  delete: <TData>(path: string) => Promise<TData>
  get: <TData>(path: string) => Promise<TData>
  /**
   * A GET that keeps the response envelope instead of unwrapping it, for a
   * paged list: `meta` is where the cursors and the total live, and `get`
   * throws them away.
   */
  getPage: <TData>(path: string) => Promise<ApiResponse<TData>>
  // `headers` exists for the conditional writes the auto-saving editors make:
  // `If-Match: <revision>` is what lets the server refuse a stale save instead
  // of taking the last write (docs/navigation/overview.md → "Drafts").
  patch: <TData>(path: string, body?: unknown, headers?: Record<string, string>) =>
    Promise<TData>
  post: <TData>(path: string, body?: unknown, headers?: Record<string, string>) =>
    Promise<TData>
  put: <TData>(path: string, body?: unknown, headers?: Record<string, string>) =>
    Promise<TData>
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
    /**
     * The error envelope's `details`. For a `VALIDATION_ERROR` this is Zod's
     * `flatten()` — `{ formErrors, fieldErrors }` — which is what lets a form
     * put the server's complaint on the field it is about instead of showing
     * one sentence above everything. It was being parsed off the response and
     * dropped here, so no client could reach it. A 409 from a conditional
     * write carries the current revision here too, which is what lets the
     * client offer "take theirs" without a second round trip.
     */
    readonly details?: unknown,
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
      return new ApiClientError(
        payload.error.message,
        payload.error.code,
        response.status,
        payload.error.details,
      )
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

  /**
   * The whole envelope, `meta` included.
   *
   * `request` below unwraps to `payload.data`, which is right for the hundred
   * call sites that want one record or one array — and silently wrong for a
   * paged list, whose `meta` carries the cursors and the total. A caller that
   * asked for `{data, meta}` got the array and read `undefined` off it, so a
   * list would render permanently empty with no next page reachable.
   */
  const requestEnvelope = async <TData>(
    path: string,
    init?: RequestInit,
    retried = false,
  ): Promise<ApiResponse<TData>> => {
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
        return requestEnvelope<TData>(path, init, true)
      }
    }

    if (!response.ok) {
      throw await toApiError(response)
    }

    if (response.status === 204) {
      return { data: undefined as TData }
    }

    return (await response.json()) as ApiResponse<TData>
  }

  const request = async <TData>(path: string, init?: RequestInit): Promise<TData> =>
    (await requestEnvelope<TData>(path, init)).data

  return {
    getPage: (path) => requestEnvelope(path, { method: 'GET' }),
    delete: (path) => request(path, { method: 'DELETE' }),
    get: (path) => request(path, { method: 'GET' }),
    patch: (path, body, headers) =>
      request(path, {
        method: 'PATCH',
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(headers ? { headers } : {}),
      }),
    post: (path, body, headers) =>
      request(path, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(headers ? { headers } : {}),
      }),
    put: (path, body, headers) =>
      request(path, {
        method: 'PUT',
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(headers ? { headers } : {}),
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
  UnreadDirectMessagePreview,
  UnreadDirectMessageRecord,
  UnreadDirectMessagesResponse,
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
