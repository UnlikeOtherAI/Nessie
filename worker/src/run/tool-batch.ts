import type { ConnectorUsage, ProviderToolCall } from '@nessie/runtime'
import { ToolCircuitBreaker } from './circuit-breaker.js'
import { isFatalToolExecutionError } from './tool-execution-errors.js'
import { summarizeToolInput } from './tool-util.js'

export type ToolApprovalSuspension = {
  approvalId: string
  toolName: string
}

export type ExecutedToolResult = {
  acknowledgeDelivery?: () => void
  connectorUsage?: ConnectorUsage
  inputSummary: string
  output: string
  pendingApproval?: ToolApprovalSuspension
  success: boolean
  toolCallId?: string
  toolCallRecordId?: string
  toolName?: string
}

export type ToolBatchCallbacks = {
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
}

export type ExecuteToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
) => Promise<ExecutedToolResult>

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

/**
 * Run a provider tool-call batch in order. Normal batches used to fan out in
 * parallel, but a suspend is a durable control-flow boundary: once a human
 * gate is reached no later call in that provider batch may execute before the
 * model has replanned after the approval. The order also makes the first gate
 * deterministic when a model emits more than one gated call at once.
 */
export const executeToolBatch = async (input: {
  callbacks: ToolBatchCallbacks
  circuitBreaker: ToolCircuitBreaker
  executeTool: ExecuteToolFn
  signatureCounts: Map<string, number>
  toolCalls: ProviderToolCall[]
  toolTimeoutError?: (toolName: string) => Error | null
  toolTimeoutMs?: number
}): Promise<{
  loopDetected: boolean
  pendingApproval: ToolApprovalSuspension | null
  results: ExecutedToolResult[]
  toolMs: number
}> => {
  let loopDetected = false
  let toolMs = 0
  const results: ExecutedToolResult[] = []

  for (const toolCall of input.toolCalls) {
    const signature = toolCallSignature(toolCall.toolName, toolCall.arguments)
    const count = (input.signatureCounts.get(signature) ?? 0) + 1
    input.signatureCounts.set(signature, count)

    if (count >= LOOP_DETECTION_THRESHOLD) {
      loopDetected = true
      results.push({
        inputSummary: summarizeToolInput(toolCall.arguments),
        output: 'Tool call loop detected — this exact call has been repeated too many times. Try a different approach.',
        success: false,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      })
      continue
    }
    if (input.circuitBreaker.isTripped(toolCall.toolName)) {
      results.push({
        inputSummary: summarizeToolInput(toolCall.arguments),
        output: input.circuitBreaker.trippedErrorMessage(toolCall.toolName),
        success: false,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      })
      continue
    }

    await input.callbacks.onToolCallStart(toolCall.toolName, toolCall.arguments)
    const startedAt = new Date()
    try {
      const result = await withTimeout(
        input.executeTool(toolCall.toolName, toolCall.arguments, toolCall.toolCallId),
        input.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        toolCall.toolName,
        () => input.toolTimeoutError?.(toolCall.toolName) ?? null,
      )
      const durationMs = Date.now() - startedAt.getTime()
      toolMs += durationMs
      if (result.pendingApproval) {
        // The proposed call did not run, so it must not count as a tool error
        // or trip the breaker; it is recorded as the durable approval gate.
      } else if (result.success) {
        input.circuitBreaker.recordSuccess(toolCall.toolName)
      } else {
        input.circuitBreaker.recordError(toolCall.toolName)
      }
      await input.callbacks.onToolCallEnd(
        toolCall.toolName,
        result.output,
        durationMs,
        result.success,
        result.inputSummary,
        startedAt,
        result.connectorUsage,
        result.toolCallRecordId,
      )
      const completed = { ...result, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName }
      results.push(completed)
      if (completed.pendingApproval) {
        return {
          loopDetected,
          pendingApproval: completed.pendingApproval,
          results,
          toolMs,
        }
      }
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
      results.push({
        inputSummary: summarizeToolInput(toolCall.arguments),
        output,
        success: false,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      })
    }
  }

  return { loopDetected, pendingApproval: null, results, toolMs }
}
