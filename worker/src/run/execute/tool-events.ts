import {
  attributionFromActorContext,
  recordConnectorUsage,
  type ConnectorType,
  type ConnectorUsage,
} from '@nessie/runtime'
import { parseAgentId, parseRunId, type AuthorizedActionContext } from '@nessie/schemas'
import { buildScopes } from './scopes.js'
import type { ExecutionDependencies, RunContext } from './types.js'

// Builtin tools that reach an external/third-party service. Each call is billed
// to the connector usage ledger (sibling to the AI token ledger) so non-AI
// third-party usage is attributable per org/channel/agent/run. Tools not listed
// here are internal (messaging, files, scheduling) and are not connector usage.
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
    durationMs: number
    inputSummary: string
    outputPreview: string
    startedAt: Date
    success: boolean
    toolName: string
    connectorUsage?: ConnectorUsage
  },
): Promise<void> => {
  const endedAt = new Date()

  await deps.prisma.toolCall.create({
    data: {
      agentId: context.agent.id,
      durationMs: input.durationMs,
      endedAt,
      inputSummary: input.inputSummary,
      outputPreview: input.outputPreview,
      runId: context.run.id,
      startedAt: input.startedAt,
      success: input.success,
      toolName: input.toolName,
    },
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
    }).catch(() => {
      // best-effort billing capture; never break the run on a ledger failure
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
