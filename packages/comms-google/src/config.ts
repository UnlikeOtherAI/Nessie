import type { FetchLike } from './http.js'

/** The default (narrowest read) Gmail scope. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** Labels excluded from sync by default (still discoverable, just off). */
export const DEFAULT_OFF_LABELS = new Set(['SPAM', 'TRASH'])

const DEFAULT_PAGE_SIZE = 100

/**
 * Everything the Gmail connector needs, injected by the worker/API wiring. The
 * package itself reads no environment and holds no ambient client config, so it
 * stays pure and testable.
 */
export type GoogleConnectorDeps = {
  /** Injected fetch — real `fetch` in production, a stub in tests. */
  fetch: FetchLike
  /** OAuth client id (Google Cloud project). */
  clientId: string
  /** OAuth client secret for a "web" client; omitted for a pure PKCE public client. */
  clientSecret?: string
  /** Requested scopes; defaults to the single read-only Gmail scope. */
  scopes?: string[]
  /** Fully-qualified Pub/Sub topic (`projects/<p>/topics/<t>`) for `users.watch`. */
  pubsubTopic: string
  /** `users.messages.list` page size; defaults to 100. */
  pageSize?: number
  /** Optional lower bound (epoch seconds) for the first initial-sync page. */
  initialAfterEpochSec?: number
  /** Clock seam for token expiry + deletion timestamps. */
  now?: () => number
}

export const resolveScopes = (deps: GoogleConnectorDeps): string[] =>
  deps.scopes && deps.scopes.length > 0 ? deps.scopes : [GMAIL_READONLY_SCOPE]

export const resolvePageSize = (deps: GoogleConnectorDeps): number =>
  deps.pageSize && deps.pageSize > 0 ? deps.pageSize : DEFAULT_PAGE_SIZE

export const nowMs = (deps: GoogleConnectorDeps): number =>
  deps.now ? deps.now() : Date.now()

/**
 * Resumable cursor for the initial history back-fill, JSON-encoded into
 * `SyncCheckpoint.cursor`. `after` bounds the window (epoch seconds); `historyId`
 * captures the mailbox baseline at import start; `pageToken` is the Gmail list
 * page.
 */
export type HistoryCursor = {
  after?: number
  historyId?: string
  pageToken?: string
}

/**
 * Resumable cursor for incremental sync. `historyId` is the last processed
 * mailbox history point; `pageToken` pages one `users.history.list` response.
 */
export type IncrementalCursor = {
  historyId?: string
  pageToken?: string
}

export const encodeCursor = (cursor: HistoryCursor | IncrementalCursor): string =>
  JSON.stringify(cursor)

const parseCursor = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const optString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const optNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const decodeHistoryCursor = (raw: string | undefined): HistoryCursor => {
  const obj = parseCursor(raw)
  return {
    after: optNumber(obj.after),
    historyId: optString(obj.historyId),
    pageToken: optString(obj.pageToken),
  }
}

export const decodeIncrementalCursor = (raw: string | undefined): IncrementalCursor => {
  const obj = parseCursor(raw)
  return {
    historyId: optString(obj.historyId),
    pageToken: optString(obj.pageToken),
  }
}
