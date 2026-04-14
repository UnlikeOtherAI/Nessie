/**
 * src/mcp/client-types.ts — Types for MCP client (connecting to external servers).
 */

import { z } from 'zod'

// Transport types
export const TransportTypeSchema = z.enum(['stdio', 'http'])
export type TransportType = z.infer<typeof TransportTypeSchema>

// Server configuration
export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1).optional(),  // For stdio transport
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  transport: TransportTypeSchema.default('stdio'),
  url: z.string().url().optional(),  // For http transport
})

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
