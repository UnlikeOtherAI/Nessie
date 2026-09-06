import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { McpScopeError } from './scopes.js'
import { boardTools } from './tools/boards.js'
import { documentTools } from './tools/documents.js'
import type { McpToolContext, McpToolDefinition } from './tool-context.js'

/**
 * The Nessie MCP server.
 *
 * Built fresh per request rather than kept as a singleton: each call
 * authenticates its own credential and runs as its own person, so there is no
 * cross-request state to hold — which is also what keeps this endpoint safe to
 * run behind more than one replica without pinning a session to one of them.
 */

export const nessieMcpTools = (): McpToolDefinition[] => [
  ...boardTools(),
  ...documentTools(),
]

/**
 * Refusals are results, not transport errors.
 *
 * A missing scope or an unreachable project is something the agent should read
 * and act on — ask for the scope, pick another project — so it comes back as
 * content with `isError`, which the protocol defines for exactly this. A thrown
 * exception would instead surface as a JSON-RPC failure the model cannot
 * reason about.
 */
const toolResult = (payload: unknown, isError?: boolean) => ({
  content: [{ text: JSON.stringify(payload, null, 2), type: 'text' as const }],
  // A result carrying `error` IS an error, however it was produced. Tools
  // return refusals rather than throwing — a denied policy, an unreachable
  // project, a read-only board — and marking those `isError: false` told the
  // client the call had succeeded while handing the model an error object to
  // interpret on its own. Derived here rather than passed by each call site,
  // so a new tool cannot forget.
  isError:
    isError
    ?? (typeof payload === 'object'
      && payload !== null
      && 'error' in payload
      && (payload as { error?: unknown }).error !== undefined),
})

export const buildNessieMcpServer = (context: McpToolContext): McpServer => {
  const server = new McpServer(
    { name: 'nessie', version: '1.0.0' },
    {
      instructions:
        'Nessie work surfaces. Boards cover both Nessie-native boards and those '
        + 'mirrored from Linear, Jira, GitHub and Trello — every task says which '
        + 'it is and whether writes through Nessie reach the external system. '
        + 'Documents are the knowledge base. Every tool runs as the person who '
        + 'approved this credential and can reach only what they can reach.',
    },
  )

  for (const tool of nessieMcpTools()) {
    server.tool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (input: Record<string, unknown>) => {
        try {
          return toolResult(await tool.run(context, input))
        } catch (error) {
          if (error instanceof McpScopeError) {
            return toolResult({ error: error.message, scope: error.required }, true)
          }
          // Anything else is a real fault. Log it server-side and hand the
          // agent a bounded message: an upstream error string can carry
          // details of other tenants' data, and a tool result is the one place
          // that would be read straight into a model's context.
          console.error(`[mcp] tool ${tool.name} failed`, error)
          return toolResult(
            { error: `The \`${tool.name}\` call failed. The failure was logged.` },
            true,
          )
        }
      },
    )
  }

  return server
}
