import { IMPLEMENTED_EXECUTOR_OPERATION_KEYS, type AuthorizedActionContext } from '@nessie/schemas'

import { isCodingSessionToolName } from '../coding-session-tools.js'
import type { CodingSessionHooks } from '../executor-coding-sessions.js'
import { executorToolName, type ExecutorToolset } from '../executor-toolset.js'
import {
  presentExecutorMcpCatalogAnswer,
  presentExecutorResultForModel,
} from '../executor-result-presentation.js'
import type { AgenticToolResult } from '../tools.js'
import { emitWorkerAuditEvent } from './policy.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const operationKeyOf = (toolName: string): string | undefined =>
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS.find((operationKey) => executorToolName(operationKey) === toolName)

/**
 * An authorized executor tool call, as the main agent loop runs it: dispatched
 * (or, for `executor_mcp_tools`, answered from the run's catalog of that
 * program), audited when it acts, and shaped for the model last. The shaping
 * is the only difference from `dispatch`, which stays the raw document for
 * every other caller. A coding-session tool is shaped by its own module and
 * gets the loop's hooks: the drain signal, and the thought-process line a
 * wait keeps current.
 */
export const createExecutorToolExecution = (
  deps: ExecutionDependencies,
  context: RunContext,
  toolset: ExecutorToolset,
  hooks: CodingSessionHooks = {},
) => async (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  toolActorContext: AuthorizedActionContext,
): Promise<AgenticToolResult> => {
  if (toolset.codingSessions && isCodingSessionToolName(toolName)) {
    return toolset.codingSessions.execute(toolName, args, toolCallId, hooks)
  }
  if (toolName === executorToolName('mcp.tools')) {
    const server = typeof args.server === 'string' ? args.server : ''
    return presentExecutorMcpCatalogAnswer(args, await toolset.mcpCatalog(server, toolCallId))
  }
  const result = await toolset.dispatch(toolName, args, toolCallId)
  if (toolName === executorToolName('browser.act') || toolName === executorToolName('command.run')) {
    const metadata = toolName === executorToolName('browser.act')
      ? {
          action: typeof args.action === 'string' ? args.action : 'unknown',
          ...(typeof args.nodeId === 'number' ? { nodeId: args.nodeId } : {}),
          runId: context.run.id,
          toolCallId,
        }
      : {
          program: typeof args.program === 'string' ? args.program : 'unknown',
          runId: context.run.id,
          toolCallId,
        }
    await emitWorkerAuditEvent(deps.prisma, toolActorContext, {
      action: toolName === executorToolName('browser.act')
        ? 'executor.browser.action.dispatched'
        : 'executor.command.run.dispatched',
      metadata,
      outcome: result.success ? 'success' : 'error',
      resourceId: result.toolCallRecordId,
      resourceType: 'executor_command',
    })
  }
  return presentExecutorResultForModel(operationKeyOf(toolName), args, result)
}
