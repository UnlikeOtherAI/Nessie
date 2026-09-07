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
  onCheckpoint?: (state: LoopResumeState) => Promise<void>
}

export type LoopResult = {
  finalText: string
  iterations: number
  messages: ProviderMessage[]
  toolCallsUsed: number
  toolMs: number
  totalCostCents: number
  wallclockMs: number
  totalTokensUsed: number
  effectiveTokensUsed: number
  cacheReadTokens: number
  exhaustedBudget: BudgetExhaustionReason | null
  pendingApproval?: ToolApprovalSuspension | null
  pendingInput?: AgentCardSuspension | null
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
  contextPlan?: ContextPlan
  executeTool: ExecuteToolFn
  prepareTool?: PrepareToolFn
  initialMessages: ProviderMessage[]
  invocationSink?: InvocationRecord[]
  runInference: (
    messages: ProviderMessage[],
    captured?: { toolResults: ExecutedToolResult[] },
    options?: { maxOutputTokens?: number; noTools?: boolean },
  ) => Promise<InferenceResult>
  toolTimeoutError?: (toolName: string) => Error | null
  tools: ToolSchemaDescriptor[]
  windDownInstruction?: string
  onWindDown?: () => void
  drainSignal?: AbortSignal
  resume?: LoopResumeState
  maxOutputTokens?: number
}
