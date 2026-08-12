import type {
  ConnectorUsage,
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ProviderToolCall,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
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
import { isFatalToolExecutionError } from './tool-execution-errors.js'
import { summarizeToolInput, truncateToolResult } from './tool-util.js'

export type { BudgetExhaustionReason, BudgetLimits } from './loop-budget.js'

export type LoopCallbacks = {
  onIterationStart: (iteration: number) => Promise<void>
  onToolCallStart: (toolName: string, args: Record<string, unknown>) => Promise<void>
  onToolCallEnd: (
    toolName: string,
    result: string,
    durationMs: number,
    success: boolean,
    inputSummary: string,
    startedAt: Date,
    connectorUsage?: ConnectorUsage,
    toolCallRecordId?: string,
  ) => Promise<void>
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
  // Aggregate wall-clock time spent inside tool executions. Tools within one
  // iteration run concurrently (Promise.allSettled), so this sums per-tool
  // spans and can exceed `wallclockMs` — it measures tool work, not a span.
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

type ExecuteToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
) => Promise<{
  acknowledgeDelivery?: () => void
  connectorUsage?: ConnectorUsage
  output: string
  success: boolean
  inputSummary: string
  toolCallRecordId?: string
}>

const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const LOOP_DETECTION_THRESHOLD = 3

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  timeoutError?: () => Error | null,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(
        timeoutError?.() ?? new Error(`${label} timed out after ${timeoutMs}ms`),
      ),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer!)
  }
}

const makeToolCallSignature = (
  name: string,
  args: Record<string, unknown>,
): string => name + ':' + JSON.stringify(args)

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
  initialMessages: ProviderMessage[]
  // Optional caller-owned accumulator for every inference invocation the loop
  // makes. It is populated live (before the loop can throw), so a crashed or
  // aborted run's partial token spend is still attributable — the caller reads
  // this array on the failure path even when no LoopResult is returned.
  invocationSink?: InvocationRecord[]
  runInference: (messages: ProviderMessage[]) => Promise<InferenceResult>
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
  const { budget, callbacks, executeTool, initialMessages } = input
  const cacheReadWeight = input.cacheReadWeight ?? DEFAULT_CACHE_READ_WEIGHT
  const messages: ProviderMessage[] = [...initialMessages]
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
  ): LoopResult => ({
    cacheReadTokens: spend.cacheReadTokens,
    cancelled,
    effectiveTokensUsed: spend.effectiveTokensUsed,
    exhaustedBudget,
    finalText,
    invocations: allInvocations,
    iterations,
    messages,
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
    messages.push(...rebuilt)
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

    const result = await callInferenceWithRetry(
      messages,
      input.runInference,
      retryBudget,
      contextPlan.targetTokens,
    )
    allInvocations.push(...result.invocations)
    spend = meterSpend(allInvocations, cacheReadWeight)
    if (result.outputText) {
      lastAssistantText = result.outputText
    }

    const spendStop = stopAfterInference(budget, spend)
    if (spendStop) return stop(spendStop)

    if (!result.toolCalls || result.toolCalls.length === 0) {
      if (result.outputText) {
        await callbacks.onTextDelta(result.outputText)
      }
      return finish(null, result.outputText)
    }

    messages.push({
      content: result.outputText || null,
      role: 'assistant',
      toolCalls: result.toolCalls,
    })

    let loopDetected = false

    const toolOutcomes = await Promise.allSettled(
      result.toolCalls.map(async (tc: ProviderToolCall) => {
        const sig = makeToolCallSignature(tc.toolName, tc.arguments)
        const count = (signatureCounts.get(sig) ?? 0) + 1
        signatureCounts.set(sig, count)

        if (count >= LOOP_DETECTION_THRESHOLD) {
          loopDetected = true
          return {
            output: 'Tool call loop detected — this exact call has been repeated too many times. Try a different approach.',
            success: false,
            inputSummary: summarizeToolInput(tc.arguments),
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          }
        }

        if (circuitBreaker.isTripped(tc.toolName)) {
          return {
            output: circuitBreaker.trippedErrorMessage(tc.toolName),
            success: false,
            inputSummary: summarizeToolInput(tc.arguments),
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          }
        }

        await callbacks.onToolCallStart(tc.toolName, tc.arguments)
        const startedAt = new Date()

        try {
          const toolResult = await withTimeout(
            executeTool(tc.toolName, tc.arguments, tc.toolCallId),
            budget.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
            tc.toolName,
            () => input.toolTimeoutError?.(tc.toolName) ?? null,
          )
          const durationMs = Date.now() - startedAt.getTime()
          totalToolMs += durationMs
          if (toolResult.success) {
            circuitBreaker.recordSuccess(tc.toolName)
          } else {
            circuitBreaker.recordError(tc.toolName)
          }
          await callbacks.onToolCallEnd(
            tc.toolName,
            toolResult.output,
            durationMs,
            toolResult.success,
            toolResult.inputSummary,
            startedAt,
            toolResult.connectorUsage,
            toolResult.toolCallRecordId,
          )
          return { ...toolResult, toolCallId: tc.toolCallId, toolName: tc.toolName }
        } catch (error) {
          const fatal = isFatalToolExecutionError(error)
          const errorMsg = fatal
            ? 'Tool execution could not be confirmed; retrying safely.'
            : error instanceof Error ? error.message : 'Tool execution failed'
          circuitBreaker.recordError(tc.toolName)
          const durationMs = Date.now() - startedAt.getTime()
          totalToolMs += durationMs
          try {
            await callbacks.onToolCallEnd(
              tc.toolName,
              errorMsg,
              durationMs,
              false,
              summarizeToolInput(tc.arguments),
              startedAt,
              undefined,
              error instanceof Error
                && typeof (error as Error & { toolCallRecordId?: unknown }).toolCallRecordId === 'string'
                ? (error as Error & { toolCallRecordId: string }).toolCallRecordId
                : undefined,
            )
          } catch (callbackError) {
            if (!fatal) throw callbackError
          }
          if (fatal) throw error
          return {
            output: errorMsg,
            success: false,
            inputSummary: summarizeToolInput(tc.arguments),
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          }
        }
      }),
    )
    const rejectedTool = toolOutcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected' && isFatalToolExecutionError(outcome.reason),
    ) ?? toolOutcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    if (rejectedTool) throw rejectedTool.reason
    const toolResults = toolOutcomes.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason
      return outcome.value
    })

    toolCallsUsed += toolResults.length

    for (const tr of toolResults) {
      // Single truncation chokepoint: every tool result — builtin, MCP, and
      // `delegate` sub-agent output — is capped here before it enters context.
      // Builtins pre-truncate in `tools.ts` (idempotent: the marker is
      // detected and not re-applied); MCP and delegate results have no other
      // cap, so this is what bounds them (audit F1).
      messages.push({
        content: truncateToolResult(tr.output),
        role: 'tool',
        toolCallId: tr.toolCallId,
      })
      tr.acknowledgeDelivery?.()
    }

    if (loopDetected) {
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
