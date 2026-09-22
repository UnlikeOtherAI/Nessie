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
  deliveredToConversation?: boolean
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
  /**
   * Aborted the moment the batch's per-call timeout fires. Optional because
   * executors that finish synchronously can ignore it, but any executor that
   * dials out must wire it to its request: the timeout arm only wins the
   * race, and without the abort the in-flight request lives on — the loop
   * reports a timeout while the socket stays held against the worker's pool,
   * and a mutating call the loop may retry can still complete underneath it.
   */
  signal?: AbortSignal,
) => Promise<ExecutedToolResult>

export type PreparedToolExecution =
  | {
      kind: 'execute'
      // Optional: executors that finish synchronously ignore it; any executor
      // that dials out must wire it to its request (see ExecuteToolFn).
      execute: (signal?: AbortSignal) => Promise<ExecutedToolResult>
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
  onTimeout?: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        // Settle the race with the timeout verdict FIRST: an executor that
        // fails synchronously on abort would otherwise win the race with its
        // own abort error, and the loop would record "aborted" rather than
        // the timeout it actually enforced.
        reject(timeoutError?.() ?? new Error(`${label} timed out after ${timeoutMs}ms`))
        // Then tell the losing promise, so its in-flight request is torn
        // down instead of living on against the worker's socket pool.
        onTimeout?.()
      },
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

type PreparedToolCall = RunnableToolCall & {
  execute: (signal?: AbortSignal) => Promise<ExecutedToolResult>
}

export const executeToolBatch = async (input: {
  callbacks: ToolBatchCallbacks
  circuitBreaker: ToolCircuitBreaker
  /**
   * Tools dispatched one after another, in call order, rather than beside the
   * rest of the batch. Executor commands share their machine's one command
   * lane, and each one's expiry runs from the moment it is created, so a batch
   * that dispatched three at once spent its own TTLs queueing behind itself.
   */
  dispatchesInOrder?: (toolName: string) => boolean
  executeTool: ExecuteToolFn
  prepareTool?: PrepareToolFn
  signatureCounts: Map<string, number>
  toolCalls: ProviderToolCall[]
  toolTimeoutError?: (toolName: string) => Error | null
  /** Each tool's own timeout; undefined keeps the batch default. */
  toolTimeoutMsFor?: (toolName: string) => number | undefined
}): Promise<{
  deliveredToConversation: boolean
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

  const prepared: PreparedToolCall[] = []
  for (const call of runnable) {
    let preparation: PreparedToolExecution
    try {
      preparation = input.prepareTool
        ? await input.prepareTool(call.toolCall.toolName, call.toolCall.arguments, call.toolCall.toolCallId)
        : {
          kind: 'execute',
          execute: (signal) => input.executeTool(
            call.toolCall.toolName,
            call.toolCall.arguments,
            call.toolCall.toolCallId,
            signal,
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
        deliveredToConversation: false,
        loopDetected,
        pendingApproval: preparation.approval,
        pendingInput: null,
        results: resultSlots.filter((result): result is ExecutedToolResult => result !== undefined),
        toolMs,
      }
    }
    prepared.push({ ...call, execute: preparation.execute })
  }

  const runPrepared = async ({ execute, toolCall }: PreparedToolCall): Promise<ExecutedToolResult> => {
    const timeoutMs = input.toolTimeoutMsFor?.(toolCall.toolName) ?? DEFAULT_TOOL_TIMEOUT_MS
    await input.callbacks.onToolCallStart(toolCall.toolName, toolCall.arguments)
    const startedAt = new Date()
    // One controller per call: the timeout arm aborts it, so a stalled
    // execution is cancelled rather than merely out-raced. A bare
    // `Promise.race` rejection leaves the losing promise running — orphaned
    // sockets accumulate against the worker's pool through a provider
    // brownout, and a retried mutating call can complete twice.
    const controller = new AbortController()
    try {
      const result = await withTimeout(
        execute(controller.signal),
        timeoutMs,
        toolCall.toolName,
        () => input.toolTimeoutError?.(toolCall.toolName) ?? null,
        () => controller.abort(),
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
  }

  // Only a fatal error or a failed callback rejects `runPrepared`, and either
  // one throws this batch. The in-order calls behind it are then never
  // dispatched: `then` passes the rejection along without running them, and a
  // replay dispatches them afresh because nothing ever claimed them.
  let inOrder: Promise<unknown> = Promise.resolve()
  const settled = await Promise.allSettled(prepared.map((call) => {
    if (!input.dispatchesInOrder?.(call.toolCall.toolName)) return runPrepared(call)
    const queued = inOrder.then(() => runPrepared(call))
    inOrder = queued
    return queued
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
  return {
    deliveredToConversation: results.some((result) => result.deliveredToConversation === true),
    loopDetected,
    pendingApproval: pending,
    pendingInput,
    results,
    toolMs,
  }
}
