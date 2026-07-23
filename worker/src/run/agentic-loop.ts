import type {
  ConnectorUsage,
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ProviderToolCall,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import {
  classifyError,
  resolveRecovery,
  createRetryBudget,
  type RetryBudget,
} from './error-classification.js'
import {
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  trimConversationToFit,
} from './context-management.js'
import type { AgentEffort } from '@nessie/schemas'
import { ToolCircuitBreaker } from './circuit-breaker.js'
import { isFatalToolExecutionError } from './tool-execution-errors.js'
import { summarizeToolInput, truncateToolResult } from './tool-util.js'

export type BudgetLimits = {
  maxIterations: number
  maxToolCalls: number
  maxWallclockMs: number
  maxTokens?: number
  maxCostCents?: number
  toolTimeoutMs?: number
}

const TOOL_TIMEOUT_MS = 75_000

// Per-agent run budget, scaled by the agent's effort level (see AgentEffort).
// `medium` is the historical default. `xhigh` is effectively unbounded: the
// org/team `Budget` gate and the loop's repeated-tool-call detection remain the
// only governors. `toolTimeoutMs` is identical across levels.
export const EFFORT_BUDGETS: Record<AgentEffort, BudgetLimits> = {
  low: {
    maxIterations: 8,
    maxToolCalls: 12,
    maxWallclockMs: 60_000,
    maxTokens: 30_000,
    maxCostCents: 25,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  },
  medium: {
    maxIterations: 12,
    maxToolCalls: 20,
    maxWallclockMs: 90_000,
    maxTokens: 50_000,
    maxCostCents: 50,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  },
  high: {
    maxIterations: 36,
    maxToolCalls: 60,
    maxWallclockMs: 600_000,
    maxTokens: 200_000,
    maxCostCents: 500,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  },
  xhigh: {
    maxIterations: 10_000,
    maxToolCalls: 20_000,
    maxWallclockMs: 4 * 60 * 60 * 1_000,
    maxTokens: Number.MAX_SAFE_INTEGER,
    maxCostCents: Number.MAX_SAFE_INTEGER,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  },
}

export const budgetForEffort = (effort: AgentEffort): BudgetLimits =>
  EFFORT_BUDGETS[effort]

export type BudgetExhaustionReason =
  | 'cost'
  | 'iterations'
  | 'loop_detected'
  | 'tokens'
  | 'tool_calls'
  | 'wallclock'

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
  ) => Promise<void>
  onTextDelta: (delta: string) => Promise<void>
  onBudgetExhausted: (reason: BudgetExhaustionReason) => Promise<void>
}

export type LoopResult = {
  finalText: string
  iterations: number
  toolCallsUsed: number
  // Aggregate wall-clock time spent inside tool executions. Tools within one
  // iteration run concurrently (Promise.allSettled), so this sums per-tool
  // spans and can exceed `wallclockMs` — it measures tool work, not a span.
  toolMs: number
  totalCostCents: number
  wallclockMs: number
  totalTokensUsed: number
  exhaustedBudget: BudgetExhaustionReason | null
  // True when the loop exited because a cooperative cancel was observed (via
  // `checkCancelled`) between iterations or after a tool-call batch, rather than
  // because the model finished or a budget cap tripped. `finalText` then holds
  // whatever partial answer was produced so the caller can still deliver it.
  cancelled: boolean
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

const sumTokens = (invocations: InvocationRecord[]): number =>
  invocations.reduce((sum, inv) => sum + (inv.usage.totalTokens ?? 0), 0)

const sumCostCents = (invocations: InvocationRecord[]): number =>
  invocations.reduce((sum, inv) => {
    if (inv.providerReportedCost?.currency.toUpperCase() !== 'USD') {
      return sum
    }
    return sum + Math.round(inv.providerReportedCost.amount * 100)
  }, 0)

const CONTEXT_BUDGET_TOKENS = 100_000
const CONTEXT_TRIM_THRESHOLD = 0.85
const CONTEXT_TRIM_TARGET = 0.75
const MAX_COMPACTION_ATTEMPTS = 2

const callInferenceWithRetry = async (
  messages: ProviderMessage[],
  runInference: (msgs: ProviderMessage[]) => Promise<InferenceResult>,
  retryBudget: RetryBudget,
): Promise<InferenceResult> => {
  let lastError: unknown
  let compactionAttempts = 0

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await runInference(messages)
    } catch (error) {
      lastError = error
      const reason = classifyError(error)
      const recovery = resolveRecovery(reason, attempt, retryBudget)

      if (recovery.action === 'retry') {
        retryBudget.remaining -= 1
        await new Promise((resolve) => setTimeout(resolve, recovery.delayMs))
        continue
      }

      if (recovery.action === 'compact_and_retry') {
        if (compactionAttempts >= MAX_COMPACTION_ATTEMPTS) {
          throw new Error('Context overflow: unable to compact messages further')
        }
        compactionAttempts += 1
        const trimmed = trimConversationToFit(messages, Math.floor(CONTEXT_BUDGET_TOKENS * 0.6))
        messages.length = 0
        messages.push(...trimmed)
        continue
      }

      if (recovery.action === 'surface_error') {
        return {
          correlationId: undefined,
          finishReason: 'error',
          invocations: [],
          model: '',
          outputText: recovery.userMessage,
          provider: 'openai',
          requestId: '',
          toolCalls: [],
        }
      }

      throw error
    }
  }

  throw lastError
}

export const runAgenticLoop = async (input: {
  budget: BudgetLimits
  callbacks: LoopCallbacks
  // Optional cooperative-cancel probe. Consulted between iterations and after
  // each tool-call batch; when it resolves `true` the loop stops immediately and
  // returns a `cancelled` result carrying any partial answer. Kept side-effect
  // free (a cheap status read) — the caller owns terminalization and notices.
  checkCancelled?: () => Promise<boolean>
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
}): Promise<LoopResult> => {
  const { budget, callbacks, executeTool, initialMessages } = input
  const messages: ProviderMessage[] = [...initialMessages]
  const allInvocations: InvocationRecord[] = input.invocationSink ?? []
  const signatureCounts = new Map<string, number>()
  const retryBudget = createRetryBudget(6)
  const toolSchemaTokens = estimateToolSchemaTokens(input.tools)
  const circuitBreaker = new ToolCircuitBreaker()

  let iterations = 0
  let toolCallsUsed = 0
  let totalToolMs = 0
  let totalCostCents = 0
  let totalTokensUsed = 0
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
    cancelled,
    exhaustedBudget,
    finalText,
    invocations: allInvocations,
    iterations,
    toolCallsUsed,
    toolMs: totalToolMs,
    totalCostCents,
    totalTokensUsed,
    wallclockMs: elapsed(),
  })

  // A cooperative-cancel probe. Between iterations and after each tool batch the
  // loop asks whether a cancel was requested; if so it stops with any partial
  // answer already captured in `lastAssistantText`.
  const cancellationRequested = async (): Promise<boolean> =>
    input.checkCancelled ? input.checkCancelled() : false

  while (iterations < budget.maxIterations) {
    if (await cancellationRequested()) {
      return finish(null, lastAssistantText, true)
    }

    if (elapsed() >= budget.maxWallclockMs) {
      await callbacks.onBudgetExhausted('wallclock')
      return finish('wallclock')
    }

    iterations += 1
    await callbacks.onIterationStart(iterations)

    const currentTokens = estimateMessagesTokens(messages)
    if (currentTokens + toolSchemaTokens > CONTEXT_BUDGET_TOKENS * CONTEXT_TRIM_THRESHOLD) {
      const trimmed = trimConversationToFit(
        messages,
        Math.floor(CONTEXT_BUDGET_TOKENS * CONTEXT_TRIM_TARGET),
        toolSchemaTokens,
      )
      messages.length = 0
      messages.push(...trimmed)
    }

    const result = await callInferenceWithRetry(messages, input.runInference, retryBudget)
    allInvocations.push(...result.invocations)
    totalCostCents = sumCostCents(allInvocations)
    totalTokensUsed = sumTokens(allInvocations)
    if (result.outputText) {
      lastAssistantText = result.outputText
    }

    if (budget.maxTokens && totalTokensUsed >= budget.maxTokens) {
      await callbacks.onBudgetExhausted('tokens')
      return finish('tokens')
    }

    if (budget.maxCostCents && totalCostCents >= budget.maxCostCents) {
      await callbacks.onBudgetExhausted('cost')
      return finish('cost')
    }

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

    if (toolCallsUsed >= budget.maxToolCalls) {
      await callbacks.onBudgetExhausted('tool_calls')
      return finish('tool_calls')
    }

    // Cooperative cancel between tool-call batches: the just-completed tools have
    // been recorded and their results incorporated, so stopping here is clean.
    if (await cancellationRequested()) {
      return finish(null, lastAssistantText, true)
    }

    if (elapsed() >= budget.maxWallclockMs) {
      await callbacks.onBudgetExhausted('wallclock')
      return finish('wallclock')
    }
  }

  await callbacks.onBudgetExhausted('iterations')
  return finish('iterations')
}
