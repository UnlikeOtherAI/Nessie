import { MicrosoftApiError } from './errors.js'

/** Minimal injected fetch shape, deliberately independent from global fetch. */
export type FetchResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<FetchResponse>

export const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const MICROSOFT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

const BLOCKED_CODES = new Set([
  'Authorization_RequestDenied',
  'ErrorAccessDenied',
  'accessDenied',
  'insufficientPrivileges',
  'consent_required',
  'authorization_required',
])

const REAUTH_CODES = new Set([
  'InvalidAuthenticationToken',
  'invalid_token',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const readErrorCode = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined
  if (typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error
  }
  if (!isRecord(payload.error)) return undefined
  const error = payload.error
  if (typeof error.code === 'string' && error.code.length > 0) {
    return error.code
  }
  if (isRecord(error.innerError) && typeof error.innerError.code === 'string') {
    return error.innerError.code
  }
  return undefined
}

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

/**
 * Graph emits opaque next/delta links. They are persisted verbatim but may be
 * followed only when they still resolve to the fixed public Graph host.
 */
export const assertGraphPageUrl = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('[comms-microsoft] Graph returned an invalid page URL')
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'graph.microsoft.com'
    || url.port !== ''
    || !url.pathname.startsWith('/v1.0/')
  ) {
    throw new Error('[comms-microsoft] Graph returned an unsafe page URL')
  }
  return url.toString()
}

export const requestJson = async (
  fetchImpl: FetchLike,
  operation: string,
  input: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    goneOk?: boolean
  } = {},
): Promise<{ status: number; body: unknown }> => {
  const response = await fetchImpl(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  })
  if (response.ok) {
    return { status: response.status, body: await response.json() }
  }
  if (init.goneOk && response.status === 410) {
    return { status: response.status, body: undefined }
  }
  let code: string | undefined
  try {
    code = readErrorCode(await response.json())
  } catch {
    code = undefined
  }
  const needsReauthorization = response.status === 401
    || (code !== undefined && REAUTH_CODES.has(code))
  throw new MicrosoftApiError({
    operation,
    status: response.status,
    code,
    retryable: !needsReauthorization && isRetryableStatus(response.status),
    needsReauthorization,
    authorizationBlocked: code !== undefined && BLOCKED_CODES.has(code),
  })
}

export const encodeForm = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
