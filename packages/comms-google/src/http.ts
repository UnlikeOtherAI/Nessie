import { GmailApiError } from './errors.js'

/**
 * A minimal fetch shape the connector depends on, so the package needs no DOM
 * lib and tests can inject a stub without a real network. Matches the subset of
 * the WHATWG `fetch` contract the Gmail client actually uses.
 */
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

/**
 * Google host endpoints — fixed, never derived from caller or model input.
 *
 * `NESSIE_GOOGLE_API_BASE_URL` lets a deployment point the Gmail/Calendar reads
 * at a local stand-in, which is how the end-to-end harness exercises the draft
 * card without a real mailbox. It is operator env in exactly the same class as
 * `NESSIE_MODEL_BASE_URL`, read once at module load so no request can redirect
 * itself, and unset in production.
 */
const apiRoot = (): string =>
  (process.env.NESSIE_GOOGLE_API_BASE_URL ?? '').replace(/\/$/, '')

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_API_BASE = apiRoot()
  ? `${apiRoot()}/gmail/v1/users/me`
  : 'https://gmail.googleapis.com/gmail/v1/users/me'
export const CALENDAR_API_BASE = apiRoot()
  ? `${apiRoot()}/calendar/v3`
  : 'https://www.googleapis.com/calendar/v3'

/**
 * Google reuses 403 for two unrelated things: "you are going too fast" and
 * "this token does not carry the scope for that call". Only the first is worth
 * a retry. Treating the whole status as transient — as this did until the
 * capability work — meant a scope error looped until the job died, so a missing
 * scope could never surface as the in-chat request to grant it.
 */
const RETRYABLE_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'backendError',
])

/** Google's machine reasons for "this token lacks the required scope". */
const SCOPE_REASONS = new Set([
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'insufficientScope',
])

const isRetryableStatus = (status: number, reason: string | undefined): boolean => {
  if (status === 429 || status >= 500) {
    return true
  }
  // Unknown 403 reasons stay fatal: a retry loop on a permission error costs a
  // queue slot and hides the cause, while a fatal classification surfaces it.
  return status === 403 && reason !== undefined && RETRYABLE_403_REASONS.has(reason)
}

export const isScopeReason = (
  status: number,
  reason: string | undefined,
): boolean => status === 403 && reason !== undefined && SCOPE_REASONS.has(reason)

/**
 * Google's structured machine reason, distinct from the human `message`:
 * `error.errors[].reason` on the classic Gmail shape, `error.status` on the
 * newer one. Classification reads this; never the prose message.
 */
const readErrorCode = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) {
    return undefined
  }
  const err = (payload as { error: unknown }).error
  if (!err || typeof err !== 'object') {
    return undefined
  }
  const errors = (err as { errors?: unknown }).errors
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (entry && typeof entry === 'object' && 'reason' in entry) {
        const reason = (entry as { reason: unknown }).reason
        if (typeof reason === 'string' && reason.length > 0) {
          return reason
        }
      }
    }
  }
  const status = (err as { status?: unknown }).status
  return typeof status === 'string' && status.length > 0 ? status : undefined
}

const readErrorReason = (payload: unknown): string | undefined => {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const err = (payload as { error: unknown }).error
    if (typeof err === 'string') {
      return err
    }
    if (err && typeof err === 'object' && 'message' in err) {
      const message = (err as { message: unknown }).message
      if (typeof message === 'string') {
        return message
      }
    }
  }
  return undefined
}

/**
 * Issue one request and parse JSON, converting any non-2xx into a classified
 * {@link GmailApiError}. `notFoundOk` lets a caller (history.list) handle 404
 * itself instead of throwing.
 */
export const requestJson = async (
  fetchImpl: FetchLike,
  operation: string,
  input: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    /** Bound a provider response before parsing it into our process. */
    maxResponseBytes?: number
    notFoundOk?: boolean
  } = {},
): Promise<{ status: number; body: unknown; responseBytes?: number }> => {
  const response = await fetchImpl(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  })
  if (response.ok) {
    if (init.maxResponseBytes === undefined) {
      const body = await response.json()
      return { status: response.status, body }
    }
    const text = await response.text()
    const responseBytes = Buffer.byteLength(text)
    if (responseBytes > init.maxResponseBytes) {
      throw new Error(`[comms-google] ${operation} response exceeds ${init.maxResponseBytes} bytes`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`[comms-google] ${operation} returned invalid JSON`)
    }
    return { status: response.status, body, responseBytes }
  }
  if (init.notFoundOk && response.status === 404) {
    return { status: 404, body: undefined }
  }
  let reason: string | undefined
  let code: string | undefined
  try {
    const payload = await response.json()
    reason = readErrorReason(payload)
    code = readErrorCode(payload)
  } catch {
    reason = undefined
    code = undefined
  }
  throw new GmailApiError({
    status: response.status,
    retryable: isRetryableStatus(response.status, code),
    operation,
    reason,
    code,
    scopeMissing: isScopeReason(response.status, code),
  })
}

/** Form-url-encode a token/revoke body without pulling in a URLSearchParams dep. */
export const encodeForm = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
