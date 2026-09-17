import {
  ExecutorMcpCallArgumentsSchema,
  ExecutorMcpToolsArgumentsSchema,
} from '@nessie/schemas'

import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'

/**
 * The daemon's two MCP proxy operations.
 *
 * Both refuse outright when this daemon has no session manager, which is how a
 * build that cannot front a local server says so rather than failing at the
 * first call. The policy check itself is the session manager's, and it happens
 * before any process starts.
 */
export const executeExecutorMcpCommand = async (
  operationKey: 'mcp.tools' | 'mcp.call',
  args: unknown,
  sessions: ExecutorMcpSessionManager | undefined,
): Promise<Record<string, unknown>> => {
  if (!sessions) return { code: 'EXECUTOR_MCP_UNAVAILABLE', success: false }
  if (operationKey === 'mcp.tools') {
    const parsed = ExecutorMcpToolsArgumentsSchema.safeParse(args)
    if (!parsed.success) return { code: 'EXECUTOR_COMMAND_ARGUMENTS_INVALID', success: false }
    return sessions.listTools(parsed.data.server, parsed.data.cursor)
  }
  const parsed = ExecutorMcpCallArgumentsSchema.safeParse(args)
  if (!parsed.success) return { code: 'EXECUTOR_COMMAND_ARGUMENTS_INVALID', success: false }
  // `arguments` is passed through untouched: the tool's own grammar belongs to
  // the server, and validating it here would guarantee drift the first time
  // that server ships a new field.
  return sessions.callTool(parsed.data.server, parsed.data.tool, parsed.data.arguments)
}
