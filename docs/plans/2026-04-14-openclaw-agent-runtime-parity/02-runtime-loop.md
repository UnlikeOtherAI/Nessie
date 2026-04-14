# Runtime Loop

## Task 3: The Agentic Loop

**Why:** This is the single most impactful change. It transforms agents from chatbots into agents that can reason, act, observe, and iterate.

**OpenClaw parallel:** `runEmbeddedAttempt()` in `run/attempt.ts` — the iterative tool execution loop with budget tracking

**Files:**
- Create: `worker/src/run/agentic-loop.ts`
- Modify: `worker/src/run/execute.ts`

### Step 1: Create the agentic loop module

Create `worker/src/run/agentic-loop.ts`:

```typescript
import type { PrismaClient } from '@prisma/client'
import type {
  InferenceResult,
  ProviderMessage,
  ProviderToolCall,
  ToolSchemaDescriptor,
} from '@nessie/runtime'

// [v2] Added maxTokens and maxCostCents from docs/the-agents.md
export type BudgetLimits = {
  maxIterations: number        // default: 12
  maxToolCalls: number         // default: 20
  maxWallclockMs: number       // default: 90_000
  maxTokens?: number           // default: 50_000 (total input+output)
  maxCostCents?: number        // default: 50
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxIterations: 12,
  maxToolCalls: 20,
  maxWallclockMs: 90_000,
  maxTokens: 50_000,
  maxCostCents: 50,
}

export type LoopCallbacks = {
  onIterationStart: (iteration: number) => Promise<void>
  onToolCallStart: (toolName: string, args: Record<string, unknown>) => Promise<void>
  // [v3] Added inputSummary and startedAt — required by recordToolEnd
  onToolCallEnd: (toolName: string, result: string, durationMs: number, success: boolean, inputSummary: string, startedAt: Date) => Promise<void>
  onTextDelta: (delta: string) => Promise<void>
  onBudgetExhausted: (reason: BudgetExhaustionReason) => Promise<void>
}

type BudgetExhaustionReason = 'iterations' | 'tool_calls' | 'wallclock' | 'loop_detected'

export type LoopResult = {
  finalText: string
  iterations: number
  toolCallsUsed: number
  wallclockMs: number
  totalTokensUsed: number
  exhaustedBudget: BudgetExhaustionReason | null
  invocations: InvocationRecord[]
}

type ExecuteToolFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ output: string; success: boolean }>

// [v2] Per-tool timeout — prevents hung tools from blocking the loop
const TOOL_TIMEOUT_MS = 30_000

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer!)
  }
}

// [v2] Loop detection — detects repeated identical tool calls
type ToolCallSignature = string

const makeToolCallSignature = (name: string, args: Record<string, unknown>): ToolCallSignature =>
  `${name}:${JSON.stringify(args)}`

const LOOP_DETECTION_THRESHOLD = 3  // same call 3 times = loop

/**
 * The core agentic loop.
 *
 * For each iteration:
 *   1. Call the model with messages + tool schemas
 *   2. If the model returns a final text response → done
 *   3. If the model returns tool_calls → execute each, append results, continue
 *   4. If budget exhausted → return partial result
 *
 * [v2] Changes from v1:
 * - Uses callInferenceWithRetry (wired in, not orphaned)
 * - Per-tool timeout (30s default)
 * - Loop detection (repeated identical calls)
 * - Tool result truncation (via executeBuiltinTool)
 * - Handles finishReason: 'length' without tool calls
 * - Parallel tool execution within a single iteration
 * - Wallclock check AFTER tool execution, not just at iteration start
 * - Token budget tracking across iterations
 */
export const runAgenticLoop = async (input: {
  budget: BudgetLimits
  callbacks: LoopCallbacks
  executeTool: ExecuteToolFn
  initialMessages: ProviderMessage[]
  runInference: (messages: ProviderMessage[]) => Promise<InferenceResult>
  tools: ToolSchemaDescriptor[]
}): Promise<LoopResult> => {
  const { budget, callbacks, executeTool, tools } = input
  const messages: ProviderMessage[] = [...input.initialMessages]
  const allInvocations: InvocationRecord[] = []
  const startTime = Date.now()
  let iterations = 0
  let toolCallsUsed = 0
  let finalText = ''
  let totalTokensUsed = 0

  // [v2] Loop detection state
  const toolCallHistory = new Map<ToolCallSignature, number>()

  while (iterations < budget.maxIterations) {
    // Check wallclock budget
    const elapsed = Date.now() - startTime
    if (elapsed >= budget.maxWallclockMs) {
      await callbacks.onBudgetExhausted('wallclock')
      return buildResult('wallclock')
    }

    iterations += 1
    await callbacks.onIterationStart(iterations)

    // Call the model (with retry — see Task 4)
    const result = await input.runInference(messages)
    allInvocations.push(...result.invocations)

    // Track token usage
    for (const inv of result.invocations) {
      totalTokensUsed += (inv.usage.inputTokens ?? 0) + (inv.usage.outputTokens ?? 0)
    }

    // [v2] Check token budget
    if (budget.maxTokens && totalTokensUsed >= budget.maxTokens) {
      finalText = result.outputText || finalText
      await callbacks.onBudgetExhausted('wallclock') // reuse — could add 'tokens' reason
      return buildResult(null)
    }

    // If the model produced a final text response (no tool calls)
    if (!result.toolCalls || result.toolCalls.length === 0) {
      // [v2] Handle finishReason: 'length' — model was truncated mid-generation
      if (result.finishReason === 'length' && !result.outputText) {
        // Empty truncated response — the model tried but ran out of tokens
        finalText = '[Agent response was truncated due to output length limit]'
      } else {
        finalText = result.outputText
      }
      return buildResult(null)
    }

    // Model wants to call tools — append assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: result.outputText || null,
      toolCalls: result.toolCalls,
    })

    // [v2] Execute tool calls in parallel (within a single iteration)
    const toolPromises = result.toolCalls.map(async (toolCall) => {
      if (toolCallsUsed >= budget.maxToolCalls) {
        return null // will be handled after
      }

      // [v2] Loop detection
      const sig = makeToolCallSignature(toolCall.toolName, toolCall.arguments)
      const count = (toolCallHistory.get(sig) ?? 0) + 1
      toolCallHistory.set(sig, count)
      if (count >= LOOP_DETECTION_THRESHOLD) {
        return { toolCall, loopDetected: true }
      }

      await callbacks.onToolCallStart(toolCall.toolName, toolCall.arguments)
      const toolStartDate = new Date()  // [v3] Date object for recordToolEnd
      const toolStartMs = Date.now()

      // [v2] Per-tool timeout
      let toolResult: { output: string; success: boolean; inputSummary: string }
      try {
        toolResult = await withTimeout(
          executeTool(toolCall.toolName, toolCall.arguments),
          TOOL_TIMEOUT_MS,
          `Tool ${toolCall.toolName}`,
        )
      } catch (error) {
        toolResult = {
          output: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
          success: false,
          inputSummary: JSON.stringify(toolCall.arguments).slice(0, 200),
        }
      }

      const toolDuration = Date.now() - toolStartMs
      // [v3] Pass inputSummary and startedAt for recordToolEnd
      await callbacks.onToolCallEnd(
        toolCall.toolName,
        toolResult.output,
        toolDuration,
        toolResult.success,
        toolResult.inputSummary,
        toolStartDate,
      )

      toolCallsUsed += 1
      return { toolCall, toolResult, loopDetected: false }
    })

    const results = await Promise.all(toolPromises)

    // Check for loop detection
    const loopDetected = results.some((r) => r?.loopDetected)
    if (loopDetected) {
      await callbacks.onBudgetExhausted('loop_detected')
      // Inject a message telling the model to stop repeating
      messages.push({
        role: 'user',
        content: 'You are repeating the same tool calls. Stop calling tools and provide your best answer with the information you have.',
      })
      // Give it one more iteration to respond
      continue
    }

    // Check tool call budget
    if (toolCallsUsed >= budget.maxToolCalls) {
      await callbacks.onBudgetExhausted('tool_calls')
      return buildResult('tool_calls')
    }

    // Append tool results as tool messages
    for (const r of results) {
      if (!r || r.loopDetected || !r.toolResult) continue
      messages.push({
        role: 'tool',
        content: r.toolResult.output,
        toolCallId: r.toolCall.toolCallId,
      })
    }

    // [v2] Post-tool-execution wallclock check
    if (Date.now() - startTime >= budget.maxWallclockMs) {
      await callbacks.onBudgetExhausted('wallclock')
      return buildResult('wallclock')
    }
  }

  // Max iterations exhausted
  await callbacks.onBudgetExhausted('iterations')
  return buildResult('iterations')

  function buildResult(exhausted: BudgetExhaustionReason | null): LoopResult {
    return {
      finalText: finalText || (exhausted ? `Budget exceeded: ${exhausted}.` : ''),
      iterations,
      toolCallsUsed,
      wallclockMs: Date.now() - startTime,
      totalTokensUsed,
      exhaustedBudget: exhausted,
      invocations: allInvocations,
    }
  }
}
```

### Step 2: Integrate the agentic loop into executeRunJob

Rewrite the core of `worker/src/run/execute.ts` `executeRunJob()`. The major changes:

1. **Remove** keyword-based tool detection (`shouldUseDocumentRead`, `shouldUseWebFetch`, `shouldUseWebSearch` calls)
2. **Remove** the system prompt instructions "tools have already been executed" and "do not emit tool-call markup"
3. **Add** tool schema injection via `resolveAgentTools()`
4. **Replace** the single `runInferenceGraph()` call with `runAgenticLoop()`
5. **Keep** all existing: idempotency guard, status transitions, WebSocket events, memory retrieval, plan context, workflow continuation, error handling

**[v2] Critical: Preserve existing integrations:**
- `loadAllowedToolIds` logic (including `TemporaryContextSession` queries) must feed into `resolveAgentTools`
- `ensureRunPlanContext`, `markRunPlanStarted`, `markRunPlanFinished`, `appendDelegationStep`, `maybeContinueParentWorkflow` must all remain in the pipeline
- `persistInvocationLedgerEvents` must receive `loopResult.invocations`

The new flow inside the try block:

```
// 1. Load tool registry entries (existing loadAllowedToolIds logic — keep TemporaryContextSession queries)
const enabledToolIds = await loadAllowedToolIds(deps.prisma, context)

// 2. Load agent toolPolicy from DB
const agent = await prisma.agent.findUnique({
  where: { id: context.run.agentId },
  select: { toolPolicy: true, parentAgentId: true, budgetConfig: true },
})

// 3. Resolve tools with policy
const { descriptors: toolDefs, allowedIds } = resolveAgentTools(
  enabledToolIds,
  BUILTIN_TOOL_DEFINITIONS,
  agent?.toolPolicy as Record<string, boolean> | null,
  agent?.parentAgentId ?? null,
)

// 4. Build system prompt WITHOUT "do not emit tool-call markup"
const systemPrompt = buildAgenticSystemPrompt(context, memoryContext)

// 5. Build initial messages — use ProviderMessage[], NOT ModelMessage[]
// [v2] Critical: bypass toProviderMessages/ModelMessage — work with ProviderMessage directly
const initialMessages: ProviderMessage[] = [
  { role: 'system', content: systemPrompt },
  ...conversationHistory,  // already ProviderMessage[] after loading
  { role: 'user', content: prompt },
]

// 6. Start SSE stream (keep as-is)

// 7. Run the agentic loop
// [v2] runInference adapts runInferenceGraph's MultiProviderResult to InferenceResult
const loopResult = await runAgenticLoop({
  budget: {
    ...DEFAULT_BUDGET,
    ...(agent?.budgetConfig as Partial<BudgetLimits> | null),  // [v2] per-agent overrides
  },
  callbacks: {
    onIterationStart: async (i) => {
      // [v2] Publish iteration event for UI
      await transport.publishWs(scopes, {
        event: 'agent.iteration',
        data: { agentId, iteration: i, runId: context.run.id },
      })
    },
    onToolCallStart: async (name, args) => {
      await setAgentStatus(prisma, agentId, 'executing')
      await publishAgentStatus(transport, context, { status: 'executing', currentToolName: name })
      await transport.publishWs(scopes, {
        event: 'agent.tool.start',
        data: { agentId, toolName: name, runId: context.run.id },
      })
    },
    // [v3] Extended callback with inputSummary + startedAt for recordToolEnd
    onToolCallEnd: async (name, result, duration, success, inputSummary, startedAt) => {
      await recordToolEnd(deps, context, {
        toolName: name, durationMs: duration, success, outputPreview: result,
        inputSummary,   // [v3] was missing
        startedAt,      // [v3] was missing
      })
      await setAgentStatus(prisma, agentId, 'thinking')
      await publishAgentStatus(transport, context, { status: 'thinking' })
    },
    onTextDelta: async (delta) => {
      await transport.publishSse(threadId, 'stream.delta', { content: delta })
    },
    onBudgetExhausted: async (reason) => {
      logger.warn({ agentId, reason, runId: context.run.id }, 'Agent budget exhausted')
    },
  },
  executeTool: async (name, args) => {
    if (!allowedIds.has(name)) {
      return { output: `Tool "${name}" is not allowed for this agent.`, success: false }
    }
    return executeBuiltinTool(name, args)
  },
  initialMessages,
  runInference: async (messages) => {
    // [v2] Adapt MultiProviderResult → InferenceResult-like shape
    const mpr = await runInferenceGraph(prisma, {
      ...inferenceParams,
      baseMessages: messages,  // [v2] baseMessages type must be widened — see Task 7
      tools: toolDefs,
      toolChoice: 'auto',
    })

    return {
      outputText: mpr.finalAnswer ?? '',
      toolCalls: mpr.toolCalls ?? [],  // [v2] — requires adding toolCalls to MultiProviderResult
      finishReason: mpr.invocations[0]?.finishReason,
      invocations: mpr.invocations,
      model: mpr.invocations[0]?.model ?? '',
      provider: mpr.invocations[0]?.provider as any ?? 'openai',
      requestId: mpr.requestId,
    }
  },
  tools: toolDefs,
})

// 8. Use loopResult.finalText as the response
responseText = stripLeadingSectionTag(loopResult.finalText)

// 9. Persist invocations to token ledger (from loop result)
await persistInvocationLedgerEvents(prisma, {
  actorContext: context.actorContext,
  agentId,
  invocations: loopResult.invocations,
})

// 10. [v3] Memory recall tracking — MUST be preserved
const referencedRecallIds = detectReferencedRecallIds(responseText, memories)
if (referencedRecallIds.length > 0) {
  await markRecallsReferenced(referencedRecallIds, deps.searchConfig.pool)
}

// 11. [v3] Plan/workflow integration — MUST include markDelegationStepFinished
await markRunPlanFinished(...)
await markDelegationStepFinished(deps.prisma, {
  artifacts: { childAgentName, responseText, runId, taskId, toolOutputs: [] },
  planId: payload.parentPlanId,
  planStepId: payload.parentPlanStepId,
  success: true,
})
await maybeContinueParentWorkflow(...)
```

**[v3] Also add to the INITIAL setup, before the loop:**
```typescript
// After loading memories, before building initial messages:
if (injectedRecallIds.length > 0) {
  await markRecallsInjected(injectedRecallIds, deps.searchConfig.pool)
}

// [v3] memoryContext MUST be injected as a system message:
const initialMessages: ProviderMessage[] = [
  { role: 'system', content: systemPrompt },
  ...(memoryContext ? [{ role: 'system' as const, content: memoryContext }] : []),
  ...conversationHistory,
  { role: 'user', content: prompt },
]
```

**[v3] Also add to the ERROR handler:**
```typescript
// In the catch block, preserve existing error handling:
await markDelegationStepFinished(deps.prisma, {
  artifacts: { error: messageText },
  planId: payload.parentPlanId,
  planStepId: payload.parentPlanStepId,
  success: false,
})
await deps.prisma.taskEvent.create({
  data: {
    eventType: 'run.failed',
    payload: { message: messageText },
    taskId: context.task.id,
  },
})
```

### Step 3: Update the system prompt builder

Remove these lines from `buildModelPrompt`:
- `'The required safe tools have already been executed.'`
- `'Do not emit tool-call markup or request more tool execution.'`
- `'Return plain text only.'`

Replace with:
- `'You have access to tools. Use them when needed to answer the request accurately.'`
- `'Call tools by their function name. Do not fabricate tool output — always call the tool.'`
- `'When you have enough information, respond directly without calling more tools.'`

### Step 4: Add budget config to agent schema

**Prisma migration:** Add `budgetConfig` JSON field to Agent model:

```prisma
model Agent {
  // ... existing fields ...
  budgetConfig   Json?                @map("budget_config")
}
```

In `packages/schemas/src/index.ts`, add:

```typescript
export const AgentBudgetConfigSchema = z.object({
  maxIterations: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxWallclockMs: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxCostCents: z.number().nonnegative().optional(),  // [v3] declared but NOT enforced — no pricing lookup exists yet. Deferred to Phase 2.
})
export type AgentBudgetConfig = z.infer<typeof AgentBudgetConfigSchema>
```

**[v3] Add `agent.iteration` to `WsEventSchema`:**

The `WsEventSchema` in `packages/schemas/src/index.ts` is a closed `z.union`. `agent.iteration` must be added as a variant or `publishWs` will reject the event:

```typescript
// Add to WsEventSchema union:
z.object({
  event: z.literal('agent.iteration'),
  data: z.object({
    agentId: z.string(),
    iteration: z.number().int().positive(),
    runId: z.string(),
  }),
}),
```

Also add handler in `admin/src/facades/agents/hooks.ts` `handleServerMessage`:
```typescript
if (message.event === 'agent.iteration') {
  // Update iteration state for UI progress indicator
  invalidateAgentCaches(message.data.agentId)
  return
}
```

### Step 5: [v2] Add concurrent run protection

The agentic loop can run for up to 90 seconds. Without protection, a duplicate queue delivery could start a second loop for the same run. The existing idempotency guard checks `run.status !== 'pending'` but there's a race window.

Add a PostgreSQL advisory lock at the start of `executeRunJob`:

```typescript
// At the top of the try block, before the status check:
const lockKey = hashStringToInt(context.run.id) // deterministic int from UUID
const acquired = await prisma.$queryRawUnsafe<[{ acquired: boolean }]>(
  'SELECT pg_try_advisory_lock($1) as acquired',
  lockKey,
)
if (!acquired[0]?.acquired) {
  logger.info({ runId: context.run.id }, 'Run already locked by another worker')
  return
}
// Release in finally block:
// await prisma.$queryRawUnsafe('SELECT pg_advisory_unlock($1)', lockKey)
```

### Step 6: Commit

```
feat(worker): implement agentic loop — model-driven iterative tool execution
```

---

## Task 4: Error Classification and Recovery

**Why:** Without error classification, every failure is terminal. OpenClaw classifies errors and applies different recovery strategies: retry, rotate auth, compact context, or surface to user.

**OpenClaw parallel:** `classifyFailoverReason()` in `pi-embedded-helpers/errors.ts`, `resolveRunFailoverDecision()` in `run/failover-policy.ts`

**Files:**
- Create: `worker/src/run/error-classification.ts`
- Modify: `worker/src/run/agentic-loop.ts`

### Step 1: Create the error classifier

Create `worker/src/run/error-classification.ts`:

```typescript
// [v2] Added auth_permanent, overloaded, format from OpenClaw review
export type FailoverReason =
  | 'auth'              // 401 — token expired, can rotate
  | 'auth_permanent'    // 401 — invalid API key, never retry
  | 'rate_limit'        // 429 — rate limited
  | 'billing'           // 402/payment — billing issue
  | 'context_overflow'  // context too long
  | 'timeout'           // request timed out
  | 'overloaded'        // 503 — provider load shedding
  | 'model_not_found'   // model doesn't exist
  | 'content_filter'    // content policy violation
  | 'format'            // malformed response / stream corruption
  | 'transient'         // 500/502/504 — retry
  | 'unknown'           // unclassified

export type RecoveryStrategy =
  | { action: 'retry'; delayMs: number }
  | { action: 'compact_and_retry' }
  | { action: 'surface_error'; userMessage: string }
  | { action: 'abort' }

export const classifyError = (error: unknown): FailoverReason => {
  if (!(error instanceof Error)) return 'unknown'

  const message = error.message.toLowerCase()
  const statusMatch = message.match(/status[:\s]*(\d{3})/)
  const status = statusMatch ? parseInt(statusMatch[1], 10) : null

  if (status === 401 || message.includes('unauthorized')) {
    // [v2] Distinguish permanent from rotatable auth failures
    if (message.includes('invalid') || message.includes('malformed') || message.includes('revoked')) {
      return 'auth_permanent'
    }
    return 'auth'
  }
  if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate_limit'
  }
  if (status === 402 || message.includes('billing') || message.includes('quota') || message.includes('insufficient')) {
    return 'billing'
  }
  if (message.includes('context') && (message.includes('length') || message.includes('overflow') || message.includes('too long') || message.includes('maximum'))) {
    return 'context_overflow'
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('ETIMEDOUT') || message.includes('ECONNRESET')) {
    return 'timeout'
  }
  // [v2] Separate overloaded from other 5xx
  if (status === 503 || message.includes('overloaded') || message.includes('service unavailable')) {
    return 'overloaded'
  }
  if (message.includes('model') && message.includes('not found')) {
    return 'model_not_found'
  }
  if (message.includes('content_filter') || message.includes('content policy') || message.includes('safety')) {
    return 'content_filter'
  }
  // [v2] Format errors — malformed response
  if (message.includes('json') && (message.includes('parse') || message.includes('unexpected'))) {
    return 'format'
  }
  if (status && status >= 500) {
    return 'transient'
  }

  return 'unknown'
}

// [v2] Per-run retry budget — shared across all iterations
export type RetryBudget = {
  remaining: number
  total: number
}

export const createRetryBudget = (total: number = 6): RetryBudget => ({
  remaining: total,
  total,
})

export const resolveRecovery = (
  reason: FailoverReason,
  attemptCount: number,
  retryBudget: RetryBudget,
): RecoveryStrategy => {
  // [v2] Check global retry budget first
  if (retryBudget.remaining <= 0 && reason !== 'context_overflow') {
    return { action: 'surface_error', userMessage: 'Too many retries. Please try again later.' }
  }

  switch (reason) {
    case 'rate_limit':
      return attemptCount < 3
        ? { action: 'retry', delayMs: Math.min(1000 * 2 ** attemptCount, 30_000) }
        : { action: 'surface_error', userMessage: 'Rate limited by the model provider. Try again shortly.' }

    case 'overloaded':
      // [v2] Longer backoff for 503 load shedding
      return attemptCount < 3
        ? { action: 'retry', delayMs: Math.min(5000 * 2 ** attemptCount, 60_000) }
        : { action: 'surface_error', userMessage: 'The model provider is overloaded. Try again in a few minutes.' }

    case 'transient':
    case 'timeout':
      return attemptCount < 2
        ? { action: 'retry', delayMs: Math.min(2000 * 2 ** attemptCount, 30_000) }
        : { action: 'surface_error', userMessage: 'The model provider is temporarily unavailable.' }

    case 'format':
      // [v2] Retry format errors once — stream corruption is often transient
      return attemptCount < 1
        ? { action: 'retry', delayMs: 500 }
        : { action: 'surface_error', userMessage: 'Received a malformed response from the model.' }

    case 'context_overflow':
      return { action: 'compact_and_retry' }

    case 'auth':
      return { action: 'surface_error', userMessage: 'Authentication failed with the model provider. Check API key configuration.' }

    case 'auth_permanent':
      return { action: 'surface_error', userMessage: 'Invalid API key. Please update your provider credentials.' }

    case 'billing':
      return { action: 'surface_error', userMessage: 'Billing issue with the model provider.' }

    case 'model_not_found':
      return { action: 'surface_error', userMessage: 'The configured model was not found.' }

    case 'content_filter':
      return { action: 'surface_error', userMessage: 'The response was blocked by content policy.' }

    default:
      return { action: 'abort' }
  }
}
```

### Step 2: Add retry wrapper and wire it into the agentic loop

In `worker/src/run/agentic-loop.ts`, wrap the `runInference` call:

```typescript
import { classifyError, resolveRecovery, createRetryBudget, type RetryBudget } from './error-classification.js'
import { compactMessages } from './context-management.js'

// [v2] This is called FROM the loop, not defined separately and forgotten
const callInferenceWithRetry = async (
  messages: ProviderMessage[],
  runInference: (msgs: ProviderMessage[]) => Promise<InferenceResult>,
  retryBudget: RetryBudget,
  compactFn?: (msgs: ProviderMessage[]) => Promise<ProviderMessage[]>,
): Promise<InferenceResult> => {
  let lastError: unknown
  let compactionAttempts = 0
  const MAX_COMPACTION_ATTEMPTS = 2  // [v2] bound compaction retries

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
        // [v2] Compaction has its own retry limit
        if (!compactFn || compactionAttempts >= MAX_COMPACTION_ATTEMPTS) {
          throw new Error('Context overflow: unable to compact messages further')
        }
        compactionAttempts += 1
        const compacted = await compactFn(messages)
        messages.length = 0
        messages.push(...compacted)
        continue
      }

      if (recovery.action === 'surface_error') {
        return {
          outputText: recovery.userMessage,
          toolCalls: [],
          finishReason: 'error',
          invocations: [],
          model: '',
          provider: 'openai' as any,
          requestId: '',
        } as InferenceResult
      }

      throw error // abort or unknown
    }
  }

  throw lastError
}
```

Then in `runAgenticLoop`, replace the direct `input.runInference(messages)` call with:

```typescript
const retryBudget = createRetryBudget(6)  // 6 retries across the entire loop

// Inside the while loop, replace:
//   const result = await input.runInference(messages)
// with:
const result = await callInferenceWithRetry(
  messages,
  input.runInference,
  retryBudget,
  input.compactMessages,  // optional compaction function passed from caller
)
```

### Step 3: Commit

```
feat(worker): add error classification and recovery with retry budget
```

---

## Task 5: Context Management

**Why:** With the agentic loop, conversations grow fast (each tool call adds messages). Without context management, agents hit context window limits. OpenClaw uses compaction — summarizing old messages when approaching the limit.

**OpenClaw parallel:** `compact.ts` — queued/on-demand compaction with summarization

**Files:**
- Create: `worker/src/run/context-management.ts`
- Modify: `worker/src/run/agentic-loop.ts`

### Step 1: Create the context management module

Create `worker/src/run/context-management.ts`:

```typescript
import type { ProviderMessage, ToolSchemaDescriptor } from '@nessie/runtime'

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is a fast heuristic, not a tokenizer.
 */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4)

// [v2] Count tool schema tokens in the budget
export const estimateToolSchemaTokens = (tools: ToolSchemaDescriptor[]): number =>
  tools.reduce((sum, tool) => {
    const schemaText = `${tool.toolName}: ${tool.description} ${JSON.stringify(tool.inputSchema)}`
    return sum + estimateTokens(schemaText)
  }, 0)

export const estimateMessageTokens = (msg: ProviderMessage): number => {
  let content = ''
  if (msg.role === 'assistant') {
    content = msg.content ?? ''
    if (msg.toolCalls) {
      content += msg.toolCalls.map((tc) => JSON.stringify(tc)).join('')
    }
  } else {
    content = msg.content
  }
  return estimateTokens(content) + 4 // 4 tokens overhead per message
}

export const estimateMessagesTokens = (messages: ProviderMessage[]): number =>
  messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)

/**
 * Trim conversation history to fit within a token budget.
 * Always keeps the system message(s) and the most recent user message.
 *
 * [v2] CRITICAL: Never orphan tool_call/tool_result pairs.
 * An assistant message with toolCalls and the subsequent tool messages
 * are an atomic group — keep all or drop all.
 */
export const trimConversationToFit = (
  messages: ProviderMessage[],
  maxTokens: number,
  toolSchemaTokens: number = 0,
): ProviderMessage[] => {
  const effectiveBudget = maxTokens - toolSchemaTokens
  if (estimateMessagesTokens(messages) <= effectiveBudget) {
    return messages
  }

  // Group messages into atomic units (tool_call + tool_results are one group)
  const groups = groupMessages(messages)

  const systemGroups = groups.filter((g) => g[0].role === 'system')
  const nonSystemGroups = groups.filter((g) => g[0].role !== 'system')

  // Keep system messages and work backwards from most recent
  const kept: ProviderMessage[][] = [...systemGroups]
  let usedTokens = kept.flat().reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
  const budget = effectiveBudget - usedTokens

  usedTokens = 0
  const fromRecent = [...nonSystemGroups].reverse()
  const reversedKept: ProviderMessage[][] = []

  for (const group of fromRecent) {
    const groupTokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
    if (usedTokens + groupTokens > budget) break
    reversedKept.push(group)
    usedTokens += groupTokens
  }

  return [...kept.flat(), ...reversedKept.reverse().flat()]
}

/**
 * [v2] Group messages into atomic units.
 * An assistant message with toolCalls + its subsequent tool messages = one group.
 */
const groupMessages = (messages: ProviderMessage[]): ProviderMessage[][] => {
  const groups: ProviderMessage[][] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Collect this assistant message + all subsequent tool messages
      const group: ProviderMessage[] = [msg]
      const toolCallIds = new Set(msg.toolCalls.map((tc) => tc.toolCallId))
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        const toolMsg = messages[j] as { role: 'tool'; content: string; toolCallId: string }
        if (toolCallIds.has(toolMsg.toolCallId)) {
          group.push(messages[j])
          j++
        } else {
          break
        }
      }
      groups.push(group)
      i = j
    } else {
      groups.push([msg])
      i++
    }
  }

  return groups
}

/**
 * Build a compaction prompt to summarize old messages.
 * Used when context_overflow recovery fires.
 *
 * [v2] Compaction calls the model — this can itself fail.
 * The caller (callInferenceWithRetry) bounds compaction attempts to 2.
 */
export const buildCompactionPrompt = (
  messagesToCompact: ProviderMessage[],
): string => {
  const transcript = messagesToCompact
    .map((m) => {
      if (m.role === 'tool') return `[tool:${m.toolCallId}]: ${m.content.slice(0, 500)}`
      if (m.role === 'assistant' && m.toolCalls) {
        return `[assistant]: ${m.content ?? ''}\n  [called: ${m.toolCalls.map((tc) => tc.toolName).join(', ')}]`
      }
      return `[${m.role}]: ${typeof m.content === 'string' ? m.content : '(content)'}`
    })
    .join('\n')

  return [
    'Summarize this conversation history into a concise context paragraph.',
    'Preserve: key facts, decisions made, tool results that matter, and the current goal.',
    'Drop: greetings, acknowledgments, redundant information, verbose tool output.',
    'Output only the summary, no preamble.',
    '',
    transcript,
  ].join('\n')
}
```

### Step 2: Integrate context trimming into the agentic loop

In `runAgenticLoop`, before each inference call, check message token count and trim if needed:

```typescript
// Before calling runInference:
const contextBudget = 100_000  // ~100k tokens; TODO: derive from model's maxInputTokens
const toolSchemaTokens = estimateToolSchemaTokens(tools)
const currentTokens = estimateMessagesTokens(messages)
if (currentTokens + toolSchemaTokens > contextBudget * 0.85) {
  const trimmed = trimConversationToFit(
    messages,
    Math.floor(contextBudget * 0.75),
    toolSchemaTokens,
  )
  messages.length = 0
  messages.push(...trimmed)
}
```

### Step 3: Commit

```
feat(worker): add context management with token estimation and pair-aware trimming
```

---
