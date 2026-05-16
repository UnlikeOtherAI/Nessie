import { z } from 'zod'

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

export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError'

  constructor(message: string) {
    super(message)
  }
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

export const runHttpFetch = async (
  rawArgs: unknown,
  options?: { fetchImpl?: typeof fetch },
): Promise<HttpFetchOutput> => {
  const input = InputSchema.parse(rawArgs)
  const fetchImpl = options?.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  const method = input.method

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

  const response = await fetchImpl(input.url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })

  // Honour 'manual' redirect handling: any redirect target must not be file://
  // and we follow exactly one hop to keep behaviour predictable.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      const redirectUrl = new URL(location, input.url)
      if (redirectUrl.protocol === 'file:') {
        throw new HttpFetchError('Refusing to follow redirect to file:// URL.')
      }
      const followed = await fetchImpl(redirectUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const second = await readBoundedBody(followed, maxBytes)
      return {
        status: followed.status,
        statusText: followed.statusText,
        url: redirectUrl.toString(),
        headers: headersToObject(followed.headers),
        bodyText: second.text,
        truncated: second.truncated,
        bytesRead: second.bytesRead,
      }
    }
  }

  const result = await readBoundedBody(response, maxBytes)
  return {
    status: response.status,
    statusText: response.statusText,
    url: input.url,
    headers: headersToObject(response.headers),
    bodyText: result.text,
    truncated: result.truncated,
    bytesRead: result.bytesRead,
  }
}
