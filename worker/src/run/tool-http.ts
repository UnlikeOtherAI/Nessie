import {
  HttpFetchError,
  runHttpFetch,
  type HttpFetchInput,
  type HttpFetchOutput,
} from './builtin-handlers/index.js'

/**
 * HTTP transport handler used by the universal worker dispatcher.
 *
 * Spec: `docs/external-tool-integration.md` §3, plan §5.
 *
 * Reuses the SSRF-hardened `runHttpFetch` helper from the builtin handlers so
 * outbound traffic from registered "HTTP" tools shares the same private-network
 * blocklist, max-bytes ceiling, and one-hop redirect policy as `http_fetch`.
 *
 * The dispatcher injects auth from the per-principal credential chain. Tool
 * authors describe how to inject the secret (header name + prefix) and provide
 * the URL/method/body shape; the secret value itself is resolved by the API
 * tier and passed in via `secret`.
 */

export type HttpToolEndpoint = {
  method?: HttpFetchInput['method']
  url: string
  /** Static headers declared by the tool author (merged with auth header). */
  headers?: Record<string, string>
  /** Optional per-call timeout override. */
  timeoutMs?: number
  /** Optional max response bytes override. */
  maxBytes?: number
  /**
   * Auth injection. `kind` matches `MCP auth method` semantics for parity with
   * the credential chain. The resolved plaintext is passed via `secret`.
   */
  auth?: {
    kind: 'bearer' | 'apiKey'
    headerName?: string
    valuePrefix?: string
  }
}

export type HttpDispatchInput = {
  endpoint: HttpToolEndpoint
  /** Arguments selected by the LLM — forwarded as the body for non-GET calls. */
  args: unknown
  /** Plaintext credential resolved by the API tier; never persisted. */
  secret?: string | null
  /**
   * Optional fetch override. Used by tests to assert wire payloads without
   * spinning up a public-routable test server (the SSRF guard rejects
   * loopback by design).
   */
  fetchImpl?: typeof fetch
}

export type HttpDispatchOutput = HttpFetchOutput

const buildAuthBlock = (
  endpoint: HttpToolEndpoint,
  secret: string | null | undefined,
): HttpFetchInput['auth'] | undefined => {
  if (!endpoint.auth || !secret) return undefined
  return {
    kind: endpoint.auth.kind,
    headerName: endpoint.auth.headerName,
    valuePrefix: endpoint.auth.valuePrefix,
    token: secret,
  }
}

const buildFetchBody = (
  method: HttpFetchInput['method'],
  args: unknown,
): HttpFetchInput['body'] | undefined => {
  if (!method || method === 'GET' || method === 'HEAD') return undefined
  if (args === undefined || args === null) return undefined
  if (typeof args === 'string') return args
  if (typeof args === 'object') return args as Record<string, unknown>
  return String(args)
}

export const runHttpTool = async (
  input: HttpDispatchInput,
): Promise<HttpDispatchOutput> => {
  const method = input.endpoint.method ?? 'GET'
  const fetchInput: HttpFetchInput = {
    method,
    url: input.endpoint.url,
    headers: input.endpoint.headers,
    body: buildFetchBody(method, input.args),
    timeoutMs: input.endpoint.timeoutMs,
    maxBytes: input.endpoint.maxBytes,
    auth: buildAuthBlock(input.endpoint, input.secret),
  }

  return runHttpFetch(fetchInput, { fetchImpl: input.fetchImpl })
}

export { HttpFetchError }
