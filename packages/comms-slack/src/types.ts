import type { NormalizedEvent } from '@nessie/comms-connect'

/** Injected `fetch` so tests never touch the network. Defaults to global fetch. */
export type FetchLike = typeof fetch

/** Injected sleep (ms) used only for bounded rate-limit/5xx retry backoff. */
export type SleepFn = (ms: number) => Promise<void>

/**
 * Everything the Slack adapter needs, injected by the orchestrator. No value is
 * read from `process.env` inside this package: the caller owns configuration.
 */
export type SlackConnectorDeps = {
  /** Slack app client id (OAuth). */
  clientId: string
  /** Slack app client secret (OAuth). Never logged. */
  clientSecret: string
  /** Events API request-signing secret (`v0` HMAC). Never logged. */
  signingSecret: string
  /** Configured OAuth redirect; the callback's own `redirectUri` wins when set. */
  redirectUri?: string
  /** Override `fetch` (tests). */
  fetchImpl?: FetchLike
  /** Override sleep (tests). */
  sleep?: SleepFn
  /** Override the clock, used for webhook timestamp-skew checks (tests). */
  now?: () => number
  /** Bounded retries for 429/5xx before surfacing a retryable error. */
  maxRetries?: number
  /** Upper bound on how long a single `Retry-After` sleep may last (ms). */
  retryAfterCapMs?: number
}

/** The Slack conversation kinds this adapter recognises. */
export type SlackConvType =
  | 'public_channel'
  | 'private_channel'
  | 'im'
  | 'mpim'

/** Common envelope of every Slack Web API JSON response. */
export type SlackApiResponse = {
  ok: boolean
  error?: string
  response_metadata?: { next_cursor?: string }
}

/** A conversation object as returned by `users.conversations`. */
export type SlackConversation = {
  id: string
  name?: string
  user?: string
  is_channel?: boolean
  is_group?: boolean
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
}

/** A file object attached to a message (metadata only — bytes are never read). */
export type SlackFile = {
  id?: string
  name?: string
  mimetype?: string
  size?: number
  url_private?: string
}

/** A reaction summary on a message. */
export type SlackReaction = {
  name: string
  count?: number
  users?: string[]
}

/** A single Slack message as seen in history/replies/events. */
export type SlackMessage = {
  type?: string
  subtype?: string
  ts?: string
  thread_ts?: string
  user?: string
  bot_id?: string
  text?: string
  reply_count?: number
  edited?: { user?: string; ts?: string }
  files?: SlackFile[]
  reactions?: SlackReaction[]
}

/** Result of one webhook delivery, richer than the bare `NormalizedEvent[]`. */
export type SlackWebhookOutcome =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'events'; events: NormalizedEvent[] }
  | { kind: 'ignored' }
