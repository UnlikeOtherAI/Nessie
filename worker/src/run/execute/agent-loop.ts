import { loadConfig } from '@nessie/config'
import {
  BUILTIN_TOOL_DEFINITIONS,
  type InferenceResult,
  type InvocationRecord,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseOrganizationId,
  parseRunId,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { DEFAULT_BUDGET, runAgenticLoop, type LoopResult } from '../agentic-loop.js'
import { runDelegate } from '../delegate.js'
import { runInferenceGraph } from '../inference.js'
import type { McpToolset } from '../mcp-toolset.js'
import { authorizeToolCall } from '../tool-policy.js'
import { summarizeToolInput } from '../tool-util.js'
import { executeBuiltinTool } from '../tools.js'
import { buildScopes } from './scopes.js'
import { setAgentStatus } from './lifecycle.js'
import {
  buildToolActorContext,
  emitWorkerAuditEvent,
  evaluateToolInvokePolicy,
  toolDeniedResult,
} from './policy.js'
import { publishAgentStatus } from './realtime.js'
import { recordToolEnd } from './tool-events.js'
import type {
  BudgetModelOverride,
  ExecutionDependencies,
  RunContext,
} from './types.js'

const runtimeModelConfig = loadConfig().model

type InferenceCallbacks = {
  onVisibleReasoningDelta: (chunk: string) => Promise<void>
  onVisibleTextDelta: (chunk: string) => Promise<void>
}

export const runExecutionAgentLoop = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    allowedToolIds: Set<string>
    budgetModelOverride: BudgetModelOverride | null
    initialMessages: ProviderMessage[]
    mcpToolset: McpToolset
    resolvedToolIds: Set<string>
    toolDefs: ToolSchemaDescriptor[]
    toolPolicy: Record<string, boolean> | null
  },
): Promise<LoopResult> => {
  let currentTurnStreamed = false
  const subAgentInvocations: InvocationRecord[] = []

  const subAgentBuiltinDescriptors = input.toolDefs.filter((d) => d.toolName !== 'delegate')
  const subAgentBuiltinIds = new Set(
    [...input.resolvedToolIds].filter((id) => id !== 'delegate'),
  )
  const mcpExposedNames = new Set(input.mcpToolset.descriptors.map((d) => d.toolName))
  const mainToolDefs = [...input.toolDefs, ...input.mcpToolset.descriptors]

  const mainInferenceCallbacks: InferenceCallbacks = {
    onVisibleReasoningDelta: async (chunk) => {
      await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.reasoning', {
        content: chunk,
        runId: parseRunId(context.run.id),
      })
    },
    onVisibleTextDelta: async (chunk) => {
      currentTurnStreamed = true
      await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
        content: chunk,
        runId: parseRunId(context.run.id),
      })
    },
  }
  const silentInferenceCallbacks: InferenceCallbacks = {
    onVisibleReasoningDelta: async () => undefined,
    onVisibleTextDelta: async () => undefined,
  }

  const runInferenceWithCallbacks = async (
    messages: ProviderMessage[],
    tools: ToolSchemaDescriptor[],
    callbacks: InferenceCallbacks,
  ): Promise<InferenceResult> => {
    const mpr = await runInferenceGraph(deps.prisma, {
      actorContext: payload.actorContext,
      agent: {
        id: context.agent.id,
        model: input.budgetModelOverride?.model ?? context.agent.model,
        provider: input.budgetModelOverride?.provider ?? context.agent.provider,
        routingProfileId: null,
      },
      baseMessages: messages,
      modelConfig: runtimeModelConfig,
      onVisibleReasoningDelta: callbacks.onVisibleReasoningDelta,
      onVisibleTextDelta: callbacks.onVisibleTextDelta,
      organizationId: context.channel.organizationId,
      toolChoice: 'auto',
      tools,
    })
    if (
      mpr.status !== 'completed'
      || (!mpr.finalAnswer?.trim() && mpr.toolCalls.length === 0)
    ) {
      throw new Error(mpr.failure?.message ?? 'Inference execution produced no final answer')
    }
    return {
      correlationId: mpr.correlationId,
      finishReason: mpr.invocations[0]?.finishReason,
      invocations: mpr.invocations as unknown as InvocationRecord[],
      model: mpr.invocations[0]?.model ?? '',
      outputText: mpr.finalAnswer ?? '',
      provider: (mpr.invocations[0]?.provider ?? 'openai') as 'openai' | 'minimax' | 'kimi' | 'openai-compatible',
      requestId: mpr.requestId,
      toolCalls: mpr.toolCalls,
    }
  }

  const runMainInference = (messages: ProviderMessage[], tools: ToolSchemaDescriptor[]) => {
    currentTurnStreamed = false
    return runInferenceWithCallbacks(messages, tools, mainInferenceCallbacks)
  }

  const runSubAgentInference = (messages: ProviderMessage[], tools: ToolSchemaDescriptor[]) =>
    runInferenceWithCallbacks(messages, tools, silentInferenceCallbacks)

  const buildBuiltinCtx = (toolActorContext: ReturnType<typeof buildToolActorContext>) => ({
    agentId: context.agent.id,
    agentKind: context.agent.agentKind,
    actorContext: toolActorContext,
    channel: {
      id: context.channel.id,
      organizationId: parseOrganizationId(context.channel.organizationId),
      systemChannelType: context.channel.systemChannelType,
    },
    mcpSecrets: deps.mcpSecrets,
    memoryCaptureConfig: {
      modelClient: deps.modelClient,
      pool: deps.searchConfig.pool,
    },
    modelClient: deps.modelClient,
    prisma: deps.prisma,
    realtimeTransport: deps.realtimeTransport,
    run: {
      id: context.run.id,
      messageId: payload.messageId,
      threadId: context.run.threadId,
    },
  })

  const loopResult = await runAgenticLoop({
    budget: DEFAULT_BUDGET,
    callbacks: {
      onIterationStart: async (iteration) => {
        await deps.realtimeTransport.publishWs(buildScopes(context), {
          data: {
            agentId: parseAgentId(context.agent.id),
            iteration,
            runId: parseRunId(context.run.id),
          },
          event: 'agent.iteration',
        })
      },
      onToolCallStart: async (toolName, _args) => {
        const startedAt = new Date()
        await setAgentStatus(deps.prisma, context.agent.id, 'executing')
        await publishAgentStatus(deps.realtimeTransport, context, {
          currentRunId: context.run.id,
          currentToolName: toolName,
          currentToolStartedAt: startedAt.toISOString(),
          status: 'executing',
        })
        await deps.realtimeTransport.publishWs(buildScopes(context), {
          data: {
            agentId: parseAgentId(context.agent.id),
            inputSummary: summarizeToolInput(_args),
            runId: parseRunId(context.run.id),
            toolName,
          },
          event: 'agent.tool.start',
        })
      },
      onToolCallEnd: async (
        toolName,
        result,
        durationMs,
        success,
        inputSummary,
        startedAt,
        connectorUsage,
      ) => {
        await recordToolEnd(deps, context, payload.actorContext, {
          durationMs,
          inputSummary,
          outputPreview: result.slice(0, 1200),
          startedAt,
          success,
          toolName,
          connectorUsage,
        })
        await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
        await publishAgentStatus(deps.realtimeTransport, context, {
          currentRunId: context.run.id,
          status: 'thinking',
        })
      },
      onTextDelta: async (delta) => {
        if (currentTurnStreamed) {
          currentTurnStreamed = false
          return
        }
        await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
          content: delta,
          runId: parseRunId(context.run.id),
        })
      },
      onBudgetExhausted: async (reason) => {
        console.warn(`[worker] Agentic loop budget exhausted: ${reason} for run ${context.run.id}`)
      },
    },
    executeTool: async (toolName, args) => {
      const toolActorContext = buildToolActorContext(payload.actorContext, context, toolName)
      if (toolName === 'delegate') {
        const result = await runDelegate(args, {
          mcpToolset: input.mcpToolset,
          runInference: runSubAgentInference,
          executeBuiltinTool: (n, a) => executeBuiltinTool(n, a, buildBuiltinCtx(toolActorContext)),
          builtinDescriptors: subAgentBuiltinDescriptors,
          allowedBuiltinIds: subAgentBuiltinIds,
        })
        subAgentInvocations.push(...result.invocations)
        return {
          inputSummary: result.inputSummary,
          output: result.output,
          success: result.success,
        }
      }
      if (mcpExposedNames.has(toolName)) {
        return input.mcpToolset.dispatch(toolName, args)
      }
      const registryDecision = authorizeToolCall(
        toolName,
        input.allowedToolIds,
        BUILTIN_TOOL_DEFINITIONS,
        input.toolPolicy,
        context.agent.parentAgentId,
        context.agent.agentKind,
      )

      if (!registryDecision.allowed || !input.resolvedToolIds.has(toolName)) {
        const message = `Tool "${toolName}" is not allowed for this agent.`
        await emitWorkerAuditEvent(deps.prisma, toolActorContext, {
          action: 'policy.evaluated',
          metadata: {
            agentId: context.agent.id,
            runId: context.run.id,
            source: 'worker_tool_authorization',
            taskId: context.task.id,
            toolId: toolName,
          },
          outcome: 'denied',
          reason: registryDecision.allowed ? 'tool_not_granted' : registryDecision.reason,
          resourceId: toolName,
          resourceType: 'tool',
        })
        return toolDeniedResult(toolName, args, {
          message,
          reason: registryDecision.allowed ? 'tool_not_granted' : registryDecision.reason,
        })
      }

      const policyDecision = await evaluateToolInvokePolicy(
        deps.prisma,
        toolActorContext,
        context,
        toolName,
      )
      if (!policyDecision.allowed) {
        const message =
          policyDecision.reason === 'approval_required'
            ? `Tool "${toolName}" requires approval before it can run.`
            : `Tool "${toolName}" was denied by policy.`
        await emitWorkerAuditEvent(deps.prisma, toolActorContext, {
          action: 'policy.evaluated',
          metadata: {
            agentId: context.agent.id,
            approvalActionType: policyDecision.approvalActionType,
            policyRuleId: policyDecision.policyRuleId,
            policySource: policyDecision.policySource,
            runId: context.run.id,
            source: 'worker_tool_policy',
            taskId: context.task.id,
            toolId: toolName,
          },
          outcome: 'denied',
          reason: policyDecision.reason,
          resourceId: toolName,
          resourceType: 'tool',
        })
        return toolDeniedResult(toolName, args, {
          approvalActionType: policyDecision.approvalActionType,
          message,
          policyRuleId: policyDecision.policyRuleId,
          policySource: policyDecision.policySource,
          reason: policyDecision.reason,
        })
      }
      return executeBuiltinTool(toolName, args, buildBuiltinCtx(toolActorContext))
    },
    initialMessages: input.initialMessages,
    runInference: (messages) => runMainInference(messages, mainToolDefs),
    tools: mainToolDefs,
  })

  if (subAgentInvocations.length > 0) {
    loopResult.invocations.push(...subAgentInvocations)
  }

  return loopResult
}
