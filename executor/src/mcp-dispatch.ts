import {
  ExecutorMcpCallPayloadSchema,
  ExecutorMcpToolsArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/schemas'

import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
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
  command: Pick<ExecutorCommandEnvelope, 'commandId' | 'operationKey' | 'payload'>,
  sessions: ExecutorMcpSessionManager | undefined,
  codingBridge?: Pick<CodingSessionsDaemon, 'callMeta'>,
): Promise<Record<string, unknown>> => {
  if (!sessions) return { code: 'EXECUTOR_MCP_UNAVAILABLE', success: false }
  if (command.operationKey === 'mcp.tools') {
    const parsed = ExecutorMcpToolsArgumentsSchema.safeParse(command.payload.args)
    if (!parsed.success) return { code: 'EXECUTOR_COMMAND_ARGUMENTS_INVALID', success: false }
    return sessions.listTools(parsed.data.server, parsed.data.cursor)
  }
  const parsed = ExecutorMcpCallPayloadSchema.safeParse(command.payload)
  if (!parsed.success) return { code: 'EXECUTOR_COMMAND_ARGUMENTS_INVALID', success: false }
  const { args, owner } = parsed.data
  // `arguments` is passed through untouched: the tool's own grammar belongs to
  // the server, and validating it here would guarantee drift the first time
  // that server ships a new field. Who the call is for travels beside it, in
  // reserved `_meta`, and only to the executor's own coding-sessions bridge.
  const meta = codingBridge?.callMeta(args.server, { commandId: command.commandId, ...(owner ? { owner } : {}) })
  return sessions.callTool(args.server, args.tool, args.arguments, meta)
}
