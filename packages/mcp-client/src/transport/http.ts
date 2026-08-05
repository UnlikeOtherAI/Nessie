import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpHttpSpec } from '../types.js'
import { safeMcpFetch } from './safe-fetch.js'

/**
 * Streamable-HTTP transport (the current spec). Caller-supplied headers are
 * merged into every outbound request via `requestInit.headers`. All requests go
 * through an SSRF-safe, IP-pinned fetch (see safeMcpFetch).
 */
export function createHttpTransport(spec: McpHttpSpec): StreamableHTTPClientTransport {
  const requestInit: RequestInit | undefined = spec.headers
    ? { headers: spec.headers }
    : undefined
  return new StreamableHTTPClientTransport(new URL(spec.url), {
    fetch: safeMcpFetch,
    requestInit,
    reconnectionOptions: {
      // We do reconnection at the manager layer so the SDK's per-stream
      // retry is just a safety net; one immediate retry is enough.
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 1,
    },
  })
}
