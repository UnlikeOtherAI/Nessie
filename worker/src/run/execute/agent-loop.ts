import {
  BUILTIN_TOOL_DEFINITIONS,
  DEEP_WATER_START_FAILURE_DETAIL,
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
import { runAgenticLoop, type BudgetLimits, type LoopResult } from '../agentic-loop.js'
import { buildContextPlan } from '../context-window.js'
import { runContextCompaction } from '../context-compaction.js'
import { estimateToolSchemaTokens } from '../context-management.js'
import { runDelegate } from '../delegate.js'
import type { ExecutorToolset } from '../executor-toolset.js'
import { createDelegateGate } from '../run-budget.js'
import type { McpToolset } from '../mcp-toolset.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
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
import type { RunInference } from './run-inference.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import { recordToolEnd } from './tool-events.js'
import type { ExecutionDependencies, RunContext } from './types.js'

export const runExecutionAgentLoop = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    allowedToolIds: Set<string>
    budget: BudgetLimits
    // Fraction of the input price a cache read costs on this run's model
    // (resolved once per run in run-job). Cache reads are metered at this
    // weight against the token budget instead of at full input price.
    cacheReadWeight: number
    // Mid-run org-`Budget` probe (throttled by its factory in budget-gate.ts).
    checkBudgetBlocked: () => Promise<boolean>
    deepWaterHandoffGuard: DeepWaterHandoffGuard
    executorToolset: ExecutorToolset
    initialMessages: ProviderMessage[]
    inference: RunInference
    // Caller-owned accumulator: every main-loop, sub-agent AND compaction
    // invocation is pushed here live, so the run's spend is attributable even if
    // the loop throws before returning (see run-job's failure path).
    invocationSink: InvocationRecord[]
    mcpToolset: McpToolset
    /** Called when the run reacts, so the terminal path knows it already spoke. */
    onReacted?: () => void
    resolvedToolIds: Set<string>
    // Durable thought log + coalesced live thinking events for the main agent.
    // Delegate sub-agents stay silent, exactly as before.
    thinkingRecorder: ThinkingRecorder
    toolDefs: ToolSchemaDescriptor[]
    toolPolicy: Record<string, boolean> | null
    // Wind-down instruction for the main loop, or null to disable (delegate
    // sub-agents and DeepWater handoff turns; non-interactive runs keep the
    // silent checkpoint + auto-continue path instead of a chat handover).
    windDownInstruction: string | null
  },
): Promise<LoopResult> => {
  const subAgentBuiltinDescriptors = input.toolDefs.filter(
    (descriptor) => descriptor.toolName !== 'delegate' && input.resolvedToolIds.has(descriptor.toolName),
  )
  const subAgentBuiltinIds = new Set(
    [...input.resolvedToolIds].filter((id) => id !== 'delegate'),
  )
  // Per-run MCP view: in deferred mode its descriptor array is LIVE
  // (mcp_load_tools / mcp_drop_tools mutate it), so the model's tool list is
  // recomposed from it on every inference call below.
  const mcpView = input.mcpToolset.createView()
  const mcpExposedNames = mcpView.handledNames
  const mainToolDefs = [...input.toolDefs, ...mcpView.descriptors]

  const delegateGate = createDelegateGate()

  const buildBuiltinCtx = (
    toolActorContext: ReturnType<typeof buildToolActorContext>,
    toolCallId: string,
  ) => ({
    agentId: context.agent.id,
    agentKind: context.agent.agentKind,
    actorContext: toolActorContext,
    channel: {
      id: context.channel.id,
      organizationId: parseOrganizationId(context.channel.organizationId),
      systemChannelType: context.channel.systemChannelType,
    },
    consumedSources: context.consumedSources,
    ledgerIdentity: deps.ledgerIdentity ?? null,
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
      originatingUserId:
        toolActorContext.actionContext.effectiveUserId
        ?? (
          toolActorContext.actor.actorType === 'user'
            ? toolActorContext.actor.actorId
            : null
        ),
      threadId: context.run.threadId,
    },
    toolCallId,
  })

  const executeGuardedBuiltin = async (
    toolName: string,
    args: Record<string, unknown>,
    toolActorContext: ReturnType<typeof buildToolActorContext>,
    toolCallId: string,
  ) => {
    if (await input.deepWaterHandoffGuard.suppressBuiltin(toolName)) {
      return {
        inputSummary: summarizeToolInput(args),
        output: DEEP_WATER_START_FAILURE_DETAIL,
        success: false,
      }
    }
    return executeBuiltinTool(
      toolName,
      args,
      buildBuiltinCtx(toolActorContext, toolCallId),
    )
  }

  const contextPlan = buildContextPlan({
    model: context.agent.model,
    toolSchemaTokens: estimateToolSchemaTokens(mainToolDefs),
  })

  const loopResult = await runAgenticLoop({
    budget: input.budget,
    cacheReadWeight: input.cacheReadWeight,
    // Cooperative-cancel probe: a cheap status read the loop consults between
    // iterations and after each tool-call batch. `POST /api/runs/:id/cancel`
    // stamps `cancelRequestedAt`; the loop then exits and run-job terminalizes
    // the run as `cancelled` via the classified-stop machinery.
    checkCancelled: async () => {
      const row = await deps.prisma.run.findUnique({
        where: { id: context.run.id },
        select: { cancelRequestedAt: true },
      })
      return row?.cancelRequestedAt != null
    },
    checkBudgetBlocked: input.checkBudgetBlocked,
    ...(input.windDownInstruction
      ? {
        windDownInstruction: input.windDownInstruction,
        // Once the model has been told to finish, new fan-out is refused
        // structurally as well as by instruction.
        onWindDown: () => delegateGate.closeForWindDown(),
      }
      : {}),
    compactContext: async ({ messages, targetTokens }) =>
      runContextCompaction({
        generateNote: async (prompt) => {
          const result = await input.inference.runUtility(
            [{ content: prompt, role: 'user' }],
            [],
          )
          // Compaction is inference the run paid for: it counts in the run's
          // totals and against the backstop like any other call.
          input.invocationSink.push(...result.invocations)
          return result.outputText
        },
        messages,
        targetTokens,
      }),
    contextPlan,
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
        // Tool activity is part of the thought process, not a separate feed.
        await input.thinkingRecorder.appendToolLine(toolName, summarizeToolInput(_args))
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
        toolCallRecordId,
      ) => {
        await recordToolEnd(deps, context, payload.actorContext, {
          durationMs,
          inputSummary,
          outputPreview: result.slice(0, 1200),
          startedAt,
          success,
          toolName,
          connectorUsage,
          toolCallRecordId,
        })
        await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
        await publishAgentStatus(deps.realtimeTransport, context, {
          currentRunId: context.run.id,
          status: 'thinking',
        })
      },
      onTextDelta: async (delta) => {
        if (input.inference.consumeStreamedFlag()) {
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
    executeTool: async (toolName, args, toolCallId) => {
      const toolActorContext = buildToolActorContext(payload.actorContext, context, toolName)
      if (await input.deepWaterHandoffGuard.suppressBuiltin(toolName)) {
        return {
          inputSummary: summarizeToolInput(args),
          output: DEEP_WATER_START_FAILURE_DETAIL,
          success: false,
        }
      }
      if (toolName === 'react') {
        input.onReacted?.()
      }
      if (toolName === 'delegate') {
        if (!delegateGate.tryAcquire()) {
          return {
            inputSummary: summarizeToolInput(args),
            output: delegateGate.overLimitMessage(),
            success: false,
          }
        }
        const result = await runDelegate(args, {
          mcpToolset: input.mcpToolset,
          runInference: input.inference.runUtility,
          executeBuiltinTool: (n, a, id) =>
            executeGuardedBuiltin(n, a, toolActorContext, id),
          builtinDescriptors: subAgentBuiltinDescriptors,
          allowedBuiltinIds: subAgentBuiltinIds,
        })
        input.invocationSink.push(...result.invocations)
        return {
          inputSummary: result.inputSummary,
          output: result.output,
          success: result.success,
        }
      }
      if (mcpExposedNames.has(toolName)) {
        return mcpView.dispatch(toolName, args, toolCallId)
      }
      if (input.executorToolset.handledNames.has(toolName)) {
        return input.executorToolset.dispatch(toolName, args, toolCallId)
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
      return executeBuiltinTool(
        toolName,
        args,
        buildBuiltinCtx(toolActorContext, toolCallId),
      )
    },
    initialMessages: input.initialMessages,
    invocationSink: input.invocationSink,
    runInference: (messages) =>
      input.inference.runMain(messages, [...input.toolDefs, ...mcpView.descriptors]),
    toolTimeoutError: input.mcpToolset.timeoutErrorFor,
    tools: mainToolDefs,
  })

  // Main-loop, delegate and compaction invocations were all accumulated into
  // the shared sink, which backs loopResult.invocations — nothing to append.
  return loopResult
}
