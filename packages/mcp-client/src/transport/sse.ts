import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpSseSpec } from '../types.js'

/**
 * Legacy SSE transport — kept for servers that haven't migrated to streamable
 * HTTP yet. The SDK merges `requestInit.headers` into both the SSE GET stream
 * and the outbound POST requests, so passing them once here is sufficient.
 */
export function createSseTransport(spec: McpSseSpec): SSEClientTransport {
  const requestInit: RequestInit | undefined = spec.headers
    ? { headers: spec.headers }
    : undefined
  return new SSEClientTransport(new URL(spec.url), {
    requestInit,
  })
}
