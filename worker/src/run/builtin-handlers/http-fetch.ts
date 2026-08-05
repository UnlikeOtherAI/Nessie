import { z } from 'zod'

import {
  assertSafeUrl,
  UrlSafetyError,
  type ResolveHost,
} from './url-safety.js'
import { HttpFetchError } from './http-fetch-error.js'
import { MAX_RAW_BODY_CHARS, truncateToolResult } from '../tool-util.js'

export { HttpFetchError } from './http-fetch-error.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

const AuthSchema = z.object({
  kind: z.enum(['bearer', 'apiKey']),
  headerName: z.string().min(1).optional(),
  valuePrefix: z.string().optional(),
  token: z.string().min(1),
})

const InputSchema = z.object({
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .default('GET'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  maxBytes: z.number().int().positive().optional(),
  auth: AuthSchema.optional(),
})

export type HttpFetchInput = z.infer<typeof InputSchema>

export type HttpFetchOutput = {
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  bodyText: string
  truncated: boolean
  bytesRead: number
}

const applyAuth = (
  headers: Record<string, string>,
  auth: HttpFetchInput['auth'],
): Record<string, string> => {
  if (!auth) {
    return headers
  }

  const headerName =
    auth.headerName ?? (auth.kind === 'bearer' ? 'Authorization' : 'X-API-Key')
  const prefix = auth.valuePrefix ?? (auth.kind === 'bearer' ? 'Bearer ' : '')
  return { ...headers, [headerName]: `${prefix}${auth.token}` }
}

const readBoundedBody = async (
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> => {
  if (!response.body) {
    const text = await response.text()
    const encoded = new TextEncoder().encode(text)
    if (encoded.byteLength <= maxBytes) {
      return { text, truncated: false, bytesRead: encoded.byteLength }
    }
    return {
      text: new TextDecoder().decode(encoded.subarray(0, maxBytes)),
      truncated: true,
      bytesRead: maxBytes,
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let truncated = false

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }

    const value = chunk.value
    bytesRead += value.byteLength

    if (bytesRead > maxBytes) {
      const overflow = bytesRead - maxBytes
      const allowedBytes = Math.max(0, value.byteLength - overflow)
      text += decoder.decode(value.subarray(0, allowedBytes), { stream: true })
      bytesRead = maxBytes
      truncated = true
      await reader.cancel()
      break
    }

    text += decoder.decode(value, { stream: true })
  }

  text += decoder.decode()
  return { text, truncated, bytesRead }
}

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/**
 * `maxBytes` bounds what we read off the wire (megabytes); this bounds what
 * reaches the model. A raw API or HTML body is the single biggest driver of
 * context growth — uncapped it rides the generic 32,000-char chokepoint at
 * roughly 8k tokens and is re-billed on every subsequent iteration — so the
 * body is cut middle-out to `MAX_RAW_BODY_CHARS` here, at the handler, and
 * `truncated` reports the cut whichever limit caused it.
 */
const buildOutput = (
  response: Pick<Response, 'headers' | 'status' | 'statusText'>,
  url: string,
  body: { text: string; truncated: boolean; bytesRead: number },
): HttpFetchOutput => {
  const bodyText = truncateToolResult(body.text, MAX_RAW_BODY_CHARS)
  return {
    status: response.status,
    statusText: response.statusText,
    url,
    headers: headersToObject(response.headers),
    bodyText,
    truncated: body.truncated || bodyText !== body.text,
    bytesRead: body.bytesRead,
  }
}

const assertHttpFetchSafeUrl = async (
  rawUrl: string | URL,
  options?: { resolveHost?: ResolveHost },
): Promise<URL> => {
  try {
    return await assertSafeUrl(rawUrl, options)
  } catch (error) {
    if (error instanceof UrlSafetyError) {
      throw new HttpFetchError(error.message)
    }
    throw error
  }
}

export const runHttpFetch = async (
  rawArgs: unknown,
  options?: { fetchImpl?: typeof fetch; resolveHost?: ResolveHost },
): Promise<HttpFetchOutput> => {
  const input = InputSchema.parse(rawArgs)
  const fetchImpl = options?.fetchImpl ?? fetch
  const resolveHost = options?.resolveHost
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  const method = input.method

  const safeUrl = await assertHttpFetchSafeUrl(input.url, { resolveHost })

  let headers: Record<string, string> = { ...(input.headers ?? {}) }
  headers = applyAuth(headers, input.auth)

  let body: RequestInit['body'] | undefined
  if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof input.body === 'string') {
      body = input.body
    } else {
      body = JSON.stringify(input.body)
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json'
      }
    }
  }

  const response = await fetchImpl(safeUrl, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })

  // Honour 'manual' redirect handling: any redirect target must pass the same
  // scheme + SSRF checks as the initial URL. We follow exactly one hop to keep
  // behaviour predictable.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      const redirectUrl = await assertHttpFetchSafeUrl(new URL(location, safeUrl), {
        resolveHost,
      })
      const followed = await fetchImpl(redirectUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const second = await readBoundedBody(followed, maxBytes)
      return buildOutput(followed, redirectUrl.toString(), second)
    }
  }

  const result = await readBoundedBody(response, maxBytes)
  return buildOutput(response, safeUrl.toString(), result)
}
