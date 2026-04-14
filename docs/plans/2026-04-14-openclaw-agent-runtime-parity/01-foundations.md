# Foundations

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
