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
import { RunDrainedError } from '../loop-resume.js'
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
  assertExecutorHoldsRun,
  claimRunForExecution,
  loadRunContext,
  releaseRunForDrain,
  RunFencedError,
  setAgentStatus,
  startExecutorHeartbeat,
  updateTaskStatus,
  updateRunStatus,
  withRunExecutorFence,
} from './lifecycle.js'
import { validateRunActorContext } from './policy.js'
import { publishAgentStatus, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import {
  persistResolvedReplyAnchor,
  resolveConversationRootMessageId,
  resolveReplyRootMessageId,
} from './reply-placement.js'
import { buildScopes } from './scopes.js'
import { createRunRecorders } from './run-recorders.js'
import { handleRunFailurePath } from './run-failure-path.js'
import { handleRunLoopOutcome } from './run-outcome.js'
import type { ExecutionDependencies, RunPlanContext } from './types.js'
import { loadGlobalAgentCatalogueBlock } from './global-agent-catalogue.js'
import { assertGlobalAgentRunPlacement } from './global-agent-placement.js'
import { assertPrivateAgentRunPlacement } from './private-agent-placement.js'
import { resolveAgentTodoKickoffPrompt } from './todo-kickoff.js'
import { createCrashCheckpointWriter, loadCrashCheckpoint } from './crash-checkpoint.js'
import {
  assertPersonalAssistantPresenceRunPlacement,
  PersonalAssistantPresencePlacementError,
} from './personal-assistant-presence-placement.js'

/**
 * The whole job runs as the execution that may come to hold this run: the claim
 * stamps its fencing token into the surrounding context, and every status write
 * underneath — here, in the terminal paths, in an external-conversation turn —
 * carries it without being handed it. The scope dies with the job, so nothing
 * has to be released on any exit path.
 */
export const executeRunJob = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  queueAttempt: QueueAttempt,
  // The queue's per-job abort signal (`handler(job, { signal })`), which fires
  // when this worker is draining or the job's lock is lost. Threaded all the
  // way into the agentic loop so a drain reaches the checkpoint path instead of
  // killing a 45-minute run mid-inference.
  options: { signal?: AbortSignal } = {},
): Promise<void> =>
  withRunExecutorFence(
    payload.runId,
    () => runJobUnderFence(deps, payload, queueAttempt, options),
  )

const runJobUnderFence = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  queueAttempt: QueueAttempt,
  options: { signal?: AbortSignal },
): Promise<void> => {
  // Idempotency guard: skip if this run already reached a terminal state.
  //
  // We deliberately do NOT skip `running` runs here — but this guard is no
  // longer what decides whether re-executing one is safe. It used to be: with a
  // single worker the queue's lock renewal (see PgQueueProvider.withLockRenewal)
  // meant a re-delivered job for a `running` run could only be a crashed
  // worker's, so re-execution was the recovery path. With N workers the previous
  // executor may simply be slow, so the decision moved into
  // `claimRunForExecution`, which admits a `running` run only once its
  // executor's heartbeat has gone stale. This read stays because it is cheap and
  // ends terminal runs before any of the setup below.
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
    select: {
      basisScopes: { select: { scopeType: true, scopeId: true } },
      content: true,
      metadata: true,
      rootMessageId: true,
    },
  })
  if (!message) {
    return
  }

  // The trigger message becomes this run's prompt, so it is a read that enters
  // the run's context and owes the sink its provenance. `loadConversation`
  // already inherits the basis of every window turn, which covers the ordinary
  // case twice over — but a `system`-role trigger message is excluded from that
  // window by design, so a hidden server-authored brief (the `agent_handoff`
  // one, a trigger kickoff) would otherwise carry its restriction into the run
  // and out again through a reply computed from an empty basis.
  context.consumedSources.addAll(message.basisScopes)

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
  // Started by the claim, stopped in the `finally`. Null on every path that
  // returns before claiming, which is exactly the set of paths with no claim to
  // keep alive.
  let heartbeat: { stop: () => void } | null = null
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

  // Both live recorders, created before the `try` and closed in its `finally`:
  // they must exist before the first provider chunk, and every exit path —
  // completion, classified stop, crash, drain — has to settle them.
  const { documentStream, executionDeps, thinkingRecorder } = createRunRecorders(deps, context)

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

    const claim = await claimRunForExecution(deps.prisma, context.run.id)
    if (!claim.claimed) {
      if (handoffLocator) {
        await markDeepWaterHandoffRecoveryNeeded(deps.prisma, {
          ...handoffLocator,
          runId: handoffLocator.runId,
        })
      }
      // Ack, never nack: the run is terminal, or a live executor holds it and
      // is doing the work. Re-delivering the job would only race that executor.
      console.log(
        `[worker] run ${context.run.id} is terminal or held by a live executor; skipping`,
      )
      return
    }
    claimedAt = new Date()
    // Keeps this executor's claim fresh for as long as it is really working, so
    // no other worker mistakes a slow run for a crashed one. Stopped in the
    // `finally` on every exit path.
    heartbeat = startExecutorHeartbeat(deps.prisma, context.run.id)
    prompt = await resolveAgentTodoKickoffPrompt(deps.prisma, context, {
      messageId: payload.messageId,
      metadata: message.metadata,
      prompt,
    })
    // Whatever this run had already worked out before its previous executor
    // died. Absent for a run starting normally, which is the ordinary case and
    // says so in the log rather than reading as a fault.
    const resumeState = claim.priorStatus === 'running'
      ? await loadCrashCheckpoint(deps.prisma, context.run.id)
      : null
    if (claim.priorStatus === 'running') {
      console.log(
        resumeState
          ? `[worker] resuming run ${context.run.id} from its crash checkpoint `
            + `(iteration ${resumeState.iterations}, `
            + `${Object.keys(resumeState.toolResults).length} tool result(s) recorded)`
          : `[worker] re-claimed run ${context.run.id} has no crash checkpoint; `
            + 'starting it again from the prompt',
      )
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

    // A global agent's authority is generated, never written: the design
    // catalogue renders from the live tool definitions, this organisation's
    // registry rows and the Ledger model list, so a new tool is in the Agent
    // Designer's knowledge the deploy it ships. It rides as its own system
    // message after the cache-stable anchor, exactly as the memory and
    // checkpoint injections do, and is assembled only for a run whose agent has
    // a blueprint — every other run pays nothing.
    const catalogueBlock = await loadGlobalAgentCatalogueBlock(deps.prisma, context, {
      actorContext: payload.actorContext,
      ledgerIdentity: deps.ledgerIdentity ?? null,
      resolvedToolIds: setup.resolvedToolIds,
    })
    const initialMessages = catalogueBlock
      ? [
        setup.initialMessages[0]!,
        { content: catalogueBlock, role: 'system' as const },
        ...setup.initialMessages.slice(1),
      ]
      : setup.initialMessages

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

    const budgetBlockedProbe = createBudgetBlockedProbe(deps, context, payload, {
      subscriptionPinned: subscriptionBinding !== null,
    })

    let reacted = false
    loopResult = await runExecutionAgentLoop(executionDeps, payload, context, {
      allowedToolIds: setup.allowedToolIds,
      ...(options.signal ? { drainSignal: options.signal } : {}),
      ...(resumeState ? { resumeState } : {}),
      crashCheckpoint: createCrashCheckpointWriter(
        deps.prisma,
        {
          agentId: context.agent.id,
          organizationId: String(context.channel.organizationId),
          rootMessageId: context.replyRootMessageId ?? null,
          runId: context.run.id,
          taskId: context.task.id,
          threadId: context.run.threadId,
        },
        claim.token,
      ),
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
      // The loop's per-iteration probe is also where this executor finds out it
      // has been fenced out: `assertExecutorHoldsRun` throws as soon as a
      // heartbeat has seen the takeover, so the run is abandoned at the next
      // iteration boundary instead of running to the end and only then
      // discovering it cannot write the outcome.
      checkBudgetBlocked: async () => {
        assertExecutorHoldsRun(context.run.id)
        return budgetBlockedProbe()
      },
      identityToolIds: setup.identityToolIds,
      inference,
      isHandoffTurn: handoffLocator !== null,
      initialMessages,
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
    try {
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
    } catch (failureError) {
      // A fenced-out executor stops here and the job is acked: another executor
      // owns this run and will write its outcome, so neither a failure status
      // from this one nor a queue redelivery is wanted. Every other error keeps
      // the failure path's own contract (terminalize, or rethrow for a retry).
      if (failureError instanceof RunDrainedError) {
        // Hand the run back before the throw reaches the queue, so the nacked
        // job's next claimant does not have to wait out the takeover window to
        // pick up a run this worker has already stopped executing. The crash
        // checkpoint written at the boundary the loop stopped at is what it
        // resumes from.
        await releaseRunForDrain(deps.prisma, context.run.id)
        console.log(
          `[worker] draining: handed run ${context.run.id} back at its crash checkpoint`,
        )
        throw failureError
      }
      if (!(failureError instanceof RunFencedError)) throw failureError
      console.warn(
        `[worker] run ${context.run.id} finished on another executor; nothing written here`,
      )
    }
  } finally {
    // The claim this executor no longer needs. (The fencing token itself needs
    // no cleanup: it lives in this job's async context and goes with it.)
    heartbeat?.stop()
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
