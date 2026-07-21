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

/** Google host endpoints — fixed, never derived from user input. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * HTTP status classes we treat as transient (worth a queue retry): rate limits
 * (429), Gmail's 403 rate-limit family, and 5xx. Everything else is fatal.
 */
const isRetryableStatus = (status: number): boolean =>
  status === 429 || status === 403 || status >= 500

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
    notFoundOk?: boolean
  } = {},
): Promise<{ status: number; body: unknown }> => {
  const response = await fetchImpl(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  })
  if (response.ok) {
    const body = await response.json()
    return { status: response.status, body }
  }
  if (init.notFoundOk && response.status === 404) {
    return { status: 404, body: undefined }
  }
  let reason: string | undefined
  try {
    reason = readErrorReason(await response.json())
  } catch {
    reason = undefined
  }
  throw new GmailApiError({
    status: response.status,
    retryable: isRetryableStatus(response.status),
    operation,
    reason,
  })
}

/** Form-url-encode a token/revoke body without pulling in a URLSearchParams dep. */
export const encodeForm = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
