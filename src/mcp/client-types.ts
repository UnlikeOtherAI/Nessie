/**
 * src/mcp/client-types.ts — Types for MCP client (connecting to external servers).
 */

import { z } from 'zod'
import { McpServerConfigSchema } from '@nessie/config'

// Re-export for convenience
export { McpServerConfigSchema }
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

// MCP client config (top-level) — servers is an OBJECT per issue #50 spec
export const McpClientConfigSchema = z.object({
  servers: z.record(z.string(), McpServerConfigSchema).default({}),
})

export type McpClientConfig = z.infer<typeof McpClientConfigSchema>

// Tool from MCP server
export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

// MCP client state
export interface McpClientState {
  connected: boolean
  tools: McpTool[]
  error?: string
}
