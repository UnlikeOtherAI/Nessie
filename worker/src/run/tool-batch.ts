import type { ConnectorUsage, ProviderToolCall } from '@nessie/runtime'
import { ToolCircuitBreaker } from './circuit-breaker.js'
import { isFatalToolExecutionError } from './tool-execution-errors.js'
import { summarizeToolInput } from './tool-util.js'

export type ToolApprovalSuspension = {
  approvalId: string
  notice: string
  toolName: string
}

export type AgentCardSuspension = {
  cardId: string
}

export type ExecutedToolResult = {
  acknowledgeDelivery?: () => void
  connectorUsage?: ConnectorUsage
  inputSummary: string
  output: string
  pendingApproval?: ToolApprovalSuspension
  pendingInput?: AgentCardSuspension
  success: boolean
  toolCallId?: string
  toolCallRecordId?: string
  toolName?: string
}

export type ToolBatchCallbacks = {
  onToolCallStart: (toolName: string, args: Record<string, unknown>) => Promise<void>
  onToolCallEnd: (
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    durationMs: number,
    success: boolean,
    inputSummary: string,
    startedAt: Date,
    connectorUsage?: ConnectorUsage,
    toolCallRecordId?: string,
  ) => Promise<void>
}

export type ExecuteToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
) => Promise<ExecutedToolResult>

export type PreparedToolExecution =
  | {
      kind: 'execute'
      execute: () => Promise<ExecutedToolResult>
    }
  | {
      approval: ToolApprovalSuspension
      kind: 'suspend'
    }

/**
 * Authorize a call without dispatching it. A suspension is a batch barrier:
 * no prepared execution may run once a gate has been found.
 */
export type PrepareToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
) => Promise<PreparedToolExecution>

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
      () => reject(timeoutError?.() ?? new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer!)
  }
}

const toolCallSignature = (name: string, args: Record<string, unknown>): string =>
  `${name}:${JSON.stringify(args)}`

type RunnableToolCall = {
  index: number
  toolCall: ProviderToolCall
}

export const executeToolBatch = async (input: {
  callbacks: ToolBatchCallbacks
  circuitBreaker: ToolCircuitBreaker
  executeTool: ExecuteToolFn
  prepareTool?: PrepareToolFn
  signatureCounts: Map<string, number>
  toolCalls: ProviderToolCall[]
  toolTimeoutError?: (toolName: string) => Error | null
  toolTimeoutMs?: number
}): Promise<{
  loopDetected: boolean
  pendingApproval: ToolApprovalSuspension | null
  pendingInput: AgentCardSuspension | null
  results: ExecutedToolResult[]
  toolMs: number
}> => {
  let loopDetected = false
  let toolMs = 0
  const resultSlots: Array<ExecutedToolResult | undefined> = []
  const runnable: RunnableToolCall[] = []

  for (const [index, toolCall] of input.toolCalls.entries()) {
    const signature = toolCallSignature(toolCall.toolName, toolCall.arguments)
    const count = (input.signatureCounts.get(signature) ?? 0) + 1
    input.signatureCounts.set(signature, count)

    if (count >= LOOP_DETECTION_THRESHOLD) {
      loopDetected = true
      resultSlots[index] = {
        inputSummary: summarizeToolInput(toolCall.arguments),
        output: 'Tool call loop detected — this exact call has been repeated too many times. Try a different approach.',
        success: false,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }
      continue
    }
    if (input.circuitBreaker.isTripped(toolCall.toolName)) {
      resultSlots[index] = {
        inputSummary: summarizeToolInput(toolCall.arguments),
        output: input.circuitBreaker.trippedErrorMessage(toolCall.toolName),
        success: false,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }
      continue
    }

    runnable.push({ index, toolCall })
  }

  const prepared: Array<RunnableToolCall & { execute: () => Promise<ExecutedToolResult> }> = []
  for (const call of runnable) {
    let preparation: PreparedToolExecution
    try {
      preparation = input.prepareTool
        ? await input.prepareTool(call.toolCall.toolName, call.toolCall.arguments, call.toolCall.toolCallId)
        : {
          kind: 'execute',
          execute: () => input.executeTool(
            call.toolCall.toolName,
            call.toolCall.arguments,
            call.toolCall.toolCallId,
          ),
        }
    } catch (error) {
      preparation = {
        kind: 'execute',
        execute: async () => { throw error },
      }
    }

    if (preparation.kind === 'suspend') {
      resultSlots[call.index] = {
        inputSummary: summarizeToolInput(call.toolCall.arguments),
        output: 'Tool execution is waiting for human approval.',
        pendingApproval: preparation.approval,
        success: false,
        toolCallId: call.toolCall.toolCallId,
        toolName: call.toolCall.toolName,
      }
      return {
        loopDetected,
        pendingApproval: preparation.approval,
        pendingInput: null,
        results: resultSlots.filter((result): result is ExecutedToolResult => result !== undefined),
        toolMs,
      }
    }
    prepared.push({ ...call, execute: preparation.execute })
  }

  const settled = await Promise.allSettled(prepared.map(async ({ execute, toolCall }) => {
    await input.callbacks.onToolCallStart(toolCall.toolName, toolCall.arguments)
    const startedAt = new Date()
    try {
      const result = await withTimeout(
        execute(),
        input.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        toolCall.toolName,
        () => input.toolTimeoutError?.(toolCall.toolName) ?? null,
      )
      const durationMs = Date.now() - startedAt.getTime()
      toolMs += durationMs
      if (!result.pendingApproval) {
        if (result.success) {
          input.circuitBreaker.recordSuccess(toolCall.toolName)
        } else {
          input.circuitBreaker.recordError(toolCall.toolName)
        }
      }
      await input.callbacks.onToolCallEnd(
        toolCall.toolName,
        toolCall.arguments,
        result.output,
        durationMs,
        result.success,
        result.inputSummary,
        startedAt,
        result.connectorUsage,
        result.toolCallRecordId,
      )
      return { ...result, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName }
    } catch (error) {
      const fatal = isFatalToolExecutionError(error)
      const output = fatal
        ? 'Tool execution could not be confirmed; retrying safely.'
        : error instanceof Error ? error.message : 'Tool execution failed'
      input.circuitBreaker.recordError(toolCall.toolName)
      const durationMs = Date.now() - startedAt.getTime()
      toolMs += durationMs
      try {
        await input.callbacks.onToolCallEnd(
          toolCall.toolName,
          toolCall.arguments,
          output,
          durationMs,
          false,
          summarizeToolInput(toolCall.arguments),
          startedAt,
          undefined,
          error instanceof Error && typeof (error as Error & { toolCallRecordId?: unknown }).toolCallRecordId === 'string'
            ? (error as Error & { toolCallRecordId: string }).toolCallRecordId
            : undefined,
        )
      } catch (callbackError) {
        if (!fatal) throw callbackError
      }
      if (fatal) throw error
      return {
        inputSummary: summarizeToolInput(toolCall.arguments),
        output,
        success: false,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }
    }
  }))

  const fatalRejection = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && isFatalToolExecutionError(result.reason),
  )
  if (fatalRejection) throw fatalRejection.reason

  const rejection = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejection) throw rejection.reason

  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      resultSlots[prepared[index]!.index] = result.value
    }
  }
  const results = resultSlots.filter((result): result is ExecutedToolResult => result !== undefined)
  const pending = results.find((result) => result.pendingApproval)?.pendingApproval ?? null
  const pendingInput = results.find((result) => result.pendingInput)?.pendingInput ?? null
  return { loopDetected, pendingApproval: pending, pendingInput, results, toolMs }
}
