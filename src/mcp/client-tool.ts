/**
 * src/mcp/client-tool.ts — Agent tool for calling MCP server tools.
 * Aggregates MCP tools into agent namespace with workspace boundary security.
 */

import { z } from 'zod'
import { buildTool } from '../tools/Tool.js'
import type { Tool } from '../tools/Tool.js'
import { getMcpClientManager, McpClientManager } from './client-manager.js'
import type { McpTool } from './client-types.js'

// Schema for calling an MCP tool
const McpToolCallSchema = z.object({
  server: z.string().describe('Name of the MCP server'),
  tool: z.string().describe('Name of the tool to call'),
  arguments: z.record(z.unknown()).default({}),
})

export type McpToolCallInput = z.infer<typeof McpToolCallSchema>

export function createMcpClientTool(manager?: McpClientManager): Tool<McpToolCallInput, unknown> {
  const clientManager = manager ?? getMcpClientManager()

  return buildTool({
    name: 'McpClient',
    description: 'Call tools on external MCP (Model Context Protocol) servers',
    inputSchema: McpToolCallSchema,

    async call(args, _context) {
      try {
        const result = await clientManager.callTool(args.server, args.tool, args.arguments)
        return { data: result }
      } catch (err) {
        return {
          data: {
            error: err instanceof Error ? err.message : String(err),
          },
        }
      }
    },

    isConcurrencySafe() { return false },
    isReadOnly() { return false },

    userFacingName() { return 'MCP Client' },
    getActivityDescription(input) {
      return input ? `MCP: ${input.server}/${input.tool}` : 'MCP tool call'
    },
    maxResultSizeChars: 100_000,
  })
}

// Schema for listing MCP servers and their tools
const McpListServersSchema = z.object({
  action: z.literal('listServers'),
})

const McpListToolsSchema = z.object({
  action: z.literal('listTools'),
  server: z.string().optional().describe('Optional server name to filter by'),
})

const McpGetStateSchema = z.object({
  action: z.literal('getState'),
  server: z.string(),
})

const McpConnectSchema = z.object({
  action: z.literal('connect'),
  server: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  url: z.string().optional(),
})

const McpDisconnectSchema = z.object({
  action: z.literal('disconnect'),
  server: z.string(),
})

const McpToolSchema = z.discriminatedUnion('action', [
  McpListServersSchema,
  McpListToolsSchema,
  McpGetStateSchema,
  McpConnectSchema,
  McpDisconnectSchema,
])

export type McpToolInput = z.infer<typeof McpToolSchema>

export function createMcpAdminTool(manager?: McpClientManager): Tool<McpToolInput, unknown> {
  const clientManager = manager ?? getMcpClientManager()

  return buildTool({
    name: 'McpAdmin',
    description: 'Manage MCP client connections and list available tools',
    inputSchema: McpToolSchema,

    async call(args, _context) {
      switch (args.action) {
        case 'listServers': {
          const servers = clientManager.listServers()
          return { data: { servers } }
        }

        case 'listTools': {
          if (args.server) {
            const tools = clientManager.getTools(args.server)
            return { data: { server: args.server, tools } }
          }
          // List all tools from all servers
          const allTools = clientManager.getAllTools()
          const result: Record<string, McpTool[]> = {}
          for (const [server, tools] of allTools) {
            result[server] = tools
          }
          return { data: { servers: result } }
        }

        case 'getState': {
          const state = clientManager.getState(args.server)
          if (!state) {
            return { data: { error: `Server not found: ${args.server}` } }
          }
          return { data: { server: args.server, state } }
        }

        case 'connect': {
          try {
            await clientManager.connectServer(args.server, {
              name: args.server,
              command: args.command,
              args: args.args,
              env: args.env,
              transport: args.transport,
              url: args.url,
            })
            return { data: { connected: true, server: args.server } }
          } catch (err) {
            return {
              data: {
                error: err instanceof Error ? err.message : String(err),
                server: args.server,
              },
            }
          }
        }

        case 'disconnect': {
          clientManager.disconnect(args.server)
          return { data: { disconnected: true, server: args.server } }
        }

        default:
          return { data: { error: `Unknown action: ${(args as { action: string }).action}` } }
      }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },

    userFacingName() { return 'MCP Admin' },
    getActivityDescription(input) {
      return input ? `MCP Admin: ${(input as { action: string }).action}` : 'MCP admin operation'
    },
    maxResultSizeChars: 50_000,
  })
}

export const McpClientTool = createMcpClientTool()
export const McpAdminTool = createMcpAdminTool()
