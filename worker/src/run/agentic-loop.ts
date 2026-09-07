import type {
  InvocationRecord,
  ProviderMessage,
  ProviderToolCall,
} from '@nessie/runtime'
import { redactDetectedSecrets } from '@nessie/schemas'
import { redactMessageContent } from './message-redaction.js'
import {
  createDrainGate,
  createToolExecutionRecorder,
  restoreCompactionGovernor,
  type DrainGate,
} from './loop-resume.js'
import { createRetryBudget } from './error-classification.js'
import { callInferenceWithRetry } from './inference-retry.js'
import {
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  trimConversationToFit,
} from './context-management.js'
import { resolveOutputAdmission } from './output-admission.js'
import {
  DEFAULT_CACHE_READ_WEIGHT,
  meterSpend,
  shouldWindDown,
  stopAfterInference,
  stopAfterToolBatch,
  stopBeforeInference,
  stopBeforeIteration,
  type BudgetExhaustionReason,
  type SpendTotals,
} from './loop-budget.js'
import {
  buildContextPlan,
  createCompactionGovernor,
  MAX_COMPACTIONS_PER_RUN,
} from './context-window.js'
import { ToolCircuitBreaker } from './circuit-breaker.js'
import { truncateToolResult } from './tool-util.js'
import {
  executeToolBatch,
  type ExecutedToolResult,
  type AgentCardSuspension,
  type ToolApprovalSuspension,
} from './tool-batch.js'
import {
  type AgenticLoopInput,
  type LoopResult,
} from './agentic-loop-types.js'

export const OUTPUT_LENGTH_FINALIZATION_INSTRUCTION =
  'Your previous response reached the provider output limit. Give the user a concise final answer now, using only the completed work and tool results already in this conversation. Do not call tools or start new work.'

const outputLimitPartial = (text: string): string => [
  text.trim(),
  'I reached the response limit before completing the answer. Continue this run to finish.',
].filter(Boolean).join('\n\n')

export type { BudgetExhaustionReason, BudgetLimits } from './loop-budget.js'

export type { LoopCallbacks, LoopResult } from './agentic-loop-types.js'

export const runAgenticLoop = async (input: AgenticLoopInput): Promise<LoopResult> => {
  const { budget, callbacks, executeTool, initialMessages, prepareTool } = input
  const cacheReadWeight = input.cacheReadWeight ?? DEFAULT_CACHE_READ_WEIGHT
  const resume = input.resume ?? null
  // Covers every caller, including delegated agents whose initial prompt does
  // not pass through buildModelPrompt. Raw values never remain in the loop's
  // retained context or its eventual checkpoint input.
  const messages: ProviderMessage[] = (resume?.messages ?? initialMessages)
    .map(redactMessageContent)
  const allInvocations: InvocationRecord[] = input.invocationSink ?? []
  if (resume) allInvocations.push(...resume.invocations)
  const signatureCounts = new Map<string, number>(
    Object.entries(resume?.signatureCounts ?? {}),
  )
  const drainGate: DrainGate = createDrainGate(input.drainSignal)
  const retryBudget = createRetryBudget(6)
  retryBudget.remaining = Math.max(0, retryBudget.total - (resume?.retriesUsed ?? 0))
  const toolSchemaTokens = estimateToolSchemaTokens(input.tools)
  const circuitBreaker = new ToolCircuitBreaker()
  circuitBreaker.restore(resume?.toolFailureCounts ?? {})
  const contextPlan = input.contextPlan
    ?? buildContextPlan({ model: null, toolSchemaTokens })
  const compactionGovernor = createCompactionGovernor(contextPlan)
  if (resume) restoreCompactionGovernor(compactionGovernor, resume)

  let iterations = resume?.iterations ?? 0
  let toolCallsUsed = resume?.toolCallsUsed ?? 0
  let pendingToolResults: ExecutedToolResult[] | null = null
  let totalToolMs = resume?.toolMs ?? 0
  let spend: SpendTotals = meterSpend(allInvocations, cacheReadWeight)
  let woundDown = resume?.woundDown ?? false
  // The batch that was dispatching when the previous executor died. Its
  // assistant message is already in `messages`, so re-entering it is the only
  // way back into the transcript that does not re-bill the inference that
  // produced it.
  let resumedToolCalls: ProviderToolCall[] | null = resume?.pendingToolCalls ?? null
  // Mirror the governor state into checkpoints so a reclaimed run keeps both
  // the attempt ceiling and the two-iteration cooldown.
  let compactionAttempts = resume?.compactionAttempts ?? 0
  let compactionLastIteration: number | null = resume?.compactionLastIteration ?? null
  let lengthFinalizationUsed = resume?.lengthFinalizationUsed ?? false
  let lengthFinalizationPending = resume?.lengthFinalizationPending ?? false
  // The most recent assistant text seen. On a budget-cap stop this is the run's
  // partial answer: the caller surfaces it (with a "stopped at the limit"
  // notice) instead of posting nothing, so a capped run is never silent.
  let lastAssistantText = resume?.lastAssistantText ?? ''
  const priorElapsedMs = resume?.elapsedMs ?? 0
  const startTime = Date.now()

  const elapsed = (): number => priorElapsedMs + (Date.now() - startTime)

  // The batch currently dispatching, and the loop-detection and breaker
  // counters as they stood when it started. `executeToolBatch` mutates both
  // live as it runs, so a snapshot taken part-way through must carry the counts
  // the batch began with or a re-entry would count the same calls twice.
  let inFlightToolCalls: ProviderToolCall[] | null = null
  let boundarySignatureCounts: Record<string, number> = {
    ...(resume?.signatureCounts ?? {}),
  }
  let boundaryToolFailureCounts: Record<string, number> = {
    ...(resume?.toolFailureCounts ?? {}),
  }
  const markDispatchBoundary = (pending: ProviderToolCall[] | null): void => {
    inFlightToolCalls = pending
    boundarySignatureCounts = Object.fromEntries(signatureCounts)
    boundaryToolFailureCounts = circuitBreaker.snapshot()
  }

  const checkpoint = async (): Promise<void> => {
    await callbacks.onCheckpoint?.({
      compactionAttempts,
      compactionLastIteration,
      elapsedMs: elapsed(),
      invocations: allInvocations,
      iterations,
      lastAssistantText,
      lengthFinalizationUsed,
      lengthFinalizationPending,
      messages,
      pendingToolCalls: inFlightToolCalls,
      retriesUsed: retryBudget.total - retryBudget.remaining,
      signatureCounts: boundarySignatureCounts,
      toolCallsUsed,
      toolFailureCounts: boundaryToolFailureCounts,
      toolMs: totalToolMs,
      toolResults: toolRecorder.recorded(),
      woundDown,
    })
  }

  // Tool results this run has already recorded, so a re-entered batch answers
  // them from the record instead of dispatching them a second time.
  //
  // Deliberately weaker than "a tool runs at most once per run". A result only
  // suppresses a re-execution once its record reached storage, and this loop is
  // never told whether it did: `onCheckpoint` may persist nothing at all (a
  // delegate sub-agent supplies no sink), and where it does, the write can be
  // skipped, fenced out or fail. The exact scope, and the window that stays
  // open even when every write lands, are stated once at
  // `createToolExecutionRecorder` in ./loop-resume.ts.
  const toolRecorder = createToolExecutionRecorder({
    executeTool,
    onRecorded: () => checkpoint(),
    ...(prepareTool ? { prepareTool } : {}),
    ...(resume?.toolResults ? { restored: resume.toolResults } : {}),
  })

  // Single construction point for every exit path, so the running totals
  // (including per-stage timing) are captured identically whether the loop
  // completes naturally, trips a budget cap, or is cancelled.
  const finish = (
    exhaustedBudget: BudgetExhaustionReason | null,
    finalText: string = lastAssistantText,
    cancelled = false,
    pendingApproval: ToolApprovalSuspension | null = null,
    pendingInput: AgentCardSuspension | null = null,
  ): LoopResult => ({
    cacheReadTokens: spend.cacheReadTokens,
    cancelled,
    effectiveTokensUsed: spend.effectiveTokensUsed,
    exhaustedBudget,
    finalText,
    invocations: allInvocations,
    iterations,
    messages,
    pendingApproval,
    pendingInput,
    toolCallsUsed,
    toolMs: totalToolMs,
    totalCostCents: spend.totalCostCents,
    totalTokensUsed: spend.totalTokensUsed,
    wallclockMs: elapsed(),
    woundDown,
  })

  // A cooperative-cancel probe. Between iterations and after each tool batch the
  // loop asks whether a cancel was requested; if so it stops with any partial
  // answer already captured in `lastAssistantText`.
  const cancellationRequested = async (): Promise<boolean> =>
    input.checkCancelled ? input.checkCancelled() : false

  const stop = async (reason: BudgetExhaustionReason): Promise<LoopResult> => {
    await callbacks.onBudgetExhausted(reason)
    return finish(reason)
  }

  // Fold the elder transcript into a rolling work-state note. Safe here and
  // only here: the previous tool batch has fully settled, so no group is open.
  // A failed or unavailable compaction degrades to emergency truncation rather
  // than letting the transcript grow into a provider overflow.
  const maintainContext = async (iteration: number, force = false): Promise<void> => {
    // The plan's thresholds already exclude the tool schemas, so only the
    // transcript is measured against them.
    const transcriptTokens = estimateMessagesTokens(messages)
    if (!force && !compactionGovernor.shouldAttempt({ iteration, transcriptTokens })) return
    if (force && compactionAttempts >= MAX_COMPACTIONS_PER_RUN) return
    compactionGovernor.recordAttempt(iteration)
    compactionAttempts += 1
    compactionLastIteration = iteration
    const compacted = input.compactContext
      ? await input
        .compactContext({ messages, targetTokens: contextPlan.targetTokens })
        .catch(() => null)
      : null
    const rebuilt = compacted ?? trimConversationToFit(messages, contextPlan.targetTokens)
    messages.length = 0
    messages.push(...rebuilt)
  }

  while (true) {
    // Drain before cancel: a stopping worker has already written this run's
    // checkpoint and has seconds, not minutes, to hand it over.
    drainGate.assert()
    if (await cancellationRequested()) {
      return finish(null, lastAssistantText, true)
    }

    // The batch the previous executor was dispatching when it died, claimed
    // once. Re-entering it must not push anything between the assistant
    // message that requested those calls and their results, so the wind-down
    // injection below is skipped on that pass.
    const reenteredToolCalls = resumedToolCalls
    resumedToolCalls = null

    // Wind-down first, stop second: on the iteration where the 80% band is
    // entered the harder 90% boundary has not tripped yet, so the model gets
    // the remaining slice to finish and hand over on its own terms.
    if (!reenteredToolCalls && input.windDownInstruction && !woundDown && shouldWindDown(budget, {
      effectiveTokensUsed: spend.effectiveTokensUsed,
      elapsedMs: elapsed(),
      iterations,
      toolCallsUsed,
      totalCostCents: spend.totalCostCents,
    })) {
      woundDown = true
      messages.push({ content: input.windDownInstruction, role: 'system' })
      input.onWindDown?.()
    }

    const preIterationStop = stopBeforeIteration(budget, { elapsedMs: elapsed(), iterations })
    if (preIterationStop) return stop(preIterationStop)

    if (input.checkBudgetBlocked && (await input.checkBudgetBlocked())) {
      return stop('org_budget_blocked')
    }

    let toolCalls: ProviderToolCall[]
    if (reenteredToolCalls) {
      // The iteration that produced these calls was already counted and its
      // inference already paid for and recorded in `messages`. Re-entering asks
      // the provider nothing.
      toolCalls = reenteredToolCalls
    } else {
      iterations += 1
      await callbacks.onIterationStart(iterations)

      await maintainContext(iterations)
      // Utility compaction is metered inference. Even a failed compaction call
      // may have usage in the shared sink, so re-check every budget dimension
      // before allowing the main model call.
      spend = meterSpend(allInvocations, cacheReadWeight)
      const postCompactionSpendStop = stopAfterInference(budget, spend)
      if (postCompactionSpendStop) return stop(postCompactionSpendStop)
      const postCompactionTimeStop = stopBeforeIteration(budget, {
        elapsedMs: elapsed(),
        // This is an elapsed-time probe only: this iteration has already
        // claimed its countable slot.
        iterations: 0,
      })
      if (postCompactionTimeStop) return stop(postCompactionTimeStop)

      const finalizationPending = lengthFinalizationPending
      const activeToolSchemaTokens = finalizationPending ? 0 : toolSchemaTokens
      const admission = () => resolveOutputAdmission({
        contextPlan,
        effectiveTokensUsed: spend.effectiveTokensUsed,
        maxOutputTokens: input.maxOutputTokens,
        maxRunTokens: budget.maxTokens,
        messages,
        toolSchemaTokens: activeToolSchemaTokens,
      })
      let currentAdmission = admission()
      // Context compaction normally starts at 80%; an answer reserve can make
      // a smaller retained transcript unsafe before that threshold, so compact
      // here while all prior tool pairs are intact.
      if (currentAdmission.requiresCompaction && compactionLastIteration !== iterations) {
        await maintainContext(iterations, true)
        // Compaction is itself inference. Its invocation sink changes spend,
        // and its rebuilt note changes input; both must be re-admitted.
        spend = meterSpend(allInvocations, cacheReadWeight)
        const forcedCompactionSpendStop = stopAfterInference(budget, spend)
        if (forcedCompactionSpendStop) return stop(forcedCompactionSpendStop)
        const forcedCompactionTimeStop = stopBeforeIteration(budget, {
          elapsedMs: elapsed(),
          iterations: 0,
        })
        if (forcedCompactionTimeStop) return stop(forcedCompactionTimeStop)
        currentAdmission = admission()
      }

      if (currentAdmission.requestedOutputTokens !== undefined
        && currentAdmission.requestedOutputTokens < 1) return stop('tokens')

      // The iteration boundary: the previous batch has fully settled and the
      // transcript that will be sent is assembled, so this is the state a
      // re-claiming executor should pick up.
      markDispatchBoundary(null)
      await checkpoint()

      // Measured after compaction, so the gate judges the context that will
      // actually be sent rather than the one that was about to be folded away.
      const preInferenceStop = stopBeforeInference(budget, {
        effectiveTokensUsed: spend.effectiveTokensUsed,
        projectedCallTokens: currentAdmission.projectedInputTokens,
        projectedOutputTokens: currentAdmission.requestedOutputTokens,
      })
      if (preInferenceStop) return stop(preInferenceStop)

      const captured = pendingToolResults
        ? { toolResults: pendingToolResults }
        : undefined
      pendingToolResults = null
      const result = await drainGate.expiry(callInferenceWithRetry(
        messages,
        (inferenceMessages) => input.runInference(
          inferenceMessages,
          captured,
          {
            ...(currentAdmission.requestedOutputTokens === undefined
              ? {}
              : { maxOutputTokens: currentAdmission.requestedOutputTokens }),
            ...(finalizationPending ? { noTools: true } : {}),
          },
        ),
        retryBudget,
        contextPlan.targetTokens,
      ))
      allInvocations.push(...result.invocations)
      spend = meterSpend(allInvocations, cacheReadWeight)
      const safeOutputText = redactDetectedSecrets(result.outputText)
      if (safeOutputText) {
        lastAssistantText = safeOutputText
      }

      const spendStop = stopAfterInference(budget, spend)
      if (spendStop) return stop(spendStop)

      if (result.finishReason === 'length') {
        if (finalizationPending || lengthFinalizationUsed) {
          lastAssistantText = outputLimitPartial(safeOutputText || lastAssistantText)
          return stop('tokens')
        }
        {
          // Persist the truncated turn before asking for the bounded recovery.
          // A re-claimed worker therefore retains the evidence and never has to
          // re-dispatch the tool batch that produced it.
          lengthFinalizationUsed = true
          lengthFinalizationPending = true
          messages.push(redactMessageContent({
            content: safeOutputText || null,
            role: 'assistant',
          }))
          messages.push({
            content: OUTPUT_LENGTH_FINALIZATION_INSTRUCTION,
            role: 'system',
          })
          await checkpoint()
          // Re-enter through the next loop boundary. The pending marker is
          // durable, so a crash cannot turn this recovery into a tool-enabled
          // call or replay an incomplete provider tool-call batch.
          continue
        }
      }

      if (finalizationPending && result.toolCalls.length > 0) {
        lastAssistantText = outputLimitPartial(safeOutputText || lastAssistantText)
        return stop('tokens')
      }

      if (!result.toolCalls || result.toolCalls.length === 0) {
        lengthFinalizationPending = false
        if (safeOutputText) {
          await callbacks.onTextDelta(safeOutputText)
        }
        return finish(null, safeOutputText)
      }

      messages.push(redactMessageContent({
        content: safeOutputText || null,
        role: 'assistant',
        toolCalls: result.toolCalls,
      }))
      toolCalls = result.toolCalls
    }

    // Immediately before dispatch, carrying the batch itself: a worker that
    // dies mid-batch leaves a transcript ending in an assistant tool-call
    // message, which no provider will answer. The successor re-enters this
    // exact batch instead, and every tool that already ran answers from its
    // recorded result.
    markDispatchBoundary(toolCalls)
    await checkpoint()

    const batch = await drainGate.expiry(executeToolBatch({
      callbacks,
      circuitBreaker,
      executeTool: toolRecorder.executeTool,
      ...(toolRecorder.prepareTool ? { prepareTool: toolRecorder.prepareTool } : {}),
      signatureCounts,
      toolCalls,
      toolTimeoutError: input.toolTimeoutError,
      toolTimeoutMs: budget.toolTimeoutMs,
    }))
    totalToolMs += batch.toolMs
    const toolResults = batch.results

    toolCallsUsed += toolResults.length
    if (batch.pendingApproval) {
      return finish(null, lastAssistantText, false, batch.pendingApproval)
    }
    // The card is posted and the person owes an answer; nothing further in this
    // generation can usefully run, so the loop exits and the run parks.
    if (batch.pendingInput) {
      return finish(null, lastAssistantText, false, null, batch.pendingInput)
    }
    pendingToolResults = toolResults.map(({ acknowledgeDelivery: _ack, ...rest }) => rest)

    for (const tr of toolResults) {
      // Single truncation chokepoint: every tool result — builtin, MCP, and
      // `delegate` sub-agent output — is capped here before it enters context.
      // Builtins pre-truncate in `tools.ts` (idempotent: the marker is
      // detected and not re-applied); MCP and delegate results have no other
      // cap, so this is what bounds them (audit F1).
      messages.push({
        content: truncateToolResult(tr.output),
        role: 'tool',
        toolCallId: tr.toolCallId!,
      })
      tr.acknowledgeDelivery?.()
    }
    // The batch is closed: every result is in the transcript, so from here a
    // snapshot resumes at the next iteration rather than re-entering this one.
    markDispatchBoundary(null)

    if (batch.loopDetected) {
      messages.push({
        content: 'You are repeating the same tool call. Stop and produce a final answer with the information you already have.',
        role: 'user',
      })
    }

    const batchStop = stopAfterToolBatch(budget, { elapsedMs: elapsed(), toolCallsUsed })
    if (batchStop === 'tool_calls') return stop(batchStop)

    // Cooperative cancel between tool-call batches: the just-completed tools have
    // been recorded and their results incorporated, so stopping here is clean.
    if (await cancellationRequested()) {
      return finish(null, lastAssistantText, true)
    }

    if (batchStop) return stop(batchStop)
  }
}
