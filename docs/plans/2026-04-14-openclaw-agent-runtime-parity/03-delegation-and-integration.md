# Delegation and Integration

## Task 6: Structured Sub-Agent Delegation

**Why:** Today sub-agent spawning is triggered by regex matching "spawn" or "delegate" in user messages. The agentic loop means the model should decide when to delegate — via a tool call, not keyword matching.

**OpenClaw parallel:** `sessions_spawn` tool in `tools/sessions-spawn-tool.ts` with structured announce protocol

**Files:**
- Modify: `worker/src/run/execute.ts` (remove `maybeSpawnChildAgent`)
- Modify: `packages/runtime/src/builtin-tools.ts` (add spawn_subtask tool)
- Modify: `worker/src/run/tools.ts` (add spawn handler)

### Step 1: Add spawn_subtask as a builtin tool

Add to `packages/runtime/src/builtin-tools.ts`:

```typescript
{
  id: 'spawn_subtask',
  label: 'Spawn Sub-Task',
  description: 'Delegate a specific sub-task to a new child agent. Use when a task is complex enough to benefit from parallel or specialized work. The child agent will complete the task and report back.',
  safe: true,
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Clear description of the sub-task to delegate',
      },
      role: {
        type: 'string',
        description: 'Role for the child agent: researcher, builder, reviewer',
        enum: ['researcher', 'builder', 'reviewer'],
      },
    },
    required: ['task'],
  },
}
```

### Step 2: Implement the spawn tool handler

In `worker/src/run/tools.ts`, add a `runSpawnSubtaskTool` function that:

1. Creates a child agent record via Prisma
2. Creates a Run + Task for the child
3. Enqueues a `run.execute` job for the child
4. Returns a message like "Sub-agent '{name}' has been spawned to handle: {task}"

**[v2] Spawn guards:**
- **Max children per parent:** Limit to 5 active child agents per parent. Query `Agent.count({ where: { parentAgentId, status: { not: 'idle' } } })` before spawning.
- **Max depth:** Child agents have `spawn_subtask` removed from their tool set (see Task 2, Step 2). This enforces depth=1 for now. To support deeper nesting later, track depth on the Agent record.
- **Cancellation propagation:** When a parent run is cancelled (`run.status = 'cancelled'`), cancel all child runs. Add a check at the top of `executeRunJob`: if parent run is cancelled, skip execution.

```typescript
export const runSpawnSubtaskTool = async (
  prisma: PrismaClient,
  context: RunContext,
  args: { task: string; role?: string },
): Promise<ToolExecutionResult> => {
  // [v2] Max children guard
  const activeChildren = await prisma.agent.count({
    where: {
      parentAgentId: context.run.agentId,
      status: { not: 'idle' },
    },
  })
  if (activeChildren >= 5) {
    return {
      output: 'Cannot spawn more sub-agents: maximum of 5 active children reached.',
      success: false,
    }
  }

  // [v3] CRITICAL: Must create the full entity chain that executeRunJob expects.
  // Reference existing maybeSpawnChildAgent (execute.ts:636-696) for the pattern:
  //
  // 1. Create child Agent record (with parentAgentId, role from args, org/project/team from parent)
  // 2. Create AgentBinding (links child agent to parent's channel)
  // 3. Create Message record (the spawn instruction — needed for RunExecuteJobPayload.messageId)
  // 4. Create Task record (linked to child agent)
  // 5. Create Run record (linked to child agent, thread, task)
  // 6. Create AgentMailboxMessage (for inter-agent tracking)
  // 7. Enqueue run.execute job with payload: { actorContext, agentId, messageId, runId, taskId, threadId }
  //
  // All 7 steps are required. The existing maybeSpawnChildAgent does steps 1, 2, 6 directly
  // and the mailbox consumer creates 3-5-7. For spawn_subtask, do all inline to avoid
  // the asynchronous mailbox round-trip.

  return {
    output: `Sub-agent spawned to handle: ${args.task}`,
    success: true,
  }
}
```

### Step 3: Remove keyword-based spawn

In `worker/src/run/execute.ts`:
- Remove the `deriveDelegatedTask` function
- Remove the `maybeSpawnChildAgent` function
- Remove the `maybeSpawnChildAgent(...)` call from `executeRunJob`
- The model will now call `spawn_subtask` through the agentic loop when it decides delegation is needed

### Step 4: Commit

```
feat(worker): replace keyword-based spawn with model-driven spawn_subtask tool
```

---

## Task 7: Wire It All Together and Clean Up

**Why:** Tasks 1–6 created the components. This task integrates them into a clean, working pipeline and removes dead code.

**Files:**
- Modify: `worker/src/run/execute.ts` (final integration)
- Modify: `worker/src/run/inference.ts` (extend `RunInferenceGraphInput`)
- Remove dead code from `worker/src/run/tools.ts`
- Modify: `packages/runtime/src/model.ts` (bridge `ModelMessage` ↔ `ProviderMessage`)

### Step 1: Extend RunInferenceGraphInput and the full propagation chain

`worker/src/run/inference.ts:29-41` — The `RunInferenceGraphInput` type must accept tools and use `ProviderMessage[]` instead of `ModelMessage[]`:

```typescript
type RunInferenceGraphInput = {
  actorContext: AuthorizedActionContext
  agent: {
    id: string
    model: string | null
    provider: string | null
    routingProfileId: string | null
  }
  baseMessages: ProviderMessage[]  // [v2] was ModelMessage[] — widened
  modelConfig: ModelConfig
  onVisibleTextDelta?: (delta: string) => Promise<void>
  organizationId: string
  tools?: ToolSchemaDescriptor[]    // [v2] NEW
  toolChoice?: string               // [v2] NEW
}
```

**[v2] Critical:** `baseMessages` type change from `ModelMessage[]` to `ProviderMessage[]` affects all callers of `runInferenceGraph`. Audit and update:
- `worker/src/run/execute.ts` (the main caller — already uses ProviderMessage after Task 3)
- Any other callers must convert their `ModelMessage[]` via a helper:

```typescript
// In packages/runtime/src/model.ts — add a bridge function
export const modelMessageToProvider = (msg: ModelMessage): ProviderMessage => ({
  role: msg.role,
  content: msg.content,
})
```

**[v3] CRITICAL — Full propagation chain for tools through `executeStage`:**

The tools must flow through every link. This is the most error-prone part of the implementation:

```
RunInferenceGraphInput.tools
  → mode executor (executeSingleMode, etc.) — forward tools to executeStage
  → executeStage input type — add tools/toolChoice fields
  → service.stream/run call (inference.ts:582-598) — pass tools in InferenceRequest
  → buildProviderRequest (service.ts:34-47) — forward tools/toolChoice
  → connector.invoke/stream — map to OpenAI wire format
```

Modify `executeStage` input type in inference.ts:
```typescript
// Current executeStage input (around line 507):
type StageExecutionInput = {
  // ... existing fields ...
  tools?: ToolSchemaDescriptor[]    // [v3] NEW
  toolChoice?: string               // [v3] NEW
}
```

Then in `executeStage` body, pass through to service calls:
```typescript
// inference.ts:582-598 — add tools to service.stream/run calls:
const source = service.stream?.({
  actorContext: input.actorContext,
  maxOutputTokens: input.modelConfig.maxTokens,
  messages,
  model: providerConfig.model,
  requestId,
  temperature: input.modelConfig.temperature,
  tools: input.tools,         // [v3] NEW
  toolChoice: input.toolChoice, // [v3] NEW
})
```

Each mode executor must forward tools to its `executeStage` calls. For this phase, **only `executeSingleMode` is fully supported** — the other modes pass `tools: undefined`:

```typescript
// executeSingleMode: forward tools
await executeStage({ ...existingInput, tools: input.tools, toolChoice: input.toolChoice })

// executeFallbackMode, executeCommitteeMode, executePipelineMode, executeShadowMode:
// [v3] Pass tools: undefined for now. These modes don't support tool calling yet.
// The guard is: if toolCallingMode check passes, tools flow through single mode only.
// Document this limitation in the plan.
```

**[v3] Also update `buildVisibleStageMessages`** to accept `ProviderMessage[]` instead of `ModelMessage[]`:
```typescript
const buildVisibleStageMessages = (
  baseMessages: ProviderMessage[],   // was ModelMessage[]
  upstream: CandidateOutput[],
): ProviderMessage[] => {            // was ModelMessage[]
  // ... body unchanged for single mode (upstream empty)
}
```

### Step 2: Extend MultiProviderResult with toolCalls

In `packages/schemas/src/index.ts`, add `toolCalls` to `MultiProviderResultSchema`:

```typescript
export const MultiProviderResultSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  status: MultiProviderResultStatusSchema,
  finalAnswer: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  answerOwner: AnswerOwnerSchema.optional(),
  toolExecutionOwner: ToolExecutionOwnerSchema.nullable(),
  toolCalls: z.array(ProviderToolCallSchema).optional(),  // [v2] NEW
  failure: MultiProviderFailureSchema.optional(),
  invocations: z.array(InvocationRecordSchema),
})
```

Then in `worker/src/run/inference.ts`, the `executeStage` function must surface `toolCalls` from the provider result into the `MultiProviderResult`.

### Step 3: Extend ToolCall table for agentic loop

Prisma migration — add fields to support multi-iteration tool call tracking:

```prisma
model ToolCall {
  id                String    @id @default(uuid()) @db.Uuid
  runId             String    @map("run_id") @db.Uuid
  agentId           String    @map("agent_id") @db.Uuid
  toolName          String    @map("tool_name")
  inputSummary      String    @map("input_summary")
  outputPreview     String?   @map("output_preview")
  success           Boolean?
  startedAt         DateTime  @map("started_at")
  endedAt           DateTime? @map("ended_at")
  durationMs        Int?      @map("duration_ms")
  providerToolCallId String?  @map("provider_tool_call_id")  // [v2] NEW — links to model's tool_call ID
  iterationNumber   Int?      @map("iteration_number")       // [v2] NEW — which loop iteration
  run               Run       @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, startedAt])
  @@index([agentId, startedAt])
  @@map("tool_calls")
}
```

### Step 4: Remove dead keyword detection code

From `worker/src/run/tools.ts`, remove exports:
- `shouldUseDocumentRead`
- `shouldUseWebFetch`
- `shouldUseWebSearch`

From `worker/src/run/execute.ts`, remove:
- All imports of `shouldUse*` functions
- The keyword-detection tool execution block
- The `maybeSpawnChildAgent` call and related functions
- The "do not emit tool-call markup" system prompt lines

### Step 5: Final executeRunJob flow

```
1. Idempotency guard (keep as-is)
2. [v2] Advisory lock — prevent concurrent execution of same run
3. Load run context (keep as-is)
4. Load trigger message (keep as-is)
5. Update statuses: run→running, task→in_progress, agent→thinking (keep as-is)
6. Ensure plan context (keep as-is)
7. Load allowed tools from DB + resolve agent tool policy (NEW)
   - Preserves TemporaryContextSession scoping
8. Load conversation history (keep as-is)
9. Retrieve memories (keep as-is)
10. Build agentic system prompt (MODIFIED — no "do not call tools")
11. Build initial messages as ProviderMessage[] (MODIFIED — no tool pre-execution)
12. Start SSE stream (keep as-is)
13. Run agentic loop (NEW — replaces single inference call)
    ├── Model calls tools as needed
    ├── Worker executes and feeds results back (with per-tool timeout)
    ├── Budget controls enforce limits
    ├── Loop detection prevents infinite repetition
    ├── Error recovery retries transient failures (with shared retry budget)
    └── Context trimming keeps message history in bounds (pair-aware)
14. Strip section tags from final response (keep as-is)
15. Persist invocations to token ledger (MODIFIED — from loop result)
16. Detect memory references (keep as-is)
17. Save assistant message (keep as-is)
18. Publish stream.done + message.new (keep as-is)
19. Update statuses: run→completed, task→done, agent→idle (keep as-is)
20. Continue parent workflow if applicable (keep as-is)
21. [v2] Release advisory lock (in finally block)
```

### Step 6: Run lint and typecheck

```bash
cd /System/Volumes/Data/.internal/projects/Projects/nessie
pnpm --filter @nessie/runtime build
pnpm --filter @nessie/schemas build
pnpm --filter @nessie/worker build
pnpm --filter @nessie/runtime lint
pnpm --filter @nessie/worker lint
```

### Step 7: Manual integration test

1. Start the API and worker
2. Create an agent with no special tool policy
3. Send a message like "search the web for the latest TypeScript release"
4. Verify the agent calls `web_search` tool via the agentic loop (not keyword detection)
5. Verify tool call appears in WebSocket events with `iterationNumber`
6. Verify the agent iterates: search → read result → respond
7. Send "read the implementation phases document" — verify `document_read` tool is called by the model
8. Test budget exhaustion: set `maxIterations: 2` on an agent's budgetConfig and verify it stops
9. Test error recovery: temporarily set an invalid API key and verify the error message surfaces cleanly
10. **[v2]** Test loop detection: send a prompt that causes repeated identical searches — verify the agent breaks out

### Step 8: Commit

```
feat(worker): complete agentic loop integration, remove keyword-based tool dispatch
```

---

## Dependency Graph

```
Task 1: Native Tool Calling (inference layer)
  │
  ├── Task 2: Tool Registry + Policy Gateway
  │     │
  │     └── Task 3: The Agentic Loop ◄── core deliverable
  │           │
  │           ├── Task 4: Error Classification (wired INTO the loop)
  │           │
  │           ├── Task 5: Context Management (wired INTO the loop)
  │           │
  │           └── Task 6: Structured Spawn
  │
  └── Task 7: Integration + Cleanup (depends on all above)
```

Tasks 4, 5, 6 can run in parallel after Task 3.

**[v2] Note on Task 4/5 ordering:** The agentic loop (Task 3) references `callInferenceWithRetry` and `trimConversationToFit` which are implemented in Tasks 4 and 5. During Task 3 implementation, stub these with pass-through implementations. Tasks 4 and 5 replace the stubs.

---

## What This Does NOT Cover (deferred to existing phase plans)

- **Auth profile rotation** — Phase 2 (`implementation-phases.md` Step 1)
- **Hook/plugin system** — Phase 3+ (agent implementation plan)
- **Skills system** — Phase 3+ (agent implementation plan Phase 5)
- **MCP tool bundling** — Phase 3+ (external-tool-integration.md)
- **Sandbox isolation** — Phase 4 (implementation-phases.md)
- **Remote workers** — Phase 4 (implementation-phases.md)
- **Prompt-translated tool calling** — Phase 2 (MiniMax-specific; guard added in Task 1 to prevent breakage)
- **SSE iteration events / AgentThoughtStream UI** — Separate admin UI task (events emitted by Task 3 but UI consumption deferred)

---

## [v2] Review Round 1 Findings Addressed

| # | Finding | Severity | Addressed In |
|---|---|---|---|
| 1 | `ModelMessage` cannot carry tool messages | CRITICAL | Task 7 Step 1 — widen `baseMessages` to `ProviderMessage[]` |
| 2 | `ProviderMessage` in 3 packages | CRITICAL | Task 1 Step 1 — extend runtime version, align field names with schemas |
| 3 | `packages/schemas` has existing tool types | CRITICAL | Task 1 — use `ToolSchemaDescriptor`/`ProviderToolCall` shapes, not duplicates |
| 4 | Streaming ignores `tool_calls` | CRITICAL | Task 1 Step 3 — extend `collectChatStream` |
| 5 | `runInferenceGraph` returns `MultiProviderResult` | CRITICAL | Task 7 Step 2 — add `toolCalls` to schema, adapt in loop |
| 6 | `TemporaryContextSession` scoping dropped | HIGH | Task 3 Step 2 — preserve `loadAllowedToolIds` with session queries |
| 7 | No concurrent run protection | HIGH | Task 3 Step 5 — PostgreSQL advisory lock |
| 8 | `prompt-translated` mode ignored | HIGH | Task 1 Step 7 — guard in service.ts, full impl deferred |
| 9 | Plan/workflow calls missing from pseudocode | HIGH | Task 3 Step 2 — explicitly listed in pipeline |
| 10 | `compact_and_retry` never wired | HIGH | Task 4 Step 2 — `callInferenceWithRetry` wired into loop |
| 11 | Tool-result truncation missing | HIGH | Task 2 Step 3 — `MAX_TOOL_RESULT_CHARS = 32_000` |
| 12 | No per-tool timeout | HIGH | Task 3 Step 1 — `TOOL_TIMEOUT_MS = 30_000` with `withTimeout` |
| 13 | No loop detection | HIGH | Task 3 Step 1 — `makeToolCallSignature` + threshold |
| 14 | Context trimming orphans tool pairs | HIGH | Task 5 Step 1 — `groupMessages` keeps atomic groups |
| 15 | Tool schema tokens not budgeted | HIGH | Task 5 Step 1 — `estimateToolSchemaTokens` |
| 16 | ToolCall table too lossy | HIGH | Task 7 Step 3 — add `providerToolCallId`, `iterationNumber` |
| 17 | No per-agent budget overrides | HIGH | Task 3 Step 4 — `budgetConfig` JSON on Agent |
| 18 | Spawn: no depth/maxChildren/cancellation | HIGH | Task 6 Step 2 — guards added |

## [v3] Review Round 2 Findings Addressed

15 reviewers (5 Claude explore agents + 10 max) reading actual source code.

| # | Finding | Severity | Addressed In |
|---|---|---|---|
| 19 | `toolCallId: z.string().uuid()` in api/contracts — rejects OpenAI's non-UUID IDs | CRITICAL | Task 1 Step 5 — fix to `z.string().min(1)` |
| 20 | `markDelegationStepFinished` missing from success/error paths | CRITICAL | Task 3 Step 2 — added to pipeline pseudocode |
| 21 | `tools`/`toolChoice` not threaded through `executeStage` to service calls | CRITICAL | Task 7 Step 1 — full propagation chain documented |
| 22 | `agent.iteration` event has no schema in `WsEventSchema` | CRITICAL | Task 3 Step 4 — schema + admin handler added |
| 23 | `spawn_subtask` omits Task/Run/Message/AgentBinding creation | CRITICAL | Task 6 Step 2 — 7-step entity chain documented |
| 24 | Memory recall tracking omitted (markRecallsInjected, detectReferencedRecallIds) | HIGH | Task 3 Step 2 — added to pipeline pseudocode |
| 25 | `memoryContext` not injected into agentic prompt messages | HIGH | Task 3 Step 2 — added as system message |
| 26 | `taskEvent.create` on failure missing | HIGH | Task 3 Step 2 — added to error handler |
| 27 | `recordToolEnd` needs `inputSummary` + `startedAt` — callback didn't provide | HIGH | Task 3 Step 1 — callback signature extended |
| 28 | `maxCostCents` declared but never enforced — no pricing lookup | HIGH | Task 3 Step 4 — noted as deferred to Phase 2 |
| 29 | Tool functions expect prompt strings, not structured args | HIGH | Task 2 Step 3 — dispatcher adapts args to prompt format |
| 30 | Only `single` routing mode supports tools — 4 others silently drop them | HIGH | Task 7 Step 1 — documented as known limitation |
| 31 | `toolCallingMode` parsed but never enforced in execution path | HIGH | Task 1 Step 7 — guard added in service.ts |
| 32 | Argument repair is just `{ _raw: raw }` — no streaming corruption recovery | HIGH | Acknowledged — deferred to Phase 2 (OpenClaw has full repair pipeline) |
| 33 | Role-based tool filtering absent — ROLE_POLICIES not consulted | HIGH | Acknowledged — legacy `src/` code, not imported by worker. Phase 2 task. |
| 34 | OpenAI format mapping (ToolSchemaDescriptor ↔ wire format) missing from pseudocode | HIGH | Task 1 Step 6 — mapToolsToOpenAi/mapToolCallsFromOpenAi added |

## [v3] Review Round 3 Findings

5 Claude explore agents verifying plan claims against actual source code line-by-line. Focus: factual accuracy of plan's code descriptions.

| # | Finding | Severity | Addressed In |
|---|---|---|---|
| 35 | `normalizeMiniMaxMessages` (connectors.ts:267-320) constructs flat-struct ProviderMessages — breaks on discriminated union | MEDIUM | Task 1 Step 1 — noted as known breaking site |
| 36 | `maybeSpawnChildAgent` creates 3 entities + PlanStep, not 7 — mailbox consumer creates Message/Run/Task async | INFO | Task 6 Step 2 already describes 2-phase flow via mailbox |
| 37 | All 3 deferred HIGHs (maxCostCents, argument repair, role filtering) verified as non-regressive | INFO | No changes needed — deferrals safe |

**Round 3 verdict: No new CRITICAL or HIGH findings. Plan is clean.**

---

## Success Criteria

After implementation:

1. An agent can iteratively call tools to answer complex questions (multi-step reasoning)
2. Tool use is model-driven, not keyword-driven
3. Tool policy on the agent record is enforced
4. Budget controls prevent runaway loops (iteration, time, tool call, token limits)
5. Per-agent budget overrides work via `budgetConfig` JSON
6. Transient errors (429, 500, 503) are retried with appropriate backoff
7. Context overflow triggers pair-aware message trimming
8. Sub-agent delegation happens through a tool call, not regex matching
9. All existing WebSocket/SSE events still fire correctly
10. Admin UI shows tool calls in real-time during the agentic loop
11. Memory retrieval and recall tracking still work
12. Loop detection breaks infinite repetition patterns
13. Per-tool timeouts prevent hung tools from blocking the loop
14. Concurrent execution of the same run is prevented
15. Tool results are truncated to prevent context explosion
16. Plan/workflow integration preserved (ensureRunPlanContext, maybeContinueParentWorkflow)
