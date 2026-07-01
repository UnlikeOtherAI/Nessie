import { McpTransportConfigSchema, type McpTransportConfig } from '@nessie/schemas'

import { runHttpTool, type HttpToolEndpoint } from './tool-http.js'
import { runMcpTool } from './tool-mcp.js'

/**
 * Universal worker dispatcher (plan §5).
 *
 * Given a `ToolRegistryEntry` row (looked up + grant-checked by the API tier),
 * the dispatcher picks the right transport-specific handler and returns a
 * normalised result so the agentic loop can render it without caring whether
 * the call hit a builtin, MCP server, or HTTP endpoint.
 *
 * `direct` transport is intentionally NOT handled here — those tools already
 * route through `executeBuiltinTool` in `tools.ts`. This dispatcher is the
 * extension point for `mcp` and `http` transports introduced in Slice C.
 */

export const TOOL_DISPATCH_ERROR_CODES = {
  TRANSPORT_UNSUPPORTED: 'TOOL_DISPATCH_TRANSPORT_UNSUPPORTED',
  TRANSPORT_CONFIG_INVALID: 'TOOL_DISPATCH_TRANSPORT_CONFIG_INVALID',
} as const

export class ToolDispatchError extends Error {
  override readonly name = 'ToolDispatchError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type ToolDispatchResult = {
  /** True when the underlying transport reported the call succeeded. */
  success: boolean
  /** Normalised text the agentic loop will surface to the LLM. */
  output: string
  /** Raw transport-specific payload retained for audit / structured rendering. */
  raw: unknown
}

export type McpDispatchSpec = {
  transport: 'mcp'
  /** Resolved MCP transport config (stdio/http/sse). */
  connection: McpTransportConfig
  toolName: string
}

export type HttpDispatchSpec = {
  transport: 'http'
  endpoint: HttpToolEndpoint
}

export type DispatchSpec = McpDispatchSpec | HttpDispatchSpec

export type DispatchInput = {
  spec: DispatchSpec
  args: unknown
  /** Resolved plaintext credential (or null if the tool needs none). */
  secret?: string | null
  /** Optional cancellation hook. */
  abort?: AbortSignal
  /** Per-call MCP timeout override. */
  timeoutMs?: number
  /** HTTP transport override used by tests; see `runHttpTool`. */
  httpFetchImpl?: typeof fetch
}

const stringifyForOutput = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const applyBearerSecretToMcpTransport = (
  transport: McpTransportConfig,
  secret?: string | null,
): McpTransportConfig => {
  if (!secret || transport.transport === 'stdio') return transport
  return {
    ...transport,
    headers: {
      ...(transport.headers ?? {}),
      Authorization: `Bearer ${secret}`,
    },
  }
}

/**
 * Decode an untyped `transportConfig` blob (as stored on `McpServerInstance`)
 * into a typed `McpTransportConfig`. Centralised here so every entry point —
 * API-side `tool-dispatch.ts`, worker tests, future probes — fails the same
 * way with the same error code.
 */
export const parseMcpTransportConfig = (value: unknown): McpTransportConfig => {
  const parsed = McpTransportConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new ToolDispatchError(
      TOOL_DISPATCH_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      `Invalid MCP transport config: ${parsed.error.issues[0]?.message ?? 'shape mismatch'}`,
    )
  }
  return parsed.data
}

export const dispatchTool = async (
  input: DispatchInput,
): Promise<ToolDispatchResult> => {
  switch (input.spec.transport) {
    case 'mcp': {
      const result = await runMcpTool({
        transport: applyBearerSecretToMcpTransport(
          input.spec.connection,
          input.secret,
        ),
        toolName: input.spec.toolName,
        args: input.args,
        timeoutMs: input.timeoutMs,
        abort: input.abort,
      })
      return {
        success: !result.isError,
        output: result.structuredContent
          ? stringifyForOutput(result.structuredContent)
          : stringifyForOutput(result.content),
        raw: result,
      }
    }
    case 'http': {
      const result = await runHttpTool({
        endpoint: input.spec.endpoint,
        args: input.args,
        secret: input.secret,
        fetchImpl: input.httpFetchImpl,
      })
      return {
        success: result.status >= 200 && result.status < 300,
        output: result.bodyText,
        raw: result,
      }
    }
    default: {
      const _never: never = input.spec
      void _never
      throw new ToolDispatchError(
        TOOL_DISPATCH_ERROR_CODES.TRANSPORT_UNSUPPORTED,
        'Unsupported transport for universal dispatcher',
      )
    }
  }
}
