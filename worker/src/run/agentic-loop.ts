import type {
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

export type BudgetLimits = {
  maxIterations: number
  maxToolCalls: number
  maxWallclockMs: number
  maxTokens?: number
  maxCostCents?: number
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxIterations: 12,
  maxToolCalls: 20,
  maxWallclockMs: 90_000,
  maxTokens: 50_000,
  maxCostCents: 50,
}

type BudgetExhaustionReason =
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
  ) => Promise<void>
  onTextDelta: (delta: string) => Promise<void>
  onBudgetExhausted: (reason: BudgetExhaustionReason) => Promise<void>
}

export type LoopResult = {
  finalText: string
  iterations: number
  toolCallsUsed: number
  totalCostCents: number
  wallclockMs: number
  totalTokensUsed: number
  exhaustedBudget: BudgetExhaustionReason | null
  invocations: InvocationRecord[]
}

type ExecuteToolFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ output: string; success: boolean; inputSummary: string }>

const TOOL_TIMEOUT_MS = 30_000
const LOOP_DETECTION_THRESHOLD = 3

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
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
  executeTool: ExecuteToolFn
  initialMessages: ProviderMessage[]
  runInference: (messages: ProviderMessage[]) => Promise<InferenceResult>
  tools: ToolSchemaDescriptor[]
}): Promise<LoopResult> => {
  const { budget, callbacks, executeTool, initialMessages } = input
  const messages: ProviderMessage[] = [...initialMessages]
  const allInvocations: InvocationRecord[] = []
  const signatureCounts = new Map<string, number>()
  const retryBudget = createRetryBudget(6)
  const toolSchemaTokens = estimateToolSchemaTokens(input.tools)

  let iterations = 0
  let toolCallsUsed = 0
  let totalCostCents = 0
  let totalTokensUsed = 0
  const startTime = Date.now()

  const elapsed = (): number => Date.now() - startTime

  while (iterations < budget.maxIterations) {
    if (elapsed() >= budget.maxWallclockMs) {
      await callbacks.onBudgetExhausted('wallclock')
      return {
        exhaustedBudget: 'wallclock',
        finalText: '',
        invocations: allInvocations,
        iterations,
        totalCostCents,
        toolCallsUsed,
        totalTokensUsed,
        wallclockMs: elapsed(),
      }
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

    if (budget.maxTokens && totalTokensUsed >= budget.maxTokens) {
      await callbacks.onBudgetExhausted('tokens')
      return {
        exhaustedBudget: 'tokens',
        finalText: '',
        invocations: allInvocations,
        iterations,
        totalCostCents,
        toolCallsUsed,
        totalTokensUsed,
        wallclockMs: elapsed(),
      }
    }

    if (budget.maxCostCents && totalCostCents >= budget.maxCostCents) {
      await callbacks.onBudgetExhausted('cost')
      return {
        exhaustedBudget: 'cost',
        finalText: '',
        invocations: allInvocations,
        iterations,
        totalCostCents,
        toolCallsUsed,
        totalTokensUsed,
        wallclockMs: elapsed(),
      }
    }

    if (!result.toolCalls || result.toolCalls.length === 0) {
      if (result.outputText) {
        await callbacks.onTextDelta(result.outputText)
      }
      return {
        exhaustedBudget: null,
        finalText: result.outputText,
        invocations: allInvocations,
        iterations,
        totalCostCents,
        toolCallsUsed,
        totalTokensUsed,
        wallclockMs: elapsed(),
      }
    }

    messages.push({
      content: result.outputText || null,
      role: 'assistant',
      toolCalls: result.toolCalls,
    })

    let loopDetected = false

    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc: ProviderToolCall) => {
        const sig = makeToolCallSignature(tc.toolName, tc.arguments)
        const count = (signatureCounts.get(sig) ?? 0) + 1
        signatureCounts.set(sig, count)

        if (count >= LOOP_DETECTION_THRESHOLD) {
          loopDetected = true
          return {
            output: 'Tool call loop detected — this exact call has been repeated too many times. Try a different approach.',
            success: false,
            inputSummary: JSON.stringify(tc.arguments).slice(0, 200),
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          }
        }

        await callbacks.onToolCallStart(tc.toolName, tc.arguments)
        const startedAt = new Date()

        try {
          const toolResult = await withTimeout(
            executeTool(tc.toolName, tc.arguments),
            TOOL_TIMEOUT_MS,
            tc.toolName,
          )
          const durationMs = Date.now() - startedAt.getTime()
          await callbacks.onToolCallEnd(
            tc.toolName,
            toolResult.output,
            durationMs,
            toolResult.success,
            toolResult.inputSummary,
            startedAt,
          )
          return { ...toolResult, toolCallId: tc.toolCallId, toolName: tc.toolName }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Tool execution failed'
          const durationMs = Date.now() - startedAt.getTime()
          await callbacks.onToolCallEnd(
            tc.toolName,
            errorMsg,
            durationMs,
            false,
            JSON.stringify(tc.arguments).slice(0, 200),
            startedAt,
          )
          return {
            output: errorMsg,
            success: false,
            inputSummary: JSON.stringify(tc.arguments).slice(0, 200),
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
          }
        }
      }),
    )

    toolCallsUsed += toolResults.length

    for (const tr of toolResults) {
      messages.push({
        content: tr.output,
        role: 'tool',
        toolCallId: tr.toolCallId,
      })
    }

    if (loopDetected) {
      messages.push({
        content: 'You are repeating the same tool call. Stop and produce a final answer with the information you already have.',
        role: 'user',
      })
    }

    if (toolCallsUsed >= budget.maxToolCalls) {
      await callbacks.onBudgetExhausted('tool_calls')
      return {
        exhaustedBudget: 'tool_calls',
        finalText: '',
        invocations: allInvocations,
        iterations,
        totalCostCents,
        toolCallsUsed,
        totalTokensUsed,
        wallclockMs: elapsed(),
      }
    }

    if (elapsed() >= budget.maxWallclockMs) {
      await callbacks.onBudgetExhausted('wallclock')
      return {
        exhaustedBudget: 'wallclock',
        finalText: '',
        invocations: allInvocations,
        iterations,
        totalCostCents,
        toolCallsUsed,
        totalTokensUsed,
        wallclockMs: elapsed(),
      }
    }
  }

  await callbacks.onBudgetExhausted('iterations')
  return {
    exhaustedBudget: 'iterations',
    finalText: '',
    invocations: allInvocations,
    iterations,
    totalCostCents,
    toolCallsUsed,
    totalTokensUsed,
    wallclockMs: elapsed(),
  }
}
