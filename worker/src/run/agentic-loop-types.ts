import type {
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import type { BudgetExhaustionReason, BudgetLimits } from './loop-budget.js'
import type { LoopResumeState } from './loop-resume.js'
import type { ContextPlan } from './context-window.js'
import type {
  AgentCardSuspension,
  ExecuteToolFn,
  ExecutedToolResult,
  PrepareToolFn,
  ToolApprovalSuspension,
  ToolBatchCallbacks,
} from './tool-batch.js'

export type LoopCallbacks = ToolBatchCallbacks & {
  onIterationStart: (iteration: number) => Promise<void>
  onTextDelta: (delta: string) => Promise<void>
  onBudgetExhausted: (reason: BudgetExhaustionReason) => Promise<void>
  /** Offered only at transcript-consistent boundaries for durable crash resume. */
  onCheckpoint?: (state: LoopResumeState) => Promise<void>
}

export type LoopResult = {
  finalText: string
  iterations: number
  /** Transcript retained for the model-authored budget checkpoint. */
  messages: ProviderMessage[]
  toolCallsUsed: number
  toolMs: number
  totalCostCents: number
  wallclockMs: number
  totalTokensUsed: number
  /** Input + output + discounted cache reads: every token verdict uses this. */
  effectiveTokensUsed: number
  cacheReadTokens: number
  exhaustedBudget: BudgetExhaustionReason | null
  /** A provider success remained empty after the loop's bounded recovery. */
  incompleteReason?: 'empty_provider_response' | 'provider_output_limit' | null
  pendingApproval?: ToolApprovalSuspension | null
  pendingInput?: AgentCardSuspension | null
  /** Cooperative cancellation keeps any partial answer without a budget stop. */
  cancelled: boolean
  woundDown: boolean
  invocations: InvocationRecord[]
}

export type AgenticLoopInput = {
  budget: BudgetLimits
  cacheReadWeight?: number
  callbacks: LoopCallbacks
  checkCancelled?: () => Promise<boolean>
  checkBudgetBlocked?: () => Promise<boolean>
  compactContext?: (input: {
    messages: ProviderMessage[]
    targetTokens: number
  }) => Promise<ProviderMessage[] | null>
  /** Model-window plan; the loop compacts before retained context crowds out output. */
  contextPlan?: ContextPlan
  /** Tools a batch dispatches one after another; see `executeToolBatch`. */
  dispatchesInOrder?: (toolName: string) => boolean
  executeTool: ExecuteToolFn
  prepareTool?: PrepareToolFn
  initialMessages: ProviderMessage[]
  invocationSink?: InvocationRecord[]
  runInference: (
    messages: ProviderMessage[],
    captured?: { toolResults: ExecutedToolResult[] },
    options?: { maxOutputTokens?: number; noTools?: boolean },
  ) => Promise<InferenceResult>
  toolTimeoutError?: (toolName: string, toolCallId: string) => Error | null
  /** A tool's own timeout; undefined keeps `budget.toolTimeoutMs`. */
  toolTimeoutMsFor?: (toolName: string) => number | undefined
  tools: ToolSchemaDescriptor[]
  windDownInstruction?: string
  onWindDown?: () => void
  drainSignal?: AbortSignal
  /** Machine checkpoint from the same run; restored calls are never re-dispatched. */
  resume?: LoopResumeState
  maxOutputTokens?: number
}
