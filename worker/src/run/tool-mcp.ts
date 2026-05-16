import {
  McpClientManager,
  type McpToolResult,
} from '@nessie/mcp-client'
import type { McpTransportConfig } from '@nessie/schemas'

/**
 * MCP transport handler used by the universal worker dispatcher.
 *
 * Spec: `docs/external-tool-integration.md` §2/§4 and
 * `docs/plans/2026-05-16-mcp-universal-connector.md` §5 (worker dispatch).
 *
 * The dispatcher owns the `McpClientManager` lifetime and passes a
 * fully-resolved transport spec — including any auth headers/env minted from
 * the per-principal credential chain — into this helper. We open a one-shot
 * connection per call to keep the contract simple; pooling is a separate
 * concern that can land in a follow-up without breaking this surface.
 */

export type McpDispatchInput = {
  transport: McpTransportConfig
  toolName: string
  args: unknown
  /** Optional ms timeout for the `tools/call` round-trip. */
  timeoutMs?: number
  /** Caller-controlled abort signal (e.g. job cancellation). */
  abort?: AbortSignal
  /** Injection seam for tests so the manager can be stubbed wholesale. */
  managerFactory?: () => McpClientManager
}

export type McpDispatchOutput = McpToolResult

const defaultManagerFactory = (): McpClientManager => new McpClientManager()

const toConnectionSpec = (config: McpTransportConfig): Parameters<McpClientManager['open']>[0] => {
  switch (config.transport) {
    case 'stdio':
      return {
        transport: 'stdio',
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      }
    case 'http':
      return { transport: 'http', url: config.url, headers: config.headers }
    case 'sse':
      return { transport: 'sse', url: config.url, headers: config.headers }
    case 'ws':
      throw new Error('ws transport is not yet supported by the MCP client')
    default: {
      const _never: never = config
      void _never
      throw new Error('Unsupported MCP transport')
    }
  }
}

export const runMcpTool = async (
  input: McpDispatchInput,
): Promise<McpDispatchOutput> => {
  const manager = (input.managerFactory ?? defaultManagerFactory)()
  let connectionId: Awaited<ReturnType<McpClientManager['open']>> | null = null
  try {
    connectionId = await manager.open(toConnectionSpec(input.transport))
    return await manager.callTool(connectionId, input.toolName, input.args, {
      timeoutMs: input.timeoutMs,
      abort: input.abort,
    })
  } finally {
    if (connectionId) {
      await manager.close(connectionId).catch(() => undefined)
    }
    await manager.closeAll().catch(() => undefined)
  }
}
