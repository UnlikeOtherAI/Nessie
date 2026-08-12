import {
  failDeepWaterHandoffStart,
  findDeepWaterHandoffRun,
  markAmbiguousDeepWaterHandoffRecoveryNeeded,
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
  DeepWaterHandoffFatalError,
  type DeepWaterHandoffGuard,
  DeepWaterHandoffInvariantError,
} from '../deepwater-handoff-guard.js'
import { promoteUnresolvedDeepWaterHandoffError } from '../deepwater-handoff-failure.js'
import { resolveDeepWaterHandoffMarker } from '../deepwater-handoff-metadata.js'
import { ensureRunPlanContext, markRunPlanStarted } from '../plans.js'
import {
  isFinalQueueAttempt,
  shouldRetryRunWithoutTerminalizing,
  type QueueAttempt,
} from '../tool-execution-errors.js'
import type { LoopResult } from '../agentic-loop.js'
import { resolveCacheReadWeight, resolveEffectiveRunBudget } from '../run-budget.js'
import { runExecutionAgentLoop } from './agent-loop.js'
import { applyBudgetGate, createBudgetBlockedProbe } from './budget-gate.js'
import { recordRunTimingEvent, summarizeRunTiming } from './run-timing.js'
import { classifyBudgetStop } from './budget-stop.js'
import { isInteractiveRun } from './continuation.js'
import { createRunInference } from './run-inference.js'
import { prepareRunExecution } from './run-setup.js'
import {
  applyRunStopContinuation,
  prepareRunStop,
  prepareWindDownHandover,
  WIND_DOWN_INSTRUCTION,
} from './run-stop.js'
import { resolveUtilityModel } from './utility-model.js'
import { isContentlessAfterReacting, markWorking } from './working-marker.js'
import { resolveRollingWatch } from './watch-status-gate.js'
import { handleCancelStop } from './cancel-stop.js'
import { completeRunExecution } from './completion.js'
import { runExternalConversation } from '../external-conversation.js'
import { persistInvocationLedgerEvents } from '../inference.js'
import { handleRunExecutionFailure } from './failure.js'
import {
  claimRunForExecution,
  loadRunContext,
  setAgentStatus,
  updateTaskStatus,
} from './lifecycle.js'
import { stripLeadingSectionTag } from './memory.js'
import { validateRunActorContext } from './policy.js'
import { publishAgentStatus, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import {
  persistResolvedReplyAnchor,
  resolveConversationRootMessageId,
  resolveReplyRootMessageId,
} from './reply-placement.js'
import { buildScopes } from './scopes.js'
import { createThinkingRecorder, type ThinkingRecorder } from './thinking-recorder.js'
import type { ExecutionDependencies, RunPlanContext } from './types.js'

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

  const message = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { content: true, metadata: true, rootMessageId: true },
  })

  if (!message) {
    return
  }

  const prompt = payload.promptOverride?.trim() || message.content
  const handoffMarker = resolveDeepWaterHandoffMarker(message.metadata)

  // External-agent turns bypass the inference loop entirely: the driver proxies
  // the message to the external product over MCP and owns its own run
  // lifecycle. Nessie runs no inference for these runs (plan §5).
  if (
    context.agent.executionMode === 'external_mcp'
    && handoffMarker.kind === 'none'
  ) {
    await runExternalConversation(deps, payload, context, prompt)
    return
  }

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
    prisma: deps.prisma,
    realtimeTransport: deps.realtimeTransport,
    runId: context.run.id,
    threadId: context.run.threadId,
  })

  try {
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

    const budgetGate = await applyBudgetGate(deps, context, payload, {
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

    planContext = await ensureRunPlanContext(deps.prisma, {
      agentId: context.agent.id,
      channelId: context.channel.id,
      createdByActorId: payload.actorContext.actor.actorId,
      createdByActorType: payload.actorContext.actor.actorType,
      goal: prompt,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })

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
    // Show on the message itself that this run picked it up. Cleared by the
    // terminal status transition in `lifecycle.ts`, so no path here has to
    // remember to take it back off.
    await markWorking(deps.prisma, deps.realtimeTransport, {
      agentId: context.agent.id,
      messageId: payload.messageId,
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
    const utilityModel = await resolveUtilityModel(deps.prisma, {
      organizationId: context.channel.organizationId,
      providerKey: budgetGate.modelOverride?.provider ?? context.agent.provider,
    }).catch(() => null)

    const inference = createRunInference(deps, payload, context, {
      budgetModelOverride: budgetGate.modelOverride,
      thinkingRecorder,
      utilityModel,
    })

    let reacted = false
    loopResult = await runExecutionAgentLoop(deps, payload, context, {
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
      checkBudgetBlocked: createBudgetBlockedProbe(deps, context, payload),
      inference,
      initialMessages: setup.initialMessages,
      executorToolset: setup.executorToolset,
      invocationSink: invocations,
      deepWaterHandoffGuard,
      mcpToolset: setup.mcpToolset,
      resolvedToolIds: setup.resolvedToolIds,
      thinkingRecorder,
      toolDefs: setup.toolDefs,
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
    deepWaterHandoffGuard.assertCompletion()

    const responseText = stripLeadingSectionTag(loopResult.finalText)

    // A cooperative cancel is a classified, user-visible outcome (like a
    // budget-cap stop): any partial answer is delivered with a "cancelled"
    // notice and the run ends `cancelled`. DeepWater handoff runs are guarded
    // against cancel at the API (409 → research_cancel), so `cancelRequestedAt`
    // is never set on them; the `!handoffLocator` check keeps their invariants
    // untouched even if the flag somehow appeared.
    if (loopResult.cancelled && !handoffLocator) {
      await handleCancelStop(deps, payload, context, planContext, loopResult, responseText)
      terminalOutcome = 'cancelled'
      return
    }

    // A budget-cap stop is a classified, user-visible outcome — never a silent
    // empty reply. DeepWater handoff runs (`handoffLocator`) keep their exact
    // existing completion path so their strict invariants are untouched.
    if (loopResult.exhaustedBudget && !handoffLocator) {
      const hadPartialText = responseText.trim().length > 0
      // Reserved headroom pays for the checkpoint here, before anything is
      // delivered — a checkpoint cannot be produced after the budget is gone.
      const stopPlan = await prepareRunStop(deps, payload, context, {
        goal: prompt,
        hadPartialText,
        inference,
        invocationSink: invocations,
        loopResult: { ...loopResult, exhaustedBudget: loopResult.exhaustedBudget },
        priorGeneration: setup.checkpoint?.generation ?? 0,
      })
      if (hadPartialText) {
        // Partial answer present: deliver it with the stop notice appended and
        // complete the run normally.
        await completeRunExecution(deps, payload, context, planContext, {
          invocations: loopResult.invocations,
          iterations: loopResult.iterations,
          memories: setup.memories,
          messageMetadata: { runStop: stopPlan.runStopMetadata },
          responseText: `${responseText}\n\n${stopPlan.notice}`,
          toolCallsUsed: loopResult.toolCallsUsed,
        })
        terminalOutcome = 'completed'
      } else {
        // No answer at all: still record the tokens/cost this run spent (the
        // failure path does not, but completeRunExecution would have), then
        // post the notice as the terminal message and fail the run so the user
        // is told why nothing came back.
        await persistInvocationLedgerEvents(deps.prisma, {
          actorContext: payload.actorContext,
          agentId: context.agent.id,
          invocations: loopResult.invocations,
          runId: context.run.id,
        })
        await handleRunExecutionFailure(deps, payload, context, {
          error: new Error(
            `Run stopped at ${classifyBudgetStop(loopResult.exhaustedBudget)}`,
          ),
          planContext,
          streamStarted,
          terminalMessage: stopPlan.notice,
          terminalMessageMetadata: { runStop: stopPlan.runStopMetadata },
        })
        terminalOutcome = 'failed'
      }
      // Enqueued only after this run is terminal, so the per-(agent, thread)
      // single-run invariant is never broken to force a continuation.
      await applyRunStopContinuation(deps, payload, context, stopPlan)
      return
    }

    // Wound-down handover (spec §3a): the model was told the run was ending and
    // finished on its own terms. Its closing words ARE the notice; the
    // checkpoint is written quietly so a reply or Continue resumes with state.
    const windDownMetadata =
      loopResult.woundDown && !handoffLocator && responseText.trim().length > 0
        ? await prepareWindDownHandover(deps, payload, context, {
          goal: prompt,
          inference,
          invocationSink: invocations,
          loopResult,
          priorGeneration: setup.checkpoint?.generation ?? 0,
        })
        : null

    // A recurring watch that found nothing folds into its rolling status line
    // rather than adding another "nothing changed" to the channel. Gated on
    // structural facts — an unattended run belonging to a trigger that has not
    // opted out — and then judged by the model, which fails open to posting.
    const rollingWatch = await resolveRollingWatch(deps, payload, context, {
      responseText,
      runUtility: inference.runUtility,
    })

    // A run that answered with a reaction has already spoken. Posting its
    // leftover "👍" as a message too would say the same thing twice, the
    // second time as text.
    const reactionWasTheAnswer = isContentlessAfterReacting(reacted, responseText)

    await completeRunExecution(deps, payload, context, planContext, {
      invocations: loopResult.invocations,
      iterations: loopResult.iterations,
      memories: setup.memories,
      ...(windDownMetadata ? { messageMetadata: { runStop: windDownMetadata } } : {}),
      responseText,
      ...(rollingWatch ? { rollingWatch } : {}),
      ...(reactionWasTheAnswer ? { reactionWasTheAnswer: true } : {}),
      toolCallsUsed: loopResult.toolCallsUsed,
    })
    terminalOutcome = 'completed'
  } catch (caughtError) {
    // Same stream-contract rule as the success path: the failure handler will
    // publish `stream.done`, so drain any buffered thinking first. Idempotent,
    // error-swallowing, and also correct on the retry-throw path (the retry
    // republishes `stream.start`, so its stream stays well-formed).
    await thinkingRecorder.close()
    const error = promoteUnresolvedDeepWaterHandoffError(
      caughtError,
      deepWaterHandoffGuard,
    )
    if (shouldRetryRunWithoutTerminalizing(error, queueAttempt)) throw error
    if (
      isFinalQueueAttempt(queueAttempt)
      && error instanceof DeepWaterHandoffFatalError
      && handoffLocator
    ) {
      if (error.handoffRunId) {
        await markDeepWaterHandoffRecoveryNeeded(deps.prisma, {
          ...handoffLocator,
          runId: error.handoffRunId,
        })
      } else {
        await markAmbiguousDeepWaterHandoffRecoveryNeeded(
          deps.prisma,
          handoffLocator,
        )
      }
    }
    // Attribute the tokens this run burned before it failed. Completion (and the
    // budget-stop no-text path) persist their own invocations; a crashed/aborted
    // run never reaches completion, so without this its inference spend would be
    // dropped and impossible to attribute. Idempotent: persistInvocationLedgerEvents
    // dedupes on inferenceInvocationId, so a later retry that reuses ids is safe.
    // Best-effort — a ledger write must never mask the original failure.
    if (invocations.length > 0) {
      try {
        await persistInvocationLedgerEvents(deps.prisma, {
          actorContext: payload.actorContext,
          agentId: context.agent.id,
          invocations,
          runId: context.run.id,
        })
      } catch (ledgerError) {
        console.error(
          '[worker] failed to persist ledger events for failed run',
          context.run.id,
          ledgerError,
        )
      }
    }
    await handleRunExecutionFailure(deps, payload, context, {
      error,
      planContext,
      streamStarted,
    })
    terminalOutcome = 'failed'

    throw error
  } finally {
    // Flush whatever thought process is still buffered, on every exit path
    // (completion, classified stop, crash, retry-throw). Idempotent and
    // error-swallowing by construction, so it can never mask a run outcome.
    await thinkingRecorder.close()

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
