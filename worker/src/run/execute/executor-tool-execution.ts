import { IMPLEMENTED_EXECUTOR_OPERATION_KEYS, type AuthorizedActionContext } from '@nessie/schemas'

import { executorToolName, type ExecutorToolset } from '../executor-toolset.js'
import {
  presentExecutorMcpCatalogAnswer,
  presentExecutorResultForModel,
} from '../executor-result-presentation.js'
import { resolveExecutorResultImages } from '../executor-result-images.js'
import type { AgenticToolResult } from '../tools.js'
import { emitWorkerAuditEvent } from './policy.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const operationKeyOf = (toolName: string): string | undefined =>
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS.find((operationKey) => executorToolName(operationKey) === toolName)

/**
 * An authorized executor tool call, as the main agent loop runs it: dispatched
 * (or, for `executor_mcp_tools`, answered from the run's catalog of that
 * program), audited when it acts, and shaped for the model last — with the
 * images a local program returned resolved to their attachments on the way.
 * The shaping is the only difference from `dispatch`, which stays the raw
 * document for every other caller.
 */
export const createExecutorToolExecution = (
  deps: ExecutionDependencies,
  context: RunContext,
  toolset: ExecutorToolset,
) => async (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  toolActorContext: AuthorizedActionContext,
): Promise<AgenticToolResult> => {
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
  const operationKey = operationKeyOf(toolName)
  // The images a local program returned, as the attachments that hold them.
  const images = operationKey === 'mcp.call'
    ? await resolveExecutorResultImages(deps.prisma, context.run.id, result)
    : undefined
  return presentExecutorResultForModel(operationKey, args, result, images)
}
