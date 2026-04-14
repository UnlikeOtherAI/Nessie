# OpenClaw Agent Runtime Parity — Implementation Plan (v3, hardened)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Nessie's single-shot keyword-triggered agent execution into an OpenClaw-grade iterative agentic runtime where the model drives tool use, with budget controls, error recovery, context management, and structured sub-agent delegation.

**Architecture:** Replace the current `executeRunJob` pipeline (keyword-detect tools → one LLM call → done) with an iterative loop where: (1) tool schemas are injected into the model request, (2) the model decides which tools to call, (3) the worker executes tools and feeds results back, (4) the model iterates until it produces a final response or exhausts its budget. This follows OpenClaw's `runEmbeddedAttempt()` pattern but uses Nessie's existing Prisma/pgqueue/SSE/WebSocket infrastructure.

**Tech Stack:** TypeScript, Prisma, OpenAI-compatible API (tool calling), Zod, pgqueue, SSE, WebSocket

**Source document:** `docs/openclaw-architecture.md` (the overnight OpenClaw deep-dive)

**Review notes:** This plan has been through 3 review rounds. Round 1 (12 reviewers): 18 gaps addressed in v2. Round 2 (15 reviewers — 5 Claude explore agents + 10 max, each reading actual source): 16 additional gaps addressed in v3. Round 3 (5 Claude explore agents, line-by-line source verification): 0 new CRITICAL/HIGH findings — plan is clean. All 3 deferred HIGHs verified as non-regressive. Changes marked with `[v2]`/`[v3]` annotations.

---

## Gap Analysis (OpenClaw vs Nessie Today)

| Capability | OpenClaw | Nessie Today | Gap |
|---|---|---|---|
| **Agentic loop** | Iterative tool execution driven by model | Single-shot: keyword tools → 1 LLM call → done | **Critical** |
| **Native tool calling** | Tools injected as schemas, model emits `tool_calls` | `ProviderInvocationRequest` (runtime) has no `tools` field; schemas version does | **Critical** |
| **Tool policy enforcement** | `AgentToolsSchema` allow/deny/elevated/exec | `toolPolicy` JSON exists on Agent but is never read | **Critical** |
| **Budget controls** | Per-agent max iterations/wallclock/tokens/cost | None — single pass, no limits | **Critical** |
| **Error classification** | `FailoverReason` enum → recovery strategy | try/catch → mark failed | **High** |
| **Context management** | Token-aware compaction with summarization | Load last 20 messages, truncate to 220/400 chars | **High** |
| **Structured spawn** | `sessions_spawn` tool with announce protocol | Keyword-based "spawn"/"delegate" regex matching | **High** |
| **Loop detection** | `genericRepeat`, `knownPollNoProgress`, `pingPong` detectors | None | **High** |
| **Auth rotation** | Round-robin profiles with cooldown | Single API key from env var | Medium (Phase 2+) |
| **Hook system** | 29 lifecycle hooks for plugins | WebSocket events only | Medium (Phase 3+) |
| **Skills** | Versioned workspace snapshots | Not implemented | Medium (Phase 3+) |

This plan addresses the **Critical** and **High** gaps. Auth rotation, hooks, and skills are deferred to their respective phases in `implementation-phases.md`.

---

## Critical Codebase Facts (verified by reviewers)

Before implementing, the engineer must understand these structural realities:

### 1. Three `ProviderMessage` definitions exist

| Location | Shape | Used by |
|---|---|---|
| `packages/runtime/src/inference/types.ts:35-40` | Flat struct: `{ role: string, content: string, name?, toolCallId? }` | Runtime `InferenceService`, `ProviderConnector`, `ModelClient` |
| `packages/schemas/src/index.ts:1253-1259` | Zod schema with multimodal `content: string \| ContentPart[]` | Schemas package, API contracts |
| `api/src/contracts.ts:911-917` | Zod schema (same shape as schemas) | API route validation |

**The runtime version is the one the inference layer uses.** It must be extended to a discriminated union to carry tool-call and tool-result messages. The schemas and api versions already support `role: 'tool'` and `toolCallId` but lack `toolCalls` on the assistant variant.

### 2. `ModelMessage` blocks tool messages

`packages/runtime/src/model.ts:10-13` defines `ModelMessage = { role: 'system' | 'user' | 'assistant', content: string }`. This is what `RunInferenceGraphInput.baseMessages` accepts. **It cannot represent tool messages.** The agentic loop must bypass `ModelMessage` and work directly with `ProviderMessage`.

### 3. `runInferenceGraph` returns `MultiProviderResult`, not `InferenceResult`

`worker/src/run/inference.ts:1261` — `runInferenceGraph(prisma, input): Promise<MultiProviderResult>`. The return type has `{ finalAnswer, status, invocations, failure }` — not `{ outputText, toolCalls }`. The agentic loop's `runInference` callback must adapt this.

### 4. `packages/schemas` already has tool types

- `ToolSchemaDescriptor` (line 1261): `{ toolName, description, inputSchema }` — tool definition format
- `ProviderToolCall` (line 1364): `{ toolCallId, toolName, arguments, reason? }` — parsed tool call
- `ProviderInvocationRequest` schema (line 1372): already has `tools: ToolSchemaDescriptor[]` optional field
- `ProviderInvocationResult` schema (line 1386): already has `toolCalls: ProviderToolCall[]` field
- `ProviderStreamEvent` schema (line 1397): already has `tool_call.delta` and `response.error` variants

**Do NOT create duplicate types.** Use and extend the existing schemas types.

### 5. Streaming ignores tool calls

`connectors.ts` `collectChatStream` only extracts `delta.content` text. `OpenAiStreamChunk` and `OpenAiChatResponse` types have no `tool_calls` field. Both must be extended.

### 6. `loadAllowedToolIds` uses `TemporaryContextSession`

`worker/src/run/execute.ts:133-220` — The existing tool loading queries `temporaryContextSession` records scoped by run, thread, and agent. This scoping must be preserved in the new tool resolution.

### 7. `buildProviderRequest` drops unknown fields

`service.ts:34-47` explicitly picks only `correlationId`, `maxOutputTokens`, `messages`, `metadata`, `model`, `requestId`, `responseFormat`, `temperature`. New `tools`/`toolChoice` fields must be added here.

### 8. `BuiltinToolDefinition.id` is a literal union

`packages/runtime/src/builtin-tools.ts:3` — `id: 'document_read' | 'web_fetch' | 'web_search'`. Adding `spawn_subtask` requires widening this to `string` or extending the union.

### 9. [v3] `toolCallId` type mismatch between packages

`api/src/contracts.ts:1041` defines `toolCallId: z.string().uuid()` (strict UUID). `packages/schemas/src/index.ts:1365` defines `toolCallId: NonEmptyStringSchema` (any non-empty string). **OpenAI sends tool call IDs like `call_abc123xyz` — NOT UUIDs.** The api/contracts UUID validation will reject real tool calls from OpenAI. Must fix `api/contracts.ts` to use `NonEmptyStringSchema` before implementing tool calling.

### 10. [v3] `tools`/`toolChoice` must propagate through `executeStage`

`worker/src/run/inference.ts:530` — `executeStage` receives messages via `buildVisibleStageMessages` but its input type has no `tools`/`toolChoice` fields. The service calls at lines 582-598 (`service.stream`/`service.run`) don't forward tools. The full propagation chain is: `RunInferenceGraphInput.tools` → mode executor → `executeStage` input → `service.stream/run` → `buildProviderRequest` → connector. Every link must be updated.

### 11. [v3] `executeRunJob` has calls the plan must preserve

The plan's pseudocode omits several calls that exist in the current `executeRunJob`:
- `markDelegationStepFinished` (execute.ts:1017, 1097) — called in both success and error paths
- `markRecallsInjected` (execute.ts:925) — after loading memories
- `detectReferencedRecallIds` + `markRecallsReferenced` (execute.ts:980-982) — after getting response
- `taskEvent.create` with `eventType: 'run.failed'` (execute.ts:1130) — in error handler
- `memoryContext` injection as system message (execute.ts:788-793) — into model prompt

### 12. [v3] `recordToolEnd` requires `inputSummary` and `startedAt`

`worker/src/run/execute.ts:502-512` — `recordToolEnd` requires `inputSummary: string` and `startedAt: Date` params. The plan's `onToolCallEnd` callback signature `(name, result, duration, success)` omits both. Must be extended.

### 13. [v3] `WsEventSchema` is a closed Zod union

New WebSocket events like `agent.iteration` must be added to `WsEventSchema` in `packages/schemas/src/index.ts` (and its handlers in admin hooks), or `publishWs` will reject them at the transport validation layer.

### 14. [v3] Tool functions expect prompt strings, not structured args

`runWebFetchTool` calls `extractUrl(prompt)` to regex-match URLs from a natural language string. `runDocumentReadTool` calls `selectDocumentPath(prompt)` which tokenizes for semantic matching. The plan's `executeBuiltinTool` passes `String(args.url)` and `String(args.query)` — these work but produce different behavior than the current prompt-based path. `runWebFetchTool` should be refactored to accept a direct URL parameter.

---

## Task 1: Native Tool Calling in the Inference Layer

**Why:** The agentic loop requires the model to request tool calls. Today the runtime's `ProviderInvocationRequest` only accepts messages — no tool schemas, no tool choice, no tool call parsing. This is the foundation everything else builds on.

**OpenClaw parallel:** `pi-agent-core` execution with tool schema injection + `tool-call-normalization.ts` + `tool-call-argument-repair.ts`

**Files:**
- Modify: `packages/runtime/src/inference/types.ts`
- Modify: `packages/runtime/src/inference/connectors.ts`
- Modify: `packages/runtime/src/inference/service.ts`
- Modify: `packages/runtime/src/model.ts`
- Modify: `api/src/contracts.ts` (fix toolCallId UUID → string) [v3]
- Test: `packages/runtime/src/__tests__/inference-tool-calling.test.ts` (create)

### Step 1: Extend runtime `ProviderMessage` to a discriminated union

In `packages/runtime/src/inference/types.ts`, replace the flat `ProviderMessage` with a discriminated union that can carry tool-call and tool-result messages:

```typescript
// [v2] Aligned with packages/schemas ProviderToolCall shape
export type ProviderToolCall = {
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}

// [v2] Discriminated union — replaces flat struct
export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ProviderToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string }
```

**Critical:** The new `ProviderToolCall` uses the same field names as `packages/schemas` (`toolCallId`, `toolName`, `arguments`) — NOT OpenAI's wire format (`id`, `function.name`, `function.arguments`). The connector is responsible for the translation.

Update all call sites in connectors.ts and service.ts that construct `ProviderMessage` to conform to the union. **[v3] Known breaking site:** `normalizeMiniMaxMessages` (connectors.ts lines 267-320) constructs messages with the flat struct pattern — must be updated to use the discriminated union variants.

### Step 2: Extend `ProviderInvocationRequest` and `ProviderInvocationResult`

In `packages/runtime/src/inference/types.ts`:

```typescript
// [v2] Aligned with packages/schemas ToolSchemaDescriptor
export type ToolSchemaDescriptor = {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

// Extend ProviderInvocationRequest — add tools + toolChoice
export type ProviderInvocationRequest = {
  // ... existing fields ...
  tools?: ToolSchemaDescriptor[]
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
}

// Extend ProviderInvocationResult — add toolCalls
export type ProviderInvocationResult = {
  // ... existing fields ...
  toolCalls: ProviderToolCall[]  // [v2] non-optional, default to [] — matches schemas
}
```

Extend `InferenceRequest`, `InferenceResult`, `InferenceStreamEvent` with the same fields:

```typescript
export type InferenceRequest = {
  // ... existing fields ...
  tools?: ToolSchemaDescriptor[]
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
}

export type InferenceResult = {
  // ... existing fields ...
  toolCalls: ProviderToolCall[]  // [v2] always present, empty array if no calls
}

// [v2] Add tool_call.delta and response.error — already in schemas
export type ProviderStreamEvent =
  | { type: 'output_text.delta'; text: string }
  | { type: 'tool_call.delta'; text: string }
  | { type: 'response.error'; message: string; retryable: boolean }
```

### Step 3: Extend OpenAI connector types and parsing

In `packages/runtime/src/inference/connectors.ts`:

1. Add `tool_calls` to `OpenAiChatResponse`:
```typescript
type OpenAiChatResponse = {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  }>
  model?: string
  usage?: OpenAiUsage
}
```

2. Add `tool_calls` to `OpenAiStreamChunk.choices[].delta`:
```typescript
type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: OpenAiUsage
}
```

3. Add `toolCalls` to `CapturedStreamResult`:
```typescript
type CapturedStreamResult = {
  finishReason?: NormalizedFinishReason
  outputText: string
  toolCalls: ProviderToolCall[]  // [v2]
  usage: InvocationUsage
}
```

4. **[v2] Update `collectChatStream`** to accumulate incremental `tool_calls` deltas:
```typescript
// Inside collectChatStream, add tool call accumulation:
const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>()

// In the chunk processing loop:
for (const tc of delta.tool_calls ?? []) {
  const existing = toolCallAccumulator.get(tc.index) ?? { id: '', name: '', args: '' }
  if (tc.id) existing.id = tc.id
  if (tc.function?.name) existing.name += tc.function.name
  if (tc.function?.arguments) existing.args += tc.function.arguments
  toolCallAccumulator.set(tc.index, existing)
}

// At the end, convert accumulated calls to ProviderToolCall[]:
const toolCalls: ProviderToolCall[] = [...toolCallAccumulator.values()].map((tc) => ({
  toolCallId: tc.id,
  toolName: tc.name,
  arguments: safeParseJson(tc.args),
}))
```

5. Add a safe JSON parser for tool call arguments:
```typescript
const safeParseJson = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { _raw: raw }
  }
}
```

6. In the OpenAI connector's `invoke()` method:
   - Pass `tools` (mapped to OpenAI format) and `tool_choice` to the request body when present
   - Parse `tool_calls` from `response.choices[0].message.tool_calls`
   - Map OpenAI wire format (`id`, `function.name`, `function.arguments`) to `ProviderToolCall` (`toolCallId`, `toolName`, `arguments`)
   - Return `toolCalls` on `ProviderInvocationResult`

7. **[v2] Handle `toolCallingMode`:** The connector already reports `toolCallingMode` in capabilities. When `toolCallingMode === 'disabled'`, strip `tools`/`tool_choice` from the request. When `toolCallingMode === 'prompt-translated'` (MiniMax), do NOT send `tools` in the request body — instead, inject tool descriptions into the system prompt as text. Actual prompt-translation logic is deferred to Phase 2, but the guard must exist now to prevent MiniMax from receiving unsupported `tools` field.

### Step 4: Wire tool fields through InferenceService

In `packages/runtime/src/inference/service.ts`:

1. **[v2] Update `buildProviderRequest`** to forward `tools` and `toolChoice`:
```typescript
const buildProviderRequest = (
  request: InferenceRequest,
  requestId: string,
  model: string,
): ProviderInvocationRequest => ({
  correlationId: buildCorrelationId(request),
  maxOutputTokens: request.maxOutputTokens,
  messages: request.messages,
  metadata: request.metadata,
  model,
  requestId,
  responseFormat: request.responseFormat,
  temperature: request.temperature,
  tools: request.tools,        // [v2] NEW
  toolChoice: request.toolChoice, // [v2] NEW
})
```

2. **Update `buildInferenceResult`** to surface `toolCalls`:
```typescript
const buildInferenceResult = (
  provider: ModelProviderConfig['provider'],
  model: string,
  result: {
    // ... existing fields ...
    toolCalls: ProviderToolCall[]  // [v2] NEW
  },
): InferenceResult => ({
  // ... existing fields ...
  toolCalls: result.toolCalls,
})
```

3. Update both `run()` and `stream()` to pass `toolCalls` through from connector result to inference result.

### Step 5: [v3] Fix `toolCallId` UUID validation in api/contracts.ts

**Prerequisite fix** — `api/src/contracts.ts:1041` has `toolCallId: z.string().uuid()` but OpenAI sends non-UUID IDs like `call_abc123xyz`. Change to match `packages/schemas`:

```typescript
// api/src/contracts.ts — fix line 1041
toolCallId: z.string().min(1),  // was z.string().uuid() — OpenAI sends non-UUID IDs
```

### Step 6: [v3] Add OpenAI format mapping in the connector

The connector must map between Nessie's `ToolSchemaDescriptor` format and OpenAI's wire format:

```typescript
// In the OpenAI connector, before building the request body:
const mapToolsToOpenAi = (tools: ToolSchemaDescriptor[]): OpenAiToolDef[] =>
  tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.toolName,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))

// And the reverse — mapping OpenAI response tool_calls to ProviderToolCall:
const mapToolCallsFromOpenAi = (
  toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
): ProviderToolCall[] =>
  toolCalls.map((tc) => ({
    toolCallId: tc.id,           // OpenAI's "call_abc123" format
    toolName: tc.function.name,
    arguments: safeParseJson(tc.function.arguments),
  }))
```

### Step 7: [v3] Add `toolCallingMode` guard in service.ts

The guard belongs in `service.ts` (not the connector), because `service.ts` has access to capabilities:

```typescript
// In service.ts run() and stream(), after resolving capabilities:
const effectiveTools = capabilities.effectiveSnapshot.toolCallingMode === 'disabled'
  ? undefined
  : capabilities.effectiveSnapshot.toolCallingMode === 'prompt-translated'
    ? undefined  // MiniMax — don't send tools in request body; Phase 2 adds prompt injection
    : request.tools

const providerRequest = buildProviderRequest(request, requestId, model)
// Override tools based on capability check:
providerRequest.tools = effectiveTools
providerRequest.toolChoice = effectiveTools ? request.toolChoice : undefined
```

### Step 8: Write tests

Test file: `packages/runtime/src/__tests__/inference-tool-calling.test.ts`

Tests:
- Tool definitions in `ToolSchemaDescriptor` format are mapped to OpenAI `tools` format in the request body
- Tool calls in the response are parsed into `ProviderToolCall[]`
- `finishReason: 'tool-call'` is set when response contains tool calls
- When no tools are provided, request body has no `tools` field
- Malformed tool call arguments (invalid JSON) fall back to `{ _raw: ... }`
- `toolCallingMode: 'disabled'` strips tools from request
- `toolCallingMode: 'prompt-translated'` strips tools from request (defers to Phase 2)
- Streaming accumulates incremental tool call deltas correctly
- Empty `toolCalls` array (not undefined) when model doesn't call tools
- [v3] OpenAI non-UUID tool call IDs (`call_abc123`) are accepted
- [v3] `mapToolsToOpenAi` correctly maps `toolName` → `function.name` and `inputSchema` → `function.parameters`

### Step 9: Commit

```
feat(runtime): add native tool calling support to inference layer
```

---

## Task 2: Tool Definition Registry and Policy Gateway

**Why:** The agentic loop needs to know which tools exist, their schemas, and whether the current agent is allowed to use them. Today `toolPolicy` on the Agent model is never read.

**OpenClaw parallel:** `AgentToolsSchema` with allow/deny + `tools/` directory with tool registration

**Files:**
- Create: `worker/src/run/tool-registry.ts`
- Create: `worker/src/run/tool-policy.ts`
- Modify: `packages/runtime/src/builtin-tools.ts`
- Modify: `worker/src/run/tools.ts`

### Step 1: Expand builtin tool definitions with schemas

In `packages/runtime/src/builtin-tools.ts`, widen the `id` type and add `parameters` (JSON Schema) to each tool:

```typescript
export type BuiltinToolDefinition = {
  id: string                     // [v2] was literal union — widened for spawn_subtask
  label: string
  description: string
  safe: boolean
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: 'web_search',
    label: 'Web Search',
    description: 'Search the public web. Returns top 3 results with titles and URLs.',
    safe: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    id: 'web_fetch',
    label: 'Web Fetch',
    description: 'Fetch and read a public URL. Returns the text content.',
    safe: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    id: 'document_read',
    label: 'Document Read',
    description: 'Read a project-local document by path or topic. Returns markdown content.',
    safe: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Document path or topic to search for' },
      },
      required: ['query'],
    },
  },
]

export const BUILTIN_TOOL_IDS = new Set(
  BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id),
)
```

### Step 2: Create the tool policy gateway

Create `worker/src/run/tool-policy.ts`:

```typescript
import type { ToolSchemaDescriptor } from '@nessie/runtime'
import type { BuiltinToolDefinition } from '@nessie/runtime'

type ToolPolicy = Record<string, boolean> // true=allowed, false=denied

type ResolvedToolSet = {
  descriptors: ToolSchemaDescriptor[]    // schemas to send to the model
  allowedIds: Set<string>                // IDs the agent may execute
}

/**
 * Resolve which tools an agent can use.
 *
 * [v2] Preserves existing TemporaryContextSession scoping from loadAllowedToolIds.
 *
 * 1. Start with the set of enabled tools from the registry (DB query)
 * 2. Intersect with TemporaryContextSession tool scoping (if sessions exist)
 * 3. Apply agent.toolPolicy overrides (true = force-allow, false = force-deny)
 * 4. Convert to ToolSchemaDescriptor[] for the model
 */
export const resolveAgentTools = (
  enabledToolIds: Set<string>,
  allToolDefinitions: BuiltinToolDefinition[],
  agentToolPolicy: ToolPolicy | null,
  parentAgentId: string | null,
): ResolvedToolSet => {
  const allowedIds = new Set<string>()

  for (const tool of allToolDefinitions) {
    const policyOverride = agentToolPolicy?.[tool.id]
    if (policyOverride === false) continue           // explicitly denied
    if (policyOverride === true || enabledToolIds.has(tool.id)) {
      allowedIds.add(tool.id)
    }
  }

  // [v2] Child agents cannot spawn further children (depth=1 for now)
  if (parentAgentId) {
    allowedIds.delete('spawn_subtask')
  }

  const descriptors: ToolSchemaDescriptor[] = allToolDefinitions
    .filter((tool) => allowedIds.has(tool.id))
    .map((tool) => ({
      toolName: tool.id,                    // [v2] uses ToolSchemaDescriptor shape
      description: tool.description,
      inputSchema: tool.parameters,
    }))

  return { descriptors, allowedIds }
}
```

### Step 3: Refactor tool execution to accept parsed arguments

Update `worker/src/run/tools.ts` — add a structured dispatcher alongside existing functions:

```typescript
// [v2] Max tool result size — prevents unbounded tool output from blowing context
const MAX_TOOL_RESULT_CHARS = 32_000

const truncateToolResult = (output: string): string =>
  output.length > MAX_TOOL_RESULT_CHARS
    ? output.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[output truncated]'
    : output

// [v3] New result type — the existing ToolExecutionResult (inputSummary, outputPreview, toolName)
// is kept for the old call path. This new type is for the agentic loop.
export type AgenticToolResult = {
  inputSummary: string   // [v3] needed by recordToolEnd
  output: string
  success: boolean
}

// [v3] Tool functions expect natural-language prompt strings internally.
// The dispatcher converts structured args back to the format each tool expects.
// This is intentional — refactoring the tool internals is a separate task.
export const executeBuiltinTool = async (
  toolName: string,
  args: Record<string, unknown>,
): Promise<AgenticToolResult> => {
  const inputSummary = JSON.stringify(args).slice(0, 200)

  switch (toolName) {
    case 'web_search':
      return wrapTool(inputSummary, () => runWebSearchTool(String(args.query ?? '')))
    case 'web_fetch':
      // [v3] Pass URL directly — extractUrl will regex-match it.
      // SSRF protection in assertSafeFetchUrl is preserved.
      return wrapTool(inputSummary, () => runWebFetchTool(String(args.url ?? '')))
    case 'document_read':
      return wrapTool(inputSummary, () => runDocumentReadTool(String(args.query ?? '')))
    default:
      return { inputSummary, output: `Unknown tool: ${toolName}`, success: false }
  }
}

const wrapTool = async (
  inputSummary: string,
  fn: () => Promise<{ outputPreview: string }>,
): Promise<AgenticToolResult> => {
  try {
    const result = await fn()
    return { inputSummary, output: truncateToolResult(result.outputPreview), success: true }
  } catch (error) {
    return {
      inputSummary,
      output: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    }
  }
}
```

### Step 4: Commit

```
feat(worker): add tool policy gateway and structured tool dispatch
```

---

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
