import {
  failDeepWaterHandoffStart,
  findDeepWaterHandoffRun,
  markDeepWaterHandoffRecoveryNeeded,
  type DeepWaterHandoffRunLocator,
  type InvocationRecord,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseRunId,
  parseThreadId,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import {
  createDeepWaterHandoffGuard,
  type DeepWaterHandoffGuard,
  DeepWaterHandoffInvariantError,
} from '../deepwater-handoff-guard.js'
import { resolveDeepWaterHandoffMarker } from '../deepwater-handoff-metadata.js'
import { ensureRunPlanContext, markRunPlanStarted } from '../plans.js'
import type { QueueAttempt } from '../tool-execution-errors.js'
import type { LoopResult } from '../agentic-loop.js'
import { resolveCacheReadWeight, resolveEffectiveRunBudget } from '../run-budget.js'
import { runExecutionAgentLoop } from './agent-loop.js'
import {
  persistRunSubscriptionBinding,
  resolveRunSubscriptionBinding,
  subscriptionUnavailableNotice,
} from './subscription-binding.js'
import {
  applyBudgetGate,
  createBudgetBlockedProbe,
  terminalizeBudgetBlockedRun,
} from './budget-gate.js'
import { recordRunTimingEvent, summarizeRunTiming } from './run-timing.js'
import { isInteractiveRun } from './continuation.js'
import { createRunInference } from './run-inference.js'
import { prepareRunExecution } from './run-setup.js'
import { WIND_DOWN_INSTRUCTION } from './run-stop.js'
import { resolveUtilityModel } from './utility-model.js'
import { markWorking } from './working-marker.js'
import { runExternalConversation } from '../external-conversation.js'
import {
  claimRunForExecution,
  loadRunContext,
  setAgentStatus,
  updateTaskStatus,
  updateRunStatus,
} from './lifecycle.js'
import { validateRunActorContext } from './policy.js'
import { publishAgentStatus, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import {
  persistResolvedReplyAnchor,
  resolveConversationRootMessageId,
  resolveReplyRootMessageId,
} from './reply-placement.js'
import { buildScopes } from './scopes.js'
import { createThinkingRecorder, type ThinkingRecorder } from './thinking-recorder.js'
import { createDocumentStreamRecorder } from './document-stream.js'
import { handleRunFailurePath } from './run-failure-path.js'
import { handleRunLoopOutcome } from './run-outcome.js'
import { fileServiceFor } from '../file-service.js'
import { readMarkdownDocument } from '../pa-tools/knowledge-document-io.js'
import type { ExecutionDependencies, RunPlanContext } from './types.js'
import { persistRunBasis, runReplyBasis, runReplyIsRestricted } from './agent-message.js'
import { assertGlobalAgentRunPlacement } from './global-agent-placement.js'
import { assertPrivateAgentRunPlacement } from './private-agent-placement.js'
import {
  AgentTodoScheduledConfigError,
  buildScheduledAgentTodoKickoff,
  claimAgentTodoForRun,
  materializeScheduledAgentTodosForRun,
  readAgentTodoKickoff,
  readAgentTodoScheduledKickoff,
} from '@nessie/workspace-admin'
import { recordTriggerHealthFailure } from '../../control/trigger-health.js'
import {
  assertPersonalAssistantPresenceRunPlacement,
  PersonalAssistantPresencePlacementError,
} from './personal-assistant-presence-placement.js'
export const executeRunJob = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  queueAttempt: QueueAttempt,
): Promise<void> => {
  // Idempotency guard: skip if this run already reached a terminal state.
  //
  // We deliberately do NOT skip `running` runs: the queue renews each job's
  // lock while its handler is in flight (see PgQueueProvider.withLockRenewal),
  // so a live worker's run is never re-claimed concurrently. A run that is
  // still `running` when re-claimed therefore means the previous worker
  // crashed, and re-execution is the intended recovery path.
  const existingRun = await deps.prisma.run.findUnique({
    where: { id: payload.runId },
    select: { status: true, finishedAt: true },
  })
  if (
    existingRun
    && (existingRun.status === 'completed'
      || existingRun.status === 'failed'
      || existingRun.status === 'cancelled')
  ) {
    console.log(`[worker] Skipping already-${existingRun.status} run ${payload.runId}`)
    return
  }
  const context = await loadRunContext(deps.prisma, payload)
  if (!context) {
    return
  }
  // A queued PA presence run must not act after its owner leaves the room or
  // is deactivated. This is deliberately a quiet cancellation, not the normal
  // failure path: posting a failure would itself be an unauthorized PA action.
  try {
    await assertPersonalAssistantPresenceRunPlacement(deps.prisma, context)
  } catch (error) {
    if (!(error instanceof PersonalAssistantPresencePlacementError)) throw error
    await updateRunStatus(
      deps.prisma,
      context.run.id,
      'cancelled',
      deps.realtimeTransport,
    )
    await updateTaskStatus(deps.prisma, context.task.id, 'cancelled')
    await publishRunUpdated(deps.realtimeTransport, context, 'cancelled')
    await publishTaskUpdated(
      deps.realtimeTransport,
      buildScopes(context),
      context.task.id,
      'cancelled',
    )
    return
  }

  const message = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { content: true, metadata: true, rootMessageId: true },
  })
  if (!message) {
    return
  }

  let prompt = payload.promptOverride?.trim() || message.content
  const handoffMarker = resolveDeepWaterHandoffMarker(message.metadata)
  let streamStarted = false
  let planContext: RunPlanContext | null = null
  let deepWaterHandoffGuard: DeepWaterHandoffGuard | null = null
  // Per-run stage-timing capture (see run-timing.ts). `claimedAt` is the
  // claim→terminal baseline and gates emission: it stays null on any path that
  // returns before claiming (budget-gate block, lost claim), so those non-runs
  // emit nothing. `terminalOutcome` is set only where the run actually reaches a
  // terminal state, so a retry-throw (run left `running`) also emits nothing.
  let claimedAt: Date | null = null
  let loopResult: LoopResult | null = null
  let terminalOutcome: 'completed' | 'failed' | 'cancelled' | null = null
  // Caller-owned invocation accumulator. The agent loop pushes every inference
  // invocation here live, so a run that throws mid-loop (crash/abort) still
  // carries its partial token spend — the failure path persists it so failed
  // spend stays attributable in the local ledger (buzz #1659).
  const invocations: InvocationRecord[] = []
  const handoffTeamId =
    payload.actorContext.tenant.teamId ?? payload.actorContext.actionContext.teamId ?? null
  let handoffLocator: DeepWaterHandoffRunLocator | null = null
  if (handoffMarker.kind === 'found' && handoffTeamId) {
    handoffLocator = {
      messageId: payload.messageId,
      organizationId: context.channel.organizationId,
      runId: handoffMarker.runId,
      teamId: handoffTeamId,
      threadId: context.run.threadId,
    }
  }

  context.replyRootMessageId = resolveReplyRootMessageId(
    { id: payload.messageId, rootMessageId: message.rootMessageId },
    handoffLocator,
    context.run.replyPlacement,
  )
  context.conversationRootMessageId = resolveConversationRootMessageId({
    rootMessageId: message.rootMessageId,
  })
  await persistResolvedReplyAnchor(deps.prisma, context.run.id, context.replyRootMessageId)

  // Durable thought log + coalesced live thinking events. Created before the
  // loop so every reasoning delta and tool line is captured; closed in the
  // `finally` below so a crash, cancel, or budget stop still flushes it.
  const thinkingRecorder: ThinkingRecorder = createThinkingRecorder({
    isRestricted: () => runReplyIsRestricted(context),
    prisma: deps.prisma,
    realtimeTransport: deps.realtimeTransport,
    runId: context.run.id,
    threadId: context.run.threadId,
  })

  // Live document composition, created alongside the thought log for the same
  // reason: it must exist before the first provider chunk, and every exit path
  // has to settle it.
  const documentStream = createDocumentStreamRecorder({
    getRestrictionBasis: () => runReplyBasis(context),
    isRestricted: () => runReplyIsRestricted(context),
    loadDocument: async (pageId) => readMarkdownDocument(
      deps.prisma,
      fileServiceFor(deps.prisma),
      String(context.channel.organizationId),
      pageId,
      context,
    ),
    prisma: deps.prisma,
    persistRestrictionBasis: (basis) => persistRunBasis(deps.prisma, {
      basis,
      organizationId: String(context.channel.organizationId),
      runId: context.run.id,
    }),
    realtimeTransport: deps.realtimeTransport,
    run: {
      agentId: context.agent.id,
      id: context.run.id,
      organizationId: String(context.channel.organizationId),
      threadId: context.run.threadId,
    },
  })
  const executionDeps = { ...deps, documentStream }

  try {
    assertPrivateAgentRunPlacement(context)
    assertGlobalAgentRunPlacement(context)
    // External-agent turns bypass the inference loop entirely: the driver
    // proxies the message to the external product. Placement is still checked
    // first so a malformed private binding cannot reach any provider.
    if (
      context.agent.executionMode === 'external_mcp'
      && handoffMarker.kind === 'none'
    ) {
      await runExternalConversation(deps, payload, context, prompt)
      return
    }
    if (
      handoffMarker.kind === 'invalid'
      || (handoffMarker.kind === 'found' && !handoffLocator)
    ) {
      throw new DeepWaterHandoffInvariantError(
        handoffMarker.kind === 'found' ? handoffMarker.runId : null,
      )
    }
    deepWaterHandoffGuard = await createDeepWaterHandoffGuard({
      locator: handoffLocator,
      prisma: deps.prisma,
    })
    if (context.agent.executionMode === 'external_mcp') {
      throw new DeepWaterHandoffInvariantError(handoffLocator?.runId ?? null)
    }
    await validateRunActorContext(deps.prisma, payload.actorContext, context)

    // Which purse this run spends, decided once and pinned. Resolved BEFORE
    // the budget gate because the gate's verdict depends on the answer: an
    // organization cost or token cap exists to protect the organization's
    // spend, and must not block a run the organization is not paying for.
    const subscriptionLane = await resolveRunSubscriptionBinding(deps, context)
    if (subscriptionLane.kind === 'unavailable') {
      // Never a quiet fallback to Ledger: that would move a person's spend onto
      // the organization without anyone agreeing to it. Fail with the remedy.
      await terminalizeBudgetBlockedRun(
        deps,
        payload,
        context,
        subscriptionUnavailableNotice({
          isOwnerViewing:
            context.agent.ownerUserId !== null
            && context.agent.ownerUserId === payload.actorContext.actionContext.effectiveUserId,
          reason: subscriptionLane.reason,
        }),
        {},
      )
      return
    }
    const subscriptionBinding =
      subscriptionLane.kind === 'subscription' ? subscriptionLane.binding : null
    if (subscriptionBinding) {
      await persistRunSubscriptionBinding(deps, {
        binding: subscriptionBinding,
        runId: context.run.id,
      })
    }

    const budgetGate = await applyBudgetGate(deps, context, payload, {
      subscriptionPinned: subscriptionBinding !== null,
      ...(handoffLocator
        ? {
            beforeBlockedRunTerminalization: async () => {
              const failed = await failDeepWaterHandoffStart(deps.prisma, {
                ...handoffLocator,
                runId: handoffLocator.runId,
              })
              if (failed) return
              const lookup = await findDeepWaterHandoffRun(
                deps.prisma,
                handoffLocator,
              )
              if (lookup.kind === 'found' && lookup.run.status === 'failed') return
              throw new DeepWaterHandoffInvariantError(handoffLocator.runId)
            },
          }
        : {}),
    })
    if (budgetGate.blocked) {
      return
    }

    const claimed = await claimRunForExecution(deps.prisma, context.run.id)
    if (!claimed) {
      if (handoffLocator) {
        await markDeepWaterHandoffRecoveryNeeded(deps.prisma, {
          ...handoffLocator,
          runId: handoffLocator.runId,
        })
      }
      console.log(`[worker] run ${context.run.id} already claimed or terminal; skipping`)
      return
    }
    claimedAt = new Date()
    const todoKickoff = readAgentTodoKickoff(message.metadata)
    if (todoKickoff) {
      // The Run-now route only identifies the instance while it is pending.
      // Claiming happens here, inside the executing run, so a queued cancel
      // cannot strand a checklist under a run that never started.
      await claimAgentTodoForRun(deps.prisma, {
        agentId: context.agent.id,
        organizationId: context.channel.organizationId,
        runId: context.run.id,
        threadId: context.run.threadId,
        todoId: todoKickoff.todoId,
      })
    }
    const scheduledTodoKickoff = readAgentTodoScheduledKickoff(message.metadata)
    if (scheduledTodoKickoff) {
      try {
        const todos = await materializeScheduledAgentTodosForRun(deps.prisma, {
          agentId: context.agent.id,
          organizationId: context.channel.organizationId,
          runId: context.run.id,
          threadId: context.run.threadId,
          templateRefs: scheduledTodoKickoff.todoTemplates,
        })
        const historic = await deps.prisma.agentTodo.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { createdAt: true, id: true, title: true },
          where: {
            agentId: context.agent.id,
            id: { notIn: todos.map((todo) => todo.id) },
            organizationId: context.channel.organizationId,
            status: { in: ['open', 'running'] },
            templateId: { in: scheduledTodoKickoff.todoTemplateIds },
          },
        })
        prompt = buildScheduledAgentTodoKickoff(
          todos,
          historic.map((todo) => ({
            age: `${Math.floor((Date.now() - todo.createdAt.getTime()) / 86_400_000)}d`,
            id: todo.id,
            title: todo.title,
          })),
        )
        await deps.prisma.message.update({
          where: { id: payload.messageId },
          data: { content: prompt },
        })
      } catch (error) {
        if (error instanceof AgentTodoScheduledConfigError) {
          await recordTriggerHealthFailure(deps.prisma, {
            error,
            triggerId: error.triggerId,
          })
        }
        throw error
      }
    }
    planContext = await ensureRunPlanContext(deps.prisma, {
      agentId: context.agent.id,
      channelId: context.channel.id,
      createdByActorId: payload.actorContext.actor.actorId,
      createdByActorType: payload.actorContext.actor.actorType,
      goal: prompt,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })
    // Show on the message itself that this run picked it up. Cleared by the
    // terminal status transition in `lifecycle.ts`, so no path here has to
    // remember to take it back off.
    await markWorking(deps.prisma, deps.realtimeTransport, {
      agentId: context.agent.id,
      messageId: payload.messageId,
      ...(context.run.principalUserId
        ? { onBehalfOfUserId: context.run.principalUserId }
        : {}),
      threadId: context.run.threadId,
    })
    await updateTaskStatus(deps.prisma, context.task.id, 'in_progress')
    await markRunPlanStarted(deps.prisma, planContext)
    await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
    await publishRunUpdated(deps.realtimeTransport, context, 'running')
    await publishTaskUpdated(
      deps.realtimeTransport,
      buildScopes(context),
      context.task.id,
      'in_progress',
    )
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'thinking',
    })

    const setup = await prepareRunExecution(deps, payload, context, {
      deepWaterHandoffGuard,
      isHandoffTurn: handoffLocator !== null,
      prompt,
    })

    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.start', {
      agentId: parseAgentId(context.agent.id),
      // Where this run's reply will land, so viewers can anchor the live
      // thinking surface to the right surface from the first token.
      rootMessageId: context.replyRootMessageId ?? null,
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })
    streamStarted = true

    // Utility model resolution is telemetry-grade: if it cannot be confirmed on
    // the run's own provider route, the run's own model is used.
    // A subscription run has no utility model. `NESSIE_UTILITY_MODEL` names a
    // model from the Ledger catalogue, which a subscription backend may simply
    // not serve — resolving it would fail every compaction and note call. This
    // returns null explicitly rather than relying on the org lookup missing.
    const utilityModel = subscriptionBinding
      ? null
      : await resolveUtilityModel(deps.prisma, {
        organizationId: context.channel.organizationId,
        providerKey: budgetGate.modelOverride?.provider ?? context.agent.provider,
      }).catch(() => null)

    const inference = createRunInference(executionDeps, payload, context, {
      budgetModelOverride: budgetGate.modelOverride,
      subscription: subscriptionBinding,
      thinkingRecorder,
      utilityModel,
    })

    let reacted = false
    loopResult = await runExecutionAgentLoop(executionDeps, payload, context, {
      allowedToolIds: setup.allowedToolIds,
      onReacted: () => {
        reacted = true
      },
      budget: resolveEffectiveRunBudget(context.agent.runLimits),
      // Resolved once per run against the model this run will actually use
      // (the budget gate's degrade override wins over the agent's own).
      cacheReadWeight: await resolveCacheReadWeight(deps.prisma, {
        model: budgetGate.modelOverride?.model ?? context.agent.model,
        organizationId: context.channel.organizationId,
        provider: budgetGate.modelOverride?.provider ?? context.agent.provider,
      }),
      checkBudgetBlocked: createBudgetBlockedProbe(deps, context, payload, {
        subscriptionPinned: subscriptionBinding !== null,
      }),
      identityToolIds: setup.identityToolIds,
      inference,
      isHandoffTurn: handoffLocator !== null,
      initialMessages: setup.initialMessages,
      executorToolset: setup.executorToolset,
      invocationSink: invocations,
      deepWaterHandoffGuard,
      mcpToolset: setup.mcpToolset,
      resolvedToolIds: setup.resolvedToolIds,
      stubbedBuiltinToolIds: setup.stubbedBuiltinToolIds,
      thinkingRecorder,
      toolDefs: setup.toolDefs,
      toolSpecEnabled: setup.toolSpecEnabled,
      toolPolicy: setup.toolPolicy,
      // Wind-down (spec §3a): interactive, non-handoff runs get told to finish
      // inside the reserve instead of being cut off. Scheduled/trigger runs
      // keep the silent checkpoint + auto-continue path, and handoff turns keep
      // their server-authored prompt byte-identical.
      windDownInstruction:
        isInteractiveRun(payload) && !handoffLocator ? WIND_DOWN_INSTRUCTION : null,
    })
    // The stream contract is `stream.done` LAST: flush the recorder before any
    // terminal path publishes it, or a trailing `stream.reasoning` would arrive
    // after the stream terminator (clients treat the run as live again).
    await thinkingRecorder.close()
    await documentStream.close()
    deepWaterHandoffGuard.assertCompletion()

    terminalOutcome = await handleRunLoopOutcome(deps, payload, context, {
      documentStream,
      handoffLocator,
      inference,
      invocations,
      loopResult,
      planContext,
      prompt,
      reacted,
      setup,
      streamStarted,
    })
  } catch (caughtError) {
    await handleRunFailurePath(deps, payload, context, {
      caughtError,
      deepWaterHandoffGuard,
      documentStream,
      handoffLocator,
      invocations,
      planContext,
      queueAttempt,
      streamStarted,
      thinkingRecorder,
    })
  } finally {
    // Flush whatever thought process is still buffered, on every exit path
    // (completion, classified stop, crash, retry-throw). Idempotent and
    // error-swallowing by construction, so it can never mask a run outcome.
    await thinkingRecorder.close()
    await documentStream.close()

    // Record the run's stage-timing breakdown at every terminal state
    // (completion and failure), reusing timestamps the run already produced.
    // Skipped when the run never reached terminal in this execution: a
    // pre-claim early return (`claimedAt` null) or a retry-throw that leaves
    // the run `running` (`terminalOutcome` null). Best-effort: a timing write
    // must never turn a finished run into a failed one.
    if (claimedAt && terminalOutcome) {
      try {
        await recordRunTimingEvent(deps.prisma, {
          outcome: terminalOutcome,
          runId: context.run.id,
          summary: summarizeRunTiming({
            claimedAt,
            enqueuedAt: context.run.createdAt,
            finishedAt: new Date(),
            invocations: loopResult?.invocations ?? [],
            toolCount: loopResult?.toolCallsUsed ?? 0,
            toolMs: loopResult?.toolMs ?? 0,
          }),
          taskId: context.task.id,
        })
      } catch (timingError) {
        console.error(
          '[worker] failed to record run.timing event for run',
          context.run.id,
          timingError,
        )
      }
    }
  }
}
