import {
  attributionFromActorContext,
  recordConnectorUsage,
  type ConnectorType,
  type ConnectorUsage,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseRunId,
  redactDetectedSecrets,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { buildScopes } from './scopes.js'
import { captureDemonstrationToolEnd } from './demonstration-capture.js'
import type { ExecutionDependencies, RunContext } from './types.js'

// Builtin tools that reach an external/third-party service. Each call is copied
// to Nessie's operational connector telemetry for local diagnostics and
// budgets. It is never commercial/invoice authority: Ledger records raw
// provider usage at the outbound chokepoint and UOA alone rates it. Tools not
// listed here are internal (messaging, files, scheduling).
const CONNECTOR_TYPE_BY_TOOL: Record<string, ConnectorType> = {
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  http_fetch: 'http',
}

export const recordToolEnd = async (
  deps: ExecutionDependencies,
  context: RunContext,
  actorContext: AuthorizedActionContext,
  input: {
    argumentsValue: Record<string, unknown>
    durationMs: number
    inputSummary: string
    outputPreview: string
    startedAt: Date
    success: boolean
    toolName: string
    connectorUsage?: ConnectorUsage
    toolCallRecordId?: string
  },
): Promise<void> => {
  const endedAt = new Date()
  const inputSummary = redactDetectedSecrets(input.inputSummary)
  const outputPreview = redactDetectedSecrets(input.outputPreview)

  if (input.toolCallRecordId) {
    const updated = await deps.prisma.toolCall.updateMany({
      where: {
        agentId: context.agent.id,
        id: input.toolCallRecordId,
        runId: context.run.id,
      },
      data: {
        durationMs: input.durationMs,
        endedAt,
        inputSummary,
        outputPreview,
        success: input.success,
      },
    })
    if (updated.count !== 1) {
      throw new Error('Executor ToolCall record is unavailable.')
    }
  } else {
    await deps.prisma.toolCall.create({
      data: {
        agentId: context.agent.id,
        durationMs: input.durationMs,
        endedAt,
        inputSummary,
        outputPreview,
        runId: context.run.id,
        startedAt: input.startedAt,
        success: input.success,
        toolName: input.toolName,
      },
    })
  }

  await captureDemonstrationToolEnd(deps.prisma, {
    agentId: context.agent.id,
    argumentsValue: input.argumentsValue,
    demonstrationId: context.activeDemonstrationId,
    durationMs: input.durationMs,
    endedAt,
    organizationId: context.channel.organizationId,
    runId: context.run.id,
    startedAt: input.startedAt,
    success: input.success,
    threadId: context.run.threadId,
    toolName: input.toolName,
  })

  const connectorType =
    input.connectorUsage?.connectorType ?? CONNECTOR_TYPE_BY_TOOL[input.toolName]
  if (connectorType) {
    await recordConnectorUsage(deps.prisma, {
      attribution: attributionFromActorContext(actorContext, {
        agentId: context.agent.id,
        runId: context.run.id,
      }),
      event: {
        ...(input.connectorUsage ?? {}),
        connectorType,
        operation: input.connectorUsage?.operation ?? input.toolName,
        success: input.success,
        latencyMs: input.durationMs,
      },
    }).catch((err) => {
      // Best-effort operational capture; never break the run when the local
      // telemetry write fails, but keep the loss visible.
      console.error('[worker.ledger] connector usage write failed', err)
    })
  }

  await deps.realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      durationMs: input.durationMs,
      runId: parseRunId(context.run.id),
      success: input.success,
      toolName: input.toolName,
    },
    event: 'agent.tool.end',
  })
}
