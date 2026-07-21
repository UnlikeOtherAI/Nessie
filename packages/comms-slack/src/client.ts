import type {
  FetchLike,
  SleepFn,
  SlackApiResponse,
} from './types.js'

const SLACK_API_BASE = 'https://slack.com/api'

/**
 * Slack error codes that mean the user token can no longer be used and the
 * connection must be re-authorized rather than retried.
 */
const REAUTH_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
])

/**
 * Errors from the Slack Web API, split into retryable transport faults
 * (HTTP 429 / 5xx) and fatal application errors. `needsReauthorization` marks
 * the subset a caller should surface as a connection-level re-auth prompt.
 */
export class SlackApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly needsReauthorization: boolean
  readonly retryAfterMs?: number
  readonly httpStatus?: number

  constructor(params: {
    code: string
    retryable: boolean
    needsReauthorization?: boolean
    retryAfterMs?: number
    httpStatus?: number
  }) {
    super(`[slack] ${params.code}`)
    this.name = 'SlackApiError'
    this.code = params.code
    this.retryable = params.retryable
    this.needsReauthorization = params.needsReauthorization ?? false
    this.retryAfterMs = params.retryAfterMs
    this.httpStatus = params.httpStatus
  }
}

export type SlackClientOptions = {
  fetchImpl: FetchLike
  sleep: SleepFn
  maxRetries: number
  retryAfterCapMs: number
}

export type SlackCallInput = {
  method: string
  /** Bearer user token; omitted for the unauthenticated `oauth.v2.access`. */
  token?: string
  params?: Record<string, string | undefined>
}

const parseRetryAfterMs = (header: string | null): number => {
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000
}

/**
 * The single seam through which every Slack call goes. Fixed host
 * (`https://slack.com/api/*`), form-encoded body, bearer auth in the header
 * (never in a log). Transparently retries 429/5xx up to `maxRetries` honouring
 * `Retry-After`, then throws a classified {@link SlackApiError}.
 */
export class SlackClient {
  private readonly opts: SlackClientOptions

  constructor(opts: SlackClientOptions) {
    this.opts = opts
  }

  async call<T extends SlackApiResponse>(input: SlackCallInput): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.dispatch(input)

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
        if (attempt < this.opts.maxRetries) {
          await this.opts.sleep(Math.min(retryAfterMs, this.opts.retryAfterCapMs))
          continue
        }
        throw new SlackApiError({
          code: 'ratelimited',
          retryable: true,
          retryAfterMs,
          httpStatus: 429,
        })
      }

      if (response.status >= 500) {
        if (attempt < this.opts.maxRetries) {
          await this.opts.sleep(Math.min(250 * (attempt + 1), this.opts.retryAfterCapMs))
          continue
        }
        throw new SlackApiError({
          code: 'server_error',
          retryable: true,
          httpStatus: response.status,
        })
      }

      const body = (await response.json()) as T
      if (!body.ok) {
        const code = body.error ?? 'unknown_error'
        throw new SlackApiError({
          code,
          retryable: false,
          needsReauthorization: REAUTH_CODES.has(code),
          httpStatus: response.status,
        })
      }
      return body
    }
  }

  private dispatch(input: SlackCallInput): Promise<Response> {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value !== undefined) {
        form.set(key, value)
      }
    }
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    }
    if (input.token) {
      headers.authorization = `Bearer ${input.token}`
    }
    return this.opts.fetchImpl(`${SLACK_API_BASE}/${input.method}`, {
      method: 'POST',
      headers,
      body: form,
    })
  }
}
