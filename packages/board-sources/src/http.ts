import { Readable, Transform, type TransformCallback } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import { safeFetch } from '@nessie/runtime'

import {
  SourceAssetTooLargeError,
  SourceAuthError,
  SourceRateLimitedError,
} from './errors.js'

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

const assertAllowedHost = (url: URL, allowedHosts: readonly string[]): void => {
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`[board-sources] ${url.hostname} is not an allowed host for this adapter`)
  }
}

/** Status classification shared by the buffered and the streaming envelope. */
const throwForStatus = (status: number, headers: Headers, text: string): void => {
  if (status === 401 || status === 403) {
    throw new SourceAuthError(`Provider answered ${status}`)
  }
  if (status === 429) {
    throw new SourceRateLimitedError(retryAfterMs(headers))
  }
  if (status >= 400) {
    throw new SourceHttpError(status, text.slice(0, 500))
  }
}

export const sourceFetch = async (input: SourceFetchInput): Promise<SourceResponse> => {
  const url = new URL(input.url)
  assertAllowedHost(url, input.allowedHosts)

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
    throwForStatus(response.status, response.headers, text)
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

/**
 * The cap on one provider file. The same number `POST /api/uploads` admits, so
 * an imported file is never something a person could not have uploaded.
 */
export const SOURCE_ASSET_LIMIT_BYTES = 25 * 1024 * 1024

export type SourceFetchStreamInput = {
  url: string
  headers?: Record<string, string>
  /** The adapter's `assetHosts`. Anything else is refused before resolution. */
  allowedHosts: readonly string[]
  /** Time allowed until the response headers arrive; the body then streams. */
  timeoutMs?: number
  signal?: AbortSignal
  limitBytes?: number
}

export type SourceStreamResponse = {
  status: number
  stream: Readable
  contentType: string | null
  /** The provider's declared length, when it sent one. */
  sizeBytes: number | null
}

/**
 * A counting pass-through that destroys itself — and so whatever is reading
 * it, the file store included — the moment the running total passes `limit`.
 * The declared length is checked first where there is one; this is the half
 * that holds when a provider sends none, or lies.
 */
export const limitAssetStream = (
  source: Readable,
  limitBytes: number = SOURCE_ASSET_LIMIT_BYTES,
): Readable => {
  let seen = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      seen += chunk.byteLength
      if (seen > limitBytes) {
        callback(new SourceAssetTooLargeError(limitBytes))
        return
      }
      callback(null, chunk)
    },
  })
  source.on('error', (error) => counter.destroy(error))
  counter.on('close', () => {
    if (!source.destroyed) source.destroy()
  })
  return source.pipe(counter)
}

/**
 * Turn one provider response into the capped stream `fetchAsset` returns.
 * Split from the fetch so the cap is testable without a network: the fetch
 * envelope refuses loopback by design.
 */
export const streamFromSourceResponse = async (
  response: Response,
  limitBytes: number = SOURCE_ASSET_LIMIT_BYTES,
): Promise<SourceStreamResponse> => {
  if (response.status >= 400) {
    const text = await readCapped(response).catch(() => '')
    throwForStatus(response.status, response.headers, text)
  }
  const declared = Number(response.headers.get('content-length'))
  const sizeBytes = Number.isFinite(declared) && declared >= 0
    && response.headers.has('content-length') ? declared : null
  if (sizeBytes !== null && sizeBytes > limitBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new SourceAssetTooLargeError(limitBytes)
  }
  const body = response.body
    ? Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
    : Readable.from([])
  return {
    status: response.status,
    stream: limitAssetStream(body, limitBytes),
    contentType: response.headers.get('content-type'),
    sizeBytes,
  }
}

/**
 * `sourceFetch` for a provider file: the same SSRF-vetted, no-redirect,
 * identity-encoded envelope, but the body is handed back as a stream under a
 * 25 MiB cap rather than buffered under the 1 MiB one. Only `GET`, only the
 * adapter's asset hosts.
 */
export const sourceFetchStream = async (
  input: SourceFetchStreamInput,
): Promise<SourceStreamResponse> => {
  const url = new URL(input.url)
  assertAllowedHost(url, input.allowedHosts)

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS,
  )
  const abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })

  let response: Response
  try {
    response = await safeFetch(
      url.toString(),
      {
        method: 'GET',
        headers: { accept: '*/*', 'accept-encoding': 'identity', ...input.headers },
        signal: controller.signal,
      },
      // A credential rides on every asset fetch too, so no redirect is followed.
      { credentialsPresent: true, maxRedirects: 0 },
    )
  } finally {
    // The timeout bounds the wait for headers only; a large file then streams
    // at whatever pace the store reads it, and the cap bounds its size.
    clearTimeout(timeout)
  }
  try {
    return await streamFromSourceResponse(response, input.limitBytes)
  } finally {
    input.signal?.removeEventListener('abort', abort)
  }
}
