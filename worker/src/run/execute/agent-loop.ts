import {
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
import { summarizeToolInput } from '../tool-util.js'
import { executeBuiltinTool } from '../tools.js'
import { authorizeToolExecution } from './tool-authorization.js'
import { buildScopes } from './scopes.js'
import { setAgentStatus } from './lifecycle.js'
import { buildToolActorContext } from './policy.js'
import { publishAgentStatus } from './realtime.js'
import type { RunInference } from './run-inference.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import { recordToolEnd } from './tool-events.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { runReplyIsRestricted } from './agent-message.js'

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
  // The sub-agent inherits the run's resolved builtin set (minus `delegate`)
  // for advertisement; execution still passes the authorization gate below.
  const subAgentBuiltinDescriptors = input.toolDefs.filter(
    (descriptor) => descriptor.toolName !== 'delegate' && input.resolvedToolIds.has(descriptor.toolName),
  )
  // Per-run MCP view: in deferred mode its descriptor array is LIVE
  // (mcp_load_tools / mcp_drop_tools mutate it), so the model's tool list is
  // recomposed from it on every inference call below.
  const mcpView = input.mcpToolset.createView()
  const mcpExposedNames = mcpView.handledNames
  const externalToolNames = new Set([...mcpExposedNames, ...input.executorToolset.handledNames])
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
    documentStream: deps.documentStream,
    executorCommandEncryptionSecret: deps.executorCommandEncryptionSecret,
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

  const executeGuardedBuiltin = (
    toolName: string,
    args: Record<string, unknown>,
    toolActorContext: ReturnType<typeof buildToolActorContext>,
    toolCallId: string,
  ) =>
    executeBuiltinTool(
      toolName,
      args,
      buildBuiltinCtx(toolActorContext, toolCallId),
    )

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
        // Same gate as the streaming path in `run-inference.ts`: the live lane
        // is a thread-wide broadcast and cannot withhold per viewer.
        if (runReplyIsRestricted(context)) {
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
      // Gate before dispatch: every tool name — `delegate` itself, MCP names,
      // executor names and builtins — is authorized (handoff suppression,
      // registry/grant gate, policy/approval) before any dispatcher runs.
      const authorization = await authorizeToolExecution(
        deps.prisma,
        payload.actorContext,
        context,
        toolName,
        args,
        {
          agentKind: context.agent.agentKind,
          allowedToolIds: input.allowedToolIds,
          externalToolNames,
          parentAgentId: context.agent.parentAgentId,
          toolPolicy: input.toolPolicy,
        },
        { deepWaterHandoffGuard: input.deepWaterHandoffGuard },
      )
      if (authorization.decision === 'deny') {
        return authorization.result
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
        // Created here rather than inside runDelegate so the authorization
        // gate can recognize the sub-agent view's exposed MCP names.
        const subAgentMcpView = input.mcpToolset.createView()
        const result = await runDelegate(args, {
          mcpView: subAgentMcpView,
          mcpToolset: input.mcpToolset,
          runInference: input.inference.runUtility,
          authorizeSubAgentTool: (nestedToolName, nestedArgs) =>
            authorizeToolExecution(
              deps.prisma,
              payload.actorContext,
              context,
              nestedToolName,
              nestedArgs,
              {
                agentKind: context.agent.agentKind,
                allowedToolIds: input.allowedToolIds,
                externalToolNames: subAgentMcpView.handledNames,
                parentAgentId: context.agent.parentAgentId,
                toolPolicy: input.toolPolicy,
              },
              {
                deepWaterHandoffGuard: input.deepWaterHandoffGuard,
                // The sub-agent's audit/ToolCall recording is out of scope for
                // this ordering change: nested denials keep the previous
                // silent behaviour while going through the same gate.
                emitAudit: async () => undefined,
              },
            ),
          executeBuiltinTool: (n, a, id, toolActorContext) =>
            executeGuardedBuiltin(n, a, toolActorContext, id),
          builtinDescriptors: subAgentBuiltinDescriptors,
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
      return executeBuiltinTool(
        toolName,
        args,
        buildBuiltinCtx(authorization.toolActorContext, toolCallId),
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
