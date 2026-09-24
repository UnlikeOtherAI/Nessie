import {
  BUILTIN_TOOL_DEFINITIONS,
  type InvocationRecord,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import { parseAgentId, parseRunId, type RunExecuteJobPayload } from '@nessie/schemas'
import { runAgenticLoop, type BudgetLimits, type LoopResult } from '../agentic-loop.js'
import { reviewFollowUp } from '../follow-up-review.js'
import { WIND_DOWN_FRACTION } from '../loop-budget.js'
import type { LoopResumeState } from '../loop-resume.js'
import type { CrashCheckpointWriter } from './crash-checkpoint.js'
import { buildContextPlan } from '../context-window.js'
import { runContextCompaction } from '../context-compaction.js'
import { estimateToolSchemaTokens } from '../context-management.js'
import { runDelegate } from '../delegate.js'
import type { ExecutorToolset } from '../executor-toolset.js'
import { createDelegateGate } from '../run-budget.js'
import type { McpToolset } from '../mcp-toolset.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import { summarizeToolInput } from '../tool-util.js'
import { buildBrowserActApprovalHook } from '../browser-cloud/act-approval-gate.js'
import { effectiveUserIdOfActor } from '../pa-tools/access.js'
import { composeStructuralGates } from './structural-gates.js'
import { buildEmailSendApprovalHook } from './email-send-gate.js'
import { buildMailboxSendApprovalHook } from './mailbox-send-gate.js'
import { authorizeToolExecution, type ToolAuthorizationDecision } from './tool-authorization.js'
import { buildApprovalSuspensionResult, createBuiltinToolExecutor } from './builtin-runtime-context.js'
import { reviewProposedToolAction } from './auto-review.js'
import { buildScopes } from './scopes.js'
import { createExecutorToolExecution } from './executor-tool-execution.js'
import { fileServiceFor } from '../file-service.js'
import { createToolImageInference } from './tool-image-inference.js'
import { setAgentStatus } from './lifecycle.js'
import { publishAgentStatus } from './realtime.js'
import type { RunInference } from './run-inference.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import { recordToolEnd } from './tool-events.js'
import { createToolEffectLedger, externalDispatchPredicate } from './tool-effect-ledger.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { persistCurrentRunBasis, runReplyIsRestricted } from './agent-message.js'
import {
  BUILTIN_TOOL_SPEC_NAME,
  executeBuiltinToolSpec,
} from '../builtin-toolset-deferred.js'

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
    /**
     * Where the loop's working state goes at every safe boundary, so a run
     * whose worker dies is resumed in place. See `crash-checkpoint.ts`.
     */
    crashCheckpoint: CrashCheckpointWriter
    deepWaterHandoffGuard: DeepWaterHandoffGuard
    /** The queue's per-job abort signal; a drain stops the loop through it. */
    drainSignal?: AbortSignal
    /** State from this run's own crash checkpoint, when it is being resumed. */
    resumeState?: LoopResumeState
    executorToolset: ExecutorToolset
    /**
     * D3 identity-tool admission, resolved once at run setup. Empty for every
     * ordinary run; a non-empty set means a DM-homed global agent on its own
     * home DM, on an interactive turn from a live human requester.
     */
    identityToolIds: ReadonlySet<string>
    projectDelegatedToolIds: ReadonlySet<string>
    projectOperatorToolIds: ReadonlySet<string>
    liveRequester: boolean
    initialMessages: ProviderMessage[]
    inference: RunInference
    /** DeepWater turns retain their own recovery matrix and never suspend. */
    isHandoffTurn: boolean
    // Caller-owned accumulator: every main-loop, sub-agent AND compaction
    // invocation is pushed here live, so the run's spend is attributable even if
    // the loop throws before returning (see run-job's failure path).
    invocationSink: InvocationRecord[]
    mcpToolset: McpToolset
    /** Called when the run reacts, so the terminal path knows it already spoke. */
    onReacted?: () => void
    resolvedToolIds: Set<string>
    stubbedBuiltinToolIds: Set<string>
    // Durable thought log + coalesced live thinking events for the main agent.
    // Delegate sub-agents stay silent, exactly as before.
    thinkingRecorder: ThinkingRecorder
    toolDefs: ToolSchemaDescriptor[]
    toolSpecEnabled: boolean
    toolPolicy: Record<string, boolean> | null
    // Wind-down instruction for the main loop, or null to disable (delegate
    // sub-agents and DeepWater handoff turns; non-interactive runs keep the
    // silent checkpoint + auto-continue path instead of a chat handover).
    windDownInstruction: string | null
  },
): Promise<LoopResult> => {
  // Run setup may have admitted memory, checkpoint or transcript material after
  // the initial plan record was created. Make that complete basis durable before
  // this loop can write a thought, a tool record, or any model-derived state.
  await persistCurrentRunBasis(deps.prisma, context)
  // The sub-agent inherits the run's resolved builtin set (minus `delegate`)
  // for advertisement; execution still passes the authorization gate below.
  const subAgentBuiltinDescriptors = input.toolDefs.filter(
    (descriptor) =>
      descriptor.toolName !== 'delegate'
      && (
        input.resolvedToolIds.has(descriptor.toolName)
        || (input.toolSpecEnabled && descriptor.toolName === BUILTIN_TOOL_SPEC_NAME)
      ),
  )
  const allowedBuiltinDefinitions = BUILTIN_TOOL_DEFINITIONS.filter((definition) =>
    input.resolvedToolIds.has(definition.id),
  )
  const subAgentBuiltinDefinitions = allowedBuiltinDefinitions.filter(
    (definition) => definition.id !== 'delegate',
  )
  // Per-run MCP view: in deferred mode its descriptor array is LIVE
  // (mcp_load_tools / mcp_drop_tools mutate it), so the model's tool list is
  // recomposed from it on every inference call below.
  const mcpView = input.mcpToolset.createView()
  const mcpExposedNames = mcpView.handledNames
  const builtinMetaNames = input.toolSpecEnabled ? [BUILTIN_TOOL_SPEC_NAME] : []
  // `tool_spec` is worker-owned schema discovery. It bypasses the builtin
  // registry because it is not a grantable builtin, but it is neither an MCP
  // call nor an executor dispatch and must not be mistaken for an external
  // content sink after the transcript admits private material.
  const unregisteredToolNames = new Set([
    ...mcpExposedNames,
    ...input.executorToolset.handledNames,
    ...builtinMetaNames,
  ])
  const externalContentToolNames = new Set([
    ...mcpExposedNames,
    ...input.executorToolset.handledNames,
  ])
  const mainToolDefs = [...input.toolDefs, ...mcpView.descriptors]

  const delegateGate = createDelegateGate()

  const builtinToolExecutor = createBuiltinToolExecutor({
    context,
    deps,
    payload,
    stubbedBuiltinToolIds: input.stubbedBuiltinToolIds,
  })
  // A coding-session wait watches for the worker's drain between its reads,
  // keeps its one line in the thought process current instead of adding a
  // line per read, and ends where the run's own wallclock enters its
  // wind-down, so the agent still has time to say where the session stands.
  const executeExecutorTool = createExecutorToolExecution(deps, context, input.executorToolset, {
    onProgress: (toolName, line) => input.thinkingRecorder.replaceToolLine(toolName, line),
    runWindDownAt: Date.now() - (input.resumeState?.elapsedMs ?? 0) + input.budget.maxWallclockMs * WIND_DOWN_FRACTION,
    ...(input.drainSignal ? { signal: input.drainSignal } : {}),
  })
  const toolImages = createToolImageInference({
    files: fileServiceFor(deps.prisma),
    organizationId: context.channel.organizationId,
    prisma: deps.prisma,
    runId: context.run.id,
  })

  const contextPlan = buildContextPlan({
    model: context.agent.model,
    toolSchemaTokens: estimateToolSchemaTokens(mainToolDefs),
  })

  const authorizeMainTool = (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    options: {
      consumeApprovalProof?: boolean
      maySuspendForApproval?: boolean
      skipAutoReview?: boolean
    } = {},
  ) =>
    authorizeToolExecution(
      deps.prisma,
      payload.actorContext,
      context,
      toolName,
      args,
      toolCallId,
      {
        agentKind: context.agent.agentKind,
        allowedToolIds: input.allowedToolIds,
        consumeApprovalProof: options.consumeApprovalProof,
        identityToolIds: input.identityToolIds,
        projectDelegatedToolIds: input.projectDelegatedToolIds,
        projectOperatorToolIds: input.projectOperatorToolIds,
        liveRequester: input.liveRequester,
        executorToolNames: input.executorToolset.handledNames,
        mcpToolNames: mcpExposedNames,
        skipAutoReview: options.skipAutoReview,
        resolvedBuiltinToolIds: input.resolvedToolIds,
        unregisteredToolNames,
        externalContentToolNames,
        // One hook per family, tried in order: each returns null for tools it
        // does not own, so adding a family costs one comparison rather than a
        // second gate the next family could forget to consult.
        structuralGate: composeStructuralGates([
          buildEmailSendApprovalHook(deps.prisma, context, payload.interactive === true),
          buildBrowserActApprovalHook(deps.prisma, context),
          buildMailboxSendApprovalHook(
            deps.prisma,
            context,
            effectiveUserIdOfActor(payload.actorContext),
          ),
        ]),
        maySuspendForApproval: options.maySuspendForApproval ?? !input.isHandoffTurn,
        // The send-boundary judge. Inference the run paid for, so its
        // invocations count in the run's totals like compaction's do.
        runUtility: async (prompt: string) => {
          const result = await input.inference.runUtility(
            [{ content: prompt, role: 'user' }],
            [],
          )
          input.invocationSink.push(...result.invocations)
          return result.outputText
        },
        parentAgentId: context.agent.parentAgentId,
        resumeState: {
          actorContext: payload.actorContext,
          interactive: payload.interactive === true,
          messageId: payload.messageId,
        },
        toolPolicy: input.toolPolicy,
      },
      {
        deepWaterHandoffGuard: input.deepWaterHandoffGuard,
        reviewProposedAction: async (reviewInput) => {
          const reviewed = await reviewProposedToolAction(input.inference.runUtility, reviewInput)
          input.invocationSink.push(...reviewed.invocations)
          return reviewed
        },
      },
    )

  const executeAuthorizedTool = async (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    authorization: Extract<ToolAuthorizationDecision, { decision: 'allow' }>,
  ) => {
    if (toolName === BUILTIN_TOOL_SPEC_NAME) {
      return executeBuiltinToolSpec(args, allowedBuiltinDefinitions)
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
            'sub-agent',
            {
              agentKind: context.agent.agentKind,
              allowedToolIds: input.allowedToolIds,
              // `identityToolIds` is deliberately NOT passed to a sub-agent: a
              // delegated turn is not the person's interactive turn, and the
              // identity tools are the person's own authority. (The one global
              // agent that has them denies `delegate` outright, so this arm is
              // unreachable today — it stays correct if that ever changes.)
              // Nor are the project-operator verbs, for the same reason.
              resolvedBuiltinToolIds: input.resolvedToolIds,
              unregisteredToolNames: new Set([
                ...subAgentMcpView.handledNames,
                ...builtinMetaNames,
              ]),
              externalContentToolNames: new Set(subAgentMcpView.handledNames),
              maySuspendForApproval: false,
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
        executeBuiltinTool: (
          n,
          a,
          id,
          toolActorContext,
          gmailDraftSendApproved,
          gmailDraftSendStandingAuthorized,
        ) =>
          n === BUILTIN_TOOL_SPEC_NAME
            ? Promise.resolve(executeBuiltinToolSpec(a, subAgentBuiltinDefinitions))
            : builtinToolExecutor.execute(
              n,
              a,
              toolActorContext,
              id,
              { gmailDraftSendApproved, gmailDraftSendStandingAuthorized },
            ),
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
      return executeExecutorTool(toolName, args, toolCallId, authorization.toolActorContext)
    }
    return builtinToolExecutor.executeAuthorized(toolName, args, toolCallId, authorization)
  }
  // Meta's tool protocol is namespaced and its models call `default.<tool>` for
  // a tool offered as `<tool>`; OpenAI's legacy shape did the same with
  // `functions.`. A prefix is dropped only when the remainder names a tool this
  // run actually offers, so a genuinely unknown name still fails as unknown.
  const isOfferedToolName = (name: string): boolean =>
    name === BUILTIN_TOOL_SPEC_NAME
    || name === 'react'
    || name === 'delegate'
    || input.resolvedToolIds.has(name)
    || mcpExposedNames.has(name)
    || input.executorToolset.handledNames.has(name)
  const normalizeToolName = (name: string): string => {
    if (isOfferedToolName(name)) return name
    const separator = name.indexOf('.')
    if (separator <= 0) return name
    const bare = name.slice(separator + 1)
    return isOfferedToolName(bare) ? bare : name
  }
  const executeMainTool = async (requestedToolName: string, args: Record<string, unknown>, toolCallId: string) => {
    const toolName = normalizeToolName(requestedToolName)
    const authorization = await authorizeMainTool(toolName, args, toolCallId)
    if (authorization.decision === 'deny') {
      return authorization.result
    }
    if (authorization.decision === 'suspend') {
      return buildApprovalSuspensionResult(args, authorization)
    }
    return executeAuthorizedTool(toolName, authorization.executionArgs ?? args, toolCallId, authorization)
  }

  const executePreparedTool = async (requestedToolName: string, args: Record<string, unknown>, toolCallId: string) => {
    const toolName = normalizeToolName(requestedToolName)
    // A preflight verified any proof without consuming it. Re-run the gate at
    // dispatch to claim the one-time proof only when this tool will run.
    const authorization = await authorizeMainTool(toolName, args, toolCallId, {
      maySuspendForApproval: false,
      skipAutoReview: true,
    })
    if (authorization.decision === 'deny') {
      return authorization.result
    }
    if (authorization.decision === 'suspend') {
      throw new Error('Prepared tool authorization unexpectedly requested approval.')
    }
    return executeAuthorizedTool(toolName, authorization.executionArgs ?? args, toolCallId, authorization)
  }

  // Every main-loop call is prepared before it runs, so this resolves the name as
  // dispatch does; asked with a raw `default.<tool>` the gate denies it as unknown.
  const prepareMainTool = async (requestedToolName: string, args: Record<string, unknown>, toolCallId: string) => {
    const toolName = normalizeToolName(requestedToolName)
    const authorization = await authorizeMainTool(toolName, args, toolCallId, {
      consumeApprovalProof: false,
    })
    if (authorization.decision === 'suspend') {
      return {
        approval: {
          approvalId: authorization.approval.id,
          notice: authorization.approval.notice,
          toolName: authorization.approval.toolName,
        },
        kind: 'suspend' as const,
      }
    }
    return {
      execute: async () =>
        authorization.decision === 'deny'
          ? authorization.result
          : executePreparedTool(toolName, args, toolCallId),
      kind: 'execute' as const,
    }
  }

  // Durable tool idempotency (invariant 4 / plan 3.2): a side-effecting call is
  // claimed in Postgres before it runs. Wrapped BELOW the loop's own recorder,
  // which stays the fast path — the precedence, and why every external dispatch
  // is claimed, are in `tool-effect-ledger.ts`.
  //
  // The predicate is built over the SAME two live objects `executeAuthorizedTool`
  // routes on, and asked per call rather than snapshotted here: `mcpView` is
  // mutable by the run itself (`mcp_load_tools` / `mcp_drop_tools`), so a copy
  // taken at setup is a second source of truth that could send a call to a
  // connector with no claim behind it. `builtinMetaNames` is left out on
  // purpose: the tool-spec meta tool only rewrites this run's own view of its
  // tool list, so a durable row per call would buy nothing. The claim is
  // decided on the name dispatch resolves, so `default.<tool>` is claimed too.
  const effects = createToolEffectLedger(deps.prisma, {
    isExternalDispatch: externalDispatchPredicate({
      executorToolset: input.executorToolset,
      mcpView,
    }),
    normalizeToolName,
    runId: context.run.id,
  }, { executeTool: executeMainTool, prepareTool: prepareMainTool })

  const loopResult = await runAgenticLoop({
    reviewCompletion: (messages, outputText) =>
      reviewFollowUp(input.inference.runUtility, messages, outputText, input.invocationSink),
    budget: input.budget,
    cacheReadWeight: input.cacheReadWeight,
    ...(input.drainSignal ? { drainSignal: input.drainSignal } : {}),
    ...(input.resumeState ? { resume: input.resumeState } : {}),
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
      onToolCallStart: async (toolName, _args, providerCallId) => {
        const startedAt = new Date()
        // Tool activity is part of the thought process, not a separate feed.
        // The line goes under the offered name, the one a watching call
        // rewrites it by, whatever prefix the provider put on the call, and
        // is keyed by the provider's call id, the one its ToolCall links by.
        await input.thinkingRecorder.appendToolLine(
          normalizeToolName(toolName),
          summarizeToolInput(_args),
          providerCallId,
        )
        await setAgentStatus(deps.prisma, context.agent.id, 'executing')
        await publishAgentStatus(deps.realtimeTransport, context, {
          currentRunId: context.run.id,
          currentToolName: toolName,
          currentToolStartedAt: startedAt.toISOString(),
          status: 'executing',
        })
        // Tool arguments are model-visible content. A restricted run can carry
        // private reply bytes into a later `send_message` or other tool call,
        // so channel-wide WebSocket subscribers receive the same content-free
        // marker as they do for a restricted message rather than its summary.
        const restricted = runReplyIsRestricted(context)
        await deps.realtimeTransport.publishWs(buildScopes(context), {
          data: restricted
            ? {
                agentId: parseAgentId(context.agent.id),
                restricted: true as const,
                runId: parseRunId(context.run.id),
              }
            : {
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
        argumentsValue,
        result,
        durationMs,
        success,
        inputSummary,
        startedAt,
        connectorUsage,
        toolCallRecordId,
        providerCallId,
      ) => {
        // A read tool may have just added source provenance to the live sink.
        // Tool summaries and previews are durable, so record that provenance
        // before making either one observable through the activity APIs.
        await persistCurrentRunBasis(deps.prisma, context)
        const recordedId = await recordToolEnd(deps, context, payload.actorContext, {
          argumentsValue,
          durationMs,
          inputSummary,
          outputPreview: result.slice(0, 1200),
          startedAt,
          success,
          toolName,
          connectorUsage,
          toolCallRecordId,
        })
        // The thought log's line for this call names its ToolCall, which is
        // how the thought-process dialog finds the call's screenshots.
        await input.thinkingRecorder.linkToolCall(providerCallId, recordedId)
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
      // The writer says whether the state actually became durable; the loop has
      // nothing to do with the answer beyond not proceeding as if it had (the
      // per-iteration fence probe below is what stops a fenced-out execution),
      // and the writer has already said so in the log.
      onCheckpoint: async (state) => {
        await persistCurrentRunBasis(deps.prisma, context)
        await input.crashCheckpoint.write(state)
      },
    },
    executeTool: effects.executeTool,
    initialMessages: input.initialMessages,
    invocationSink: input.invocationSink,
    ...(effects.prepareTool ? { prepareTool: effects.prepareTool } : {}),
    // The run's tool images are read in only here, per call, from references.
    runInference: (messages, _captured, options) => toolImages.infer((prepareMessages) =>
      input.inference.runMain(
        messages,
        options?.noTools ? [] : [...input.toolDefs, ...mcpView.descriptors],
        { prepareMessages },
      )),
    // Executor tools go in call order, on their command TTL plus a margin, and
    // a timeout is the TTL's own fatal unknown outcome, never a retriable one.
    dispatchesInOrder: (name) => input.executorToolset.handledNames.has(normalizeToolName(name)),
    // Breaker and loop counts go under the offered name, so `default.executor_mcp_call`
    // is keyed by its program and tool like the bare name is.
    normalizeToolName,
    toolTimeoutError: (name, toolCallId) => input.executorToolset.timeoutErrorFor(normalizeToolName(name), toolCallId)
      ?? input.mcpToolset.timeoutErrorFor(normalizeToolName(name)),
    toolTimeoutMsFor: (name) => input.executorToolset.timeoutMsFor(normalizeToolName(name)),
    tools: mainToolDefs,
  })

  // Main-loop, delegate and compaction invocations were all accumulated into
  // the shared sink, which backs loopResult.invocations — nothing to append.
  return loopResult
}
