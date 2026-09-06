import { safeFetch } from '@nessie/runtime'

import { SourceAuthError, SourceRateLimitedError } from './errors.js'

/**
 * The one network chokepoint every provider adapter calls.
 *
 * Lifted from the Live Data Dashboards fetch envelope, because the decisions in
 * it are security decisions rather than features: SSRF-vetted resolution with
 * the socket pinned to the addresses that were vetted, **no** redirects while a
 * credential is attached (a 302 must never carry a bearer token to a host that
 * was never checked), a response cap, and identity encoding so a compressed
 * bomb cannot blow past that cap.
 *
 * Vendor SDKs are deliberately not used anywhere in these packages: they call
 * global `fetch`, which the root `eslint.config.js` egress block bans precisely
 * so this function cannot be bypassed by accident.
 */

export const SOURCE_FETCH_TIMEOUT_MS = 10_000
export const SOURCE_RESPONSE_LIMIT_BYTES = 1024 * 1024

export type SourceFetchInput = {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  /** Hosts this adapter is allowed to reach. Anything else is a programming error. */
  allowedHosts: readonly string[]
  timeoutMs?: number
  signal?: AbortSignal
}

export type SourceResponse = {
  status: number
  headers: Headers
  text: string
}

export class SourceHttpError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`Provider answered ${status}`)
    this.name = 'SourceHttpError'
    this.status = status
    this.body = body
  }
}

const retryAfterMs = (headers: Headers): number | null => {
  const raw = headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

export const sourceFetch = async (input: SourceFetchInput): Promise<SourceResponse> => {
  const url = new URL(input.url)
  if (!input.allowedHosts.includes(url.hostname)) {
    throw new Error(`[board-sources] ${url.hostname} is not an allowed host for this adapter`)
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS,
  )
  const abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })

  try {
    const response = await safeFetch(
      url.toString(),
      {
        method: input.method ?? 'GET',
        headers: {
          accept: 'application/json',
          // A compressed response could otherwise expand past the cap below.
          'accept-encoding': 'identity',
          ...input.headers,
        },
        body: input.body,
        signal: controller.signal,
      },
      // Every call here carries a credential, so a redirect is never followed:
      // the hop's host was not vetted and the token would travel to it.
      { credentialsPresent: true, maxRedirects: 0 },
    )

    const text = await readCapped(response)
    if (response.status === 401 || response.status === 403) {
      throw new SourceAuthError(`Provider answered ${response.status}`)
    }
    if (response.status === 429) {
      throw new SourceRateLimitedError(retryAfterMs(response.headers))
    }
    if (response.status >= 400) {
      throw new SourceHttpError(response.status, text.slice(0, 500))
    }
    return { status: response.status, headers: response.headers, text }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
  }
}

const readCapped = async (response: Response): Promise<string> => {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > SOURCE_RESPONSE_LIMIT_BYTES) {
      await reader.cancel()
      throw new SourceHttpError(response.status, 'Provider response exceeded 1 MiB')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** `sourceFetch` plus JSON parsing, which every adapter would otherwise repeat. */
export const sourceFetchJson = async <T>(input: SourceFetchInput): Promise<T> => {
  const response = await sourceFetch(input)
  if (!response.text) return undefined as T
  try {
    return JSON.parse(response.text) as T
  } catch {
    throw new SourceHttpError(response.status, 'Provider answered with malformed JSON')
  }
}
