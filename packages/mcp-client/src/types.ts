/**
 * Public types for `@nessie/mcp-client`.
 *
 * The manager is transport-and-protocol only: it accepts a fully-resolved
 * connection spec (including any headers/env the caller wants to inject) and
 * returns branded connection ids that the caller then uses to invoke MCP
 * operations.  Credential resolution lives entirely outside this package.
 */

declare const McpConnectionIdBrand: unique symbol

/**
 * Opaque, branded identifier for an open MCP connection. Treat as a string
 * everywhere outside of this package; never construct manually.
 */
export type McpConnectionId = string & { readonly [McpConnectionIdBrand]: true }

/** Stdio transport — spawns the given executable as a child process. */
export type McpStdioSpec = {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** Streamable-HTTP transport — newest MCP transport (POST + SSE on one URL). */
export type McpHttpSpec = {
  transport: 'http'
  url: string
  headers?: Record<string, string>
  /**
   * Override the outbound transport. Defaults to the SSRF-safe, IP-pinned
   * fetch, which is what every production caller wants. Tests that talk to a
   * controlled loopback fixture pass the platform fetch instead, since the
   * guard blocks private addresses by design.
   */
  fetchImpl?: typeof globalThis.fetch
}

/** Legacy SSE transport — separate GET (SSE) + POST endpoint. */
export type McpSseSpec = {
  transport: 'sse'
  url: string
  headers?: Record<string, string>
  /** See `McpHttpSpec.fetchImpl`. */
  fetchImpl?: typeof globalThis.fetch
}

/**
 * Discriminated union over all transports supported by this client. New
 * transports should land here first — never add transport flags out-of-band.
 */
export type McpConnectionSpec = McpStdioSpec | McpHttpSpec | McpSseSpec

/** Output shape of `tools/list` after normalisation. */
export type McpToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

/** Output shape of `tools/call` after normalisation. */
export type McpToolResult = {
  isError: boolean
  /** Raw content array from the MCP server, unmodified. */
  content: unknown[]
  /** Tool-defined structured result, if the server returned one. */
  structuredContent?: Record<string, unknown>
}

/**
 * Lifecycle state for a connection. Mirrors what `health()` returns. We do
 * NOT silently keep a dead pin alive — `failed` is terminal once the backoff
 * budget is exhausted; the caller must `open()` a new connection to recover.
 */
export type McpConnectionState =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closed'
  | 'failed'

export type McpHealth = {
  id: McpConnectionId
  state: McpConnectionState
  /** Result of the most recent ping, if one has been issued. */
  lastPingOk: boolean | null
  lastPingAt: number | null
  consecutiveFailures: number
}

/** Subscribable lifecycle events emitted by `McpClientManager.on(...)`. */
export type McpManagerEvent =
  | { type: 'state'; id: McpConnectionId; state: McpConnectionState }
  | { type: 'error'; id: McpConnectionId; error: Error }
  | { type: 'notification'; id: McpConnectionId; method: string; params: unknown }

export type McpEventName = McpManagerEvent['type']

export type McpEventCallback<E extends McpEventName> = (
  event: Extract<McpManagerEvent, { type: E }>,
) => void

export type Unsubscribe = () => void
