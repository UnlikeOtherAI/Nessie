import type {
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import { redactDetectedSecrets } from '@nessie/schemas'
import { createRetryBudget } from './error-classification.js'
import { callInferenceWithRetry } from './inference-retry.js'
import {
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  trimConversationToFit,
} from './context-management.js'
import {
  DEFAULT_CACHE_READ_WEIGHT,
  meterSpend,
  shouldWindDown,
  stopAfterInference,
  stopAfterToolBatch,
  stopBeforeInference,
  stopBeforeIteration,
  ZERO_SPEND,
  type BudgetExhaustionReason,
  type BudgetLimits,
  type SpendTotals,
} from './loop-budget.js'
import {
  buildContextPlan,
  createCompactionGovernor,
  type ContextPlan,
} from './context-window.js'
import { ToolCircuitBreaker } from './circuit-breaker.js'
import {
  sanitizeProviderToolCalls,
  summarizeToolInput,
  truncateToolResult,
} from './tool-util.js'
import {
  executeToolBatch,
  type ExecuteToolFn,
  type ExecutedToolResult,
  type PrepareToolFn,
  type AgentCardSuspension,
  type ToolApprovalSuspension,
  type ToolBatchCallbacks,
} from './tool-batch.js'

export type { BudgetExhaustionReason, BudgetLimits } from './loop-budget.js'

const redactProviderMessage = (message: ProviderMessage): ProviderMessage => {
  const content = typeof message.content === 'string'
    ? redactDetectedSecrets(message.content)
    : message.content
  if (message.role === 'assistant' && message.toolCalls) {
    return { ...message, content, toolCalls: sanitizeProviderToolCalls(message.toolCalls) }
  }
  return { ...message, content } as ProviderMessage
}

export type LoopCallbacks = ToolBatchCallbacks & {
  onIterationStart: (iteration: number) => Promise<void>
  onTextDelta: (delta: string) => Promise<void>
  onBudgetExhausted: (reason: BudgetExhaustionReason) => Promise<void>
}

export type LoopResult = {
  finalText: string
  iterations: number
  // The conversation as it stood when the loop exited. The caller reads it to
  // produce a checkpoint note from the reserved budget headroom.
  messages: ProviderMessage[]
  toolCallsUsed: number
  // Aggregate wall-clock time spent inside tool executions. It measures tool
  // work rather than the run span; same-batch calls may overlap.
  toolMs: number
  totalCostCents: number
  wallclockMs: number
  // Raw provider-reported tokens, unchanged: what the ledger and telemetry read.
  totalTokensUsed: number
  // What the budget actually metered — fresh input + output + cache reads
  // discounted by the run's cache-read weight. Every token verdict uses this.
  effectiveTokensUsed: number
  // Provider-reported cache reads, summed, so a stop can show the composition
  // instead of only the number that tripped it.
  cacheReadTokens: number
  exhaustedBudget: BudgetExhaustionReason | null
  /** A policy-gated tool persisted an approval request and stopped the loop. */
  pendingApproval?: ToolApprovalSuspension | null
  /**
   * `card_post` posted an interactive card with `wait: true`. Unlike an
   * approval this is decided *after* dispatch — the card has to exist before
   * anybody can press it — so the batch reports it from a settled result.
   */
  pendingInput?: AgentCardSuspension | null
  // True when the loop exited because a cooperative cancel was observed (via
  // `checkCancelled`) between iterations or after a tool-call batch, rather than
  // because the model finished or a budget cap tripped. `finalText` then holds
  // whatever partial answer was produced so the caller can still deliver it.
  cancelled: boolean
  // True when the wind-down instruction was injected: the model was told the
  // run is ending and asked to deliver with what it has. A natural finish after
  // this is a deliberate handover (the caller checkpoints it quietly); a budget
  // stop after this means the model overran even the reserve.
  woundDown: boolean
  invocations: InvocationRecord[]
}

export const runAgenticLoop = async (input: {
  budget: BudgetLimits
  // Fraction of the input price a cache read costs on this run's provider+model,
  // resolved once per run (run-budget.ts `resolveCacheReadWeight`). Cache reads
  // are metered at this weight against the token budget.
  cacheReadWeight?: number
  callbacks: LoopCallbacks
  // Optional cooperative-cancel probe. Consulted between iterations and after
  // each tool-call batch; when it resolves `true` the loop stops immediately and
  // returns a `cancelled` result carrying any partial answer. Kept side-effect
  // free (a cheap status read) — the caller owns terminalization and notices.
  checkCancelled?: () => Promise<boolean>
  // Optional org-`Budget` probe, consulted between iterations. The caller owns
  // throttling and alerting; a `true` verdict stops the loop with the
  // `org_budget_blocked` classification so the run is checkpointed like any
  // other policy-ceiling stop.
  checkBudgetBlocked?: () => Promise<boolean>
  // Optional real-compaction hook. Called BETWEEN iterations only (every tool
  // wrapper of the previous batch has settled), with the current transcript and
  // the rebuild target. Returning null means "compaction unavailable" and the
  // loop falls back to emergency truncation.
  compactContext?: (input: {
    messages: ProviderMessage[]
    targetTokens: number
  }) => Promise<ProviderMessage[] | null>
  // Compaction/trim thresholds for this run's model (see context-window.ts).
  contextPlan?: ContextPlan
  executeTool: ExecuteToolFn
  /** Optional authorization preflight that can suspend a whole tool batch. */
  prepareTool?: PrepareToolFn
  initialMessages: ProviderMessage[]
  // Optional caller-owned accumulator for every inference invocation the loop
  // makes. It is populated live (before the loop can throw), so a crashed or
  // aborted run's partial token spend is still attributable — the caller reads
  // this array on the failure path even when no LoopResult is returned.
  invocationSink?: InvocationRecord[]
  /**
   * Optional capture of the tool results produced since the previous
   * inference call, passed as an out-param so callers that bound context to
   * their inference function (delegate sub-agents) can observe how each
   * nested tool call resolved.
   */
  runInference: (
    messages: ProviderMessage[],
    captured?: { toolResults: ExecutedToolResult[] },
  ) => Promise<InferenceResult>
  toolTimeoutError?: (toolName: string) => Error | null
  tools: ToolSchemaDescriptor[]
  // Wind-down (spec §3a): when set, crossing WIND_DOWN_FRACTION of any budget
  // dimension injects this as a one-time system message so the model can finish
  // and hand over inside the remaining slice. Absent for delegate sub-agents
  // (tiny budgets, digest-shaped output) and DeepWater handoff turns.
  windDownInstruction?: string
  // Fired once, when the wind-down instruction is injected — the caller closes
  // structural fan-out (the delegate gate) for the rest of the run.
  onWindDown?: () => void
}): Promise<LoopResult> => {
  const { budget, callbacks, executeTool, initialMessages, prepareTool } = input
  const cacheReadWeight = input.cacheReadWeight ?? DEFAULT_CACHE_READ_WEIGHT
  // Covers every caller, including delegated agents whose initial prompt does
  // not pass through buildModelPrompt. Raw values never remain in the loop's
  // retained context or its eventual checkpoint input.
  const messages: ProviderMessage[] = initialMessages.map(redactProviderMessage)
  const allInvocations: InvocationRecord[] = input.invocationSink ?? []
  const signatureCounts = new Map<string, number>()
  const retryBudget = createRetryBudget(6)
  const toolSchemaTokens = estimateToolSchemaTokens(input.tools)
  const circuitBreaker = new ToolCircuitBreaker()
  const contextPlan = input.contextPlan
    ?? buildContextPlan({ model: null, toolSchemaTokens })
  const compactionGovernor = createCompactionGovernor(contextPlan)

  let iterations = 0
  let toolCallsUsed = 0
  let pendingToolResults: ExecutedToolResult[] | null = null
  let totalToolMs = 0
  let spend: SpendTotals = ZERO_SPEND
  let woundDown = false
  // The most recent assistant text seen. On a budget-cap stop this is the run's
  // partial answer: the caller surfaces it (with a "stopped at the limit"
  // notice) instead of posting nothing, so a capped run is never silent.
  let lastAssistantText = ''
  const startTime = Date.now()

  const elapsed = (): number => Date.now() - startTime

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
  const maintainContext = async (iteration: number): Promise<void> => {
    // The plan's thresholds already exclude the tool schemas, so only the
    // transcript is measured against them.
    const transcriptTokens = estimateMessagesTokens(messages)
    if (!compactionGovernor.shouldAttempt({ iteration, transcriptTokens })) return
    compactionGovernor.recordAttempt(iteration)
    const compacted = input.compactContext
      ? await input
        .compactContext({ messages, targetTokens: contextPlan.targetTokens })
        .catch(() => null)
      : null
    const rebuilt = compacted ?? trimConversationToFit(messages, contextPlan.targetTokens)
    messages.length = 0
    messages.push(...rebuilt.map(redactProviderMessage))
  }

  while (true) {
    if (await cancellationRequested()) {
      return finish(null, lastAssistantText, true)
    }

    // Wind-down first, stop second: on the iteration where the 80% band is
    // entered the harder 90% boundary has not tripped yet, so the model gets
    // the remaining slice to finish and hand over on its own terms.
    if (input.windDownInstruction && !woundDown && shouldWindDown(budget, {
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

    iterations += 1
    await callbacks.onIterationStart(iterations)

    await maintainContext(iterations)

    // Measured after compaction, so the gate judges the context that will
    // actually be sent rather than the one that was about to be folded away.
    const preInferenceStop = stopBeforeInference(budget, {
      effectiveTokensUsed: spend.effectiveTokensUsed,
      projectedCallTokens: estimateMessagesTokens(messages) + toolSchemaTokens,
    })
    if (preInferenceStop) return stop(preInferenceStop)

    const captured = pendingToolResults
      ? { toolResults: pendingToolResults }
      : undefined
    pendingToolResults = null
    const result = await callInferenceWithRetry(
      messages,
      (inferenceMessages) => input.runInference(inferenceMessages, captured),
      retryBudget,
      contextPlan.targetTokens,
    )
    allInvocations.push(...result.invocations)
    spend = meterSpend(allInvocations, cacheReadWeight)
    const safeOutputText = redactDetectedSecrets(result.outputText)
    if (safeOutputText) {
      lastAssistantText = safeOutputText
    }

    const spendStop = stopAfterInference(budget, spend)
    if (spendStop) return stop(spendStop)

    if (!result.toolCalls || result.toolCalls.length === 0) {
      if (safeOutputText) {
        await callbacks.onTextDelta(safeOutputText)
      }
      return finish(null, safeOutputText)
    }

    const safeToolCalls = sanitizeProviderToolCalls(result.toolCalls)
    const blockedToolCallIds = new Set(
      safeToolCalls
        .filter((toolCall) => toolCall.secretArgumentBlocked)
        .map((toolCall) => toolCall.toolCallId),
    )

    messages.push({
      content: safeOutputText || null,
      role: 'assistant',
      toolCalls: safeToolCalls,
    })

    const batch = await executeToolBatch({
      callbacks,
      circuitBreaker,
      executeTool,
      prepareTool: async (toolName, args, toolCallId) => {
        if (blockedToolCallIds.has(toolCallId)) {
          return {
            kind: 'execute' as const,
            execute: async () => ({
              inputSummary: summarizeToolInput(args),
              output: 'Tool call blocked because its arguments contained a possible credential. Ask the user to save it through the secure form and retry with a secret reference.',
              success: false,
            }),
          }
        }
        return prepareTool
          ? prepareTool(toolName, args, toolCallId)
          : {
            kind: 'execute' as const,
            execute: () => executeTool(toolName, args, toolCallId),
          }
      },
      signatureCounts,
      toolCalls: safeToolCalls,
      toolTimeoutError: input.toolTimeoutError,
      toolTimeoutMs: budget.toolTimeoutMs,
    })
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
