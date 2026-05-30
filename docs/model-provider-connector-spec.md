# Model Provider Connector and Orchestration System

> Status: target-state design.

## 1) Objective

Build one provider-agnostic inference layer that lets Nessie switch
between model providers, route one request across multiple providers
when needed, and account for every physical model call in the token
ledger.

This document is the model-provider specialization of
[provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md)
section 2. It refines the infrastructure/provider rules for inference
without changing the frontend facade rules in that document.

This system must:

- support swappable providers and provider-native model names without worker rewrites,
- expose capability information at the model level, not just the provider level,
- support providers that do not have native tool calling,
- support admin-only orchestration profiles that run multiple providers
  for the same request,
- return an invocation array for every request so ledger ingestion is complete,
- keep provider credentials and routing policy out of agent prompts and
  user-controlled state.

## 2) Core rules

- the worker must not contain provider-specific `if provider === ...`
  behavior beyond connector registration.
- provider and model identity must be stored as raw strings, not fixed enums.
- capability decisions are model-scoped. Provider defaults are hints only.
- tool use is an explicit strategy on the selected model route:
  - `native`
  - `prompt-translated`
  - `disabled`
- every physical model call produces its own invocation record, including:
  - primary answer generation,
  - tool-translation helper calls,
  - judge calls,
  - committee/shadow calls,
  - embeddings or other helper calls tied to the request.
- the top-level request result may contain one final answer but it must
  still expose all underlying invocation records.
- advanced orchestration profiles are admin-only by default.
- do not interleave multiple provider token streams into one visible
  transcript. That produces incoherent output.

## 3) Terms

- **connector**: provider adapter responsible for auth, request
  normalization, transport, and response normalization.
- **capability snapshot**: normalized description of what one
  provider/model pair can do.
- **routing profile**: what an agent actually selects. Can point to one
  model or an orchestration plan.
- **stage**: one node in a routing profile that calls one provider/model
  for one role in the flow.
- **tool mediator**: logic that turns model intent into executable tool
  calls when native tools are unavailable.
- **invocation record**: one physical call to one provider/model with
  usage, latency, and metadata.

## 4) Target architecture

```text
worker / api
  -> InferenceService
      -> ConnectorRegistry
          -> ProviderConnector (OpenAI, Anthropic, Gemini, MiniMax, custom, ...)
      -> CapabilityCatalog
      -> ToolMediator
      -> OrchestrationEngine
      -> InvocationRecorder
          -> TokenLedgerEvent writer
```

Recommended package layout:

```text
packages/runtime/src/inference/
  connectors/
  capabilities/
  mediation/
  orchestration/
  ledger/
```

This replaces the current narrow `ModelClient` abstraction. Keep a
compatibility shim only long enough to migrate callers.

## 5) Connector contract

```ts
export type ToolCallingMode = 'native' | 'prompt-translated' | 'disabled'
export type StructuredOutputMode = 'native-json' | 'prompt-json' | 'text-only'
export type SystemPromptMode = 'native' | 'fold-into-user'
export type ToolResultMode = 'native-tool-message' | 'context-block'
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown'
export type NormalizedFinishReason = 'stop' | 'length' | 'tool-call' | 'content-filter' | 'error' | 'other'
export type ProviderMessageContentPart = { type: 'text'; text: string } | { type: 'image'; imageUrl: string }

export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ProviderMessageContentPart[]
  name?: string
  toolCallId?: string
}

export type ToolSchemaDescriptor = { toolName: string; description: string; inputSchema: Record<string, unknown> }
export type ToolCallIntent = { toolName: string; arguments: Record<string, unknown>; reason?: string }
export type StructuredOutputDescriptor = { name: string; jsonSchema: Record<string, unknown> }

export type ModelCapabilitySnapshot = {
  provider: string
  model: string
  displayName?: string
  supportsModelDiscovery: boolean
  supportsChat: boolean
  supportsStreaming: boolean
  supportsEmbeddings: boolean
  supportsVision: boolean
  toolCallingMode: ToolCallingMode
  structuredOutputMode: StructuredOutputMode
  systemPromptMode: SystemPromptMode
  toolResultMode: ToolResultMode
  usageReporting: {
    inputTokens: boolean
    outputTokens: boolean
    cachedInputTokens: boolean
    cachedOutputTokens: boolean
    cacheReadTokens: boolean
    cacheWriteTokens: boolean
    providerReportedCost: boolean
  }
  maxInputTokens?: number
  maxOutputTokens?: number
  source: 'static' | 'live' | 'manual'
  discoveredAt: string
  lastVerifiedAt?: string
}

export type CapabilityResolution = { effectiveSnapshot: ModelCapabilitySnapshot; effectiveSource: 'override' | 'static' | 'live' | 'manual'; overrideActive: boolean }
export type InvocationUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cachedOutputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number }

export type InvocationRecord = {
  invocationId: string
  requestId: string
  correlationId?: string
  provider: string
  model: string
  operationType:
    | 'chat'
    | 'completion'
    | 'embedding'
    | 'translation'
    | 'reasoning'
    | 'tool-translation'
    | 'other'
  usage: InvocationUsage
  providerReportedCost?: { amount: number; currency: string }
  latencyMs: number
  finishReason?: NormalizedFinishReason
  metadata?: Record<string, unknown>
}

export type ProviderToolCall = { toolCallId: string; toolName: string; arguments: Record<string, unknown>; reason?: string }

export type ProviderInvocationRequest = {
  requestId: string
  correlationId?: string
  model: string
  messages: ProviderMessage[]
  tools?: ToolSchemaDescriptor[]
  expectedStructuredOutput?: StructuredOutputDescriptor
  maxOutputTokens?: number
  metadata?: Record<string, unknown>
}

export type ProviderInvocationResult = {
  outputText: string
  toolCalls: ProviderToolCall[]
  structuredOutput?: unknown
  finishReason?: NormalizedFinishReason
  invocation: InvocationRecord
}

export type ProviderStreamEvent =
  | { type: 'output_text.delta'; text: string }
  | { type: 'tool_call.delta'; text: string }
  | { type: 'response.error'; message: string; retryable: boolean }

export type InferenceRequest = {
  requestId: string
  correlationId?: string
  actorContext: AuthorizedActionContext
  route:
    | { provider: string; model: string; routingProfileId?: never }
    | { routingProfileId: string; provider?: never; model?: never }
  messages: ProviderMessage[]
  tools?: ToolSchemaDescriptor[]
  expectedStructuredOutput?: StructuredOutputDescriptor
  metadata?: Record<string, unknown>
}

export type ProviderHealthReport = { status: ProviderHealthStatus; checkedAt: string; latencyMs?: number; message?: string }

export interface ProviderConnector {
  readonly provider: string
  getProviderMeta(): Promise<{
    provider: string
    displayName: string
    supportsModelDiscovery: boolean
  }>
  listModels(): Promise<ModelCapabilitySnapshot[]>
  getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot>
  checkHealth(): Promise<ProviderHealthReport>
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>
  stream?(
    request: ProviderInvocationRequest,
  ): AsyncGenerator<
    ProviderStreamEvent,
    ProviderInvocationResult,
    undefined
  >
  close(): void
}

export type ProviderConnectionConfig = {
  providerKey: string
  baseUrl?: string
  credentialBindingId?: string
}

export interface ConnectorRegistry {
  getConfigured(config: ProviderConnectionConfig): Promise<ProviderConnector>
  listRegistered(): Promise<string[]>
}

export interface CapabilityCatalog {
  resolve(provider: string, model: string): Promise<CapabilityResolution>
}

export interface ToolMediator {
  translateToolIntent(input: {
    requestId: string
    correlationId?: string
    rawIntentBlock: string
    toolSchemas: ToolSchemaDescriptor[]
  }): Promise<ToolCallIntent>
  repairStructuredOutput(input: {
    requestId: string
    correlationId?: string
    rawOutput: string
    targetSchema: StructuredOutputDescriptor
  }): Promise<unknown>
}

export type InferenceStreamEvent = { type: 'output_text.delta'; text: string } | { type: 'stage.status'; stageId: string; status: 'started' | 'completed' | 'failed' }

export interface InferenceService {
  run(request: InferenceRequest): Promise<MultiProviderResult>
  stream?(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamEvent, MultiProviderResult, undefined>
}
```

Rules:

- `requestId` is the top-level turn identifier. In Nessie it must equal
  `AuthorizedActionContext.actionContext.requestId`.
- `AuthorizedActionContext` is defined in
  [shared-type-contracts-spec.md](./shared-type-contracts-spec.md).
- helper calls use the same `requestId`. `correlationId` groups the
  helper calls that belong to one turn or one tool loop.
- if `supportsModelDiscovery = false`, `listModels()` returns an empty
  array and the admin UI shows the provider plus a manual model field.
- if `supportsStreaming = true`, the connector must implement `stream()`.
- save-time validation must reject connectors that advertise
  `supportsStreaming = true` but omit `stream()`.
- connector streaming yields incremental events only. The final
  `ProviderInvocationResult` is returned from the generator, not emitted
  as a duplicate terminal event.
- `maxInputTokens` and `maxOutputTokens` are admission limits, not hints.
  The orchestration layer must trim or reject before calling the
  connector.
- provider quirks such as system-message folding, streaming payload
  shape, or usage field mapping live inside the connector only.
- `SystemPromptMode = 'native'` means the connector preserves `system`
  role messages.
- `SystemPromptMode = 'fold-into-user'` means the connector rewrites the
  system message into a deterministic prefix on the first user message.
- `ToolResultMode = 'native-tool-message'` means the connector sends tool
  output through the provider's native tool-result channel.
- `ToolResultMode = 'context-block'` means the connector injects the
  deterministic `NESSIE_TOOL_RESULT` block defined in section 8.5.
- `finishReason` must be normalized to the shared vocabulary above.
- connectors must normalize back into the same `InvocationRecord` shape
  regardless of provider.
- `checkHealth()` is the source of truth for `InferenceProvider.health_status`.

## 6) Capability catalog

The system needs a real capability catalog instead of assuming provider-wide behavior.

Sources, in precedence order:

1. admin manual override,
2. latest verified manual model snapshot,
3. provider live discovery/probe,
4. checked-in static defaults.

Rules:

- live discovery is optional per provider.
- capability snapshots are cached and versioned.
- agent/runtime selection uses the cached snapshot, not a live network
  probe on every request.
- if a provider changes behavior and a request fails due to capability
  mismatch, mark the snapshot stale and re-verify asynchronously.
- `source` on `ModelCapabilitySnapshot` describes where the observed
  snapshot came from. It does not describe precedence by itself.
- the effective precedence order is:
  1. active admin override,
  2. latest verified manual model snapshot,
  3. latest verified live-discovery snapshot,
  4. checked-in static default.
- in v1, admin override is a full-snapshot replacement, not a field
  patch. Async re-verification may update the observed snapshot but must
  not overwrite the effective override until the override is cleared.
- manual models are mandatory for providers without discovery. A manual
  model is not runnable until:
  - an `InferenceModel` record exists,
  - `capability_snapshot_json` contains all required core fields,
  - an admin explicitly sets `enabled = true`.
- required core fields for a manual model are `supportsChat`,
  `supportsStreaming`, `supportsEmbeddings`, `supportsVision`,
  `toolCallingMode`, `structuredOutputMode`, `systemPromptMode`,
  `toolResultMode`, and `usageReporting`.

## 7) Routing profiles

Agents should not directly own secrets or orchestration logic.

They should reference a routing profile:

```ts
export type RoutingMode =
  | 'single'
  | 'fallback'
  | 'committee'
  | 'pipeline'
  | 'shadow'
export type StreamPolicy = 'primary-only' | 'buffered-judge'
export type StageRole = 'advisor' | 'executor' | 'synthesizer' | 'judge' | 'shadow'

export type RouteStage = {
  id: string
  role: StageRole
  provider: string
  model: string
  toolCallingMode?: ToolCallingMode
  inputFrom?: string[]
  userVisible?: boolean
  maxAttempts?: number
}

export type RoutingProfile = {
  id: string
  label: string
  enabled: boolean
  exposure: 'standard' | 'admin-only'
  mode: RoutingMode
  streamPolicy: StreamPolicy
  toolMediatorId?: string
  stages: RouteStage[]
}

export type CandidateOutput = {
  stageId: string
  stageRole: StageRole
  outputText: string
  structuredOutput?: unknown
  toolCalls?: ToolCallIntent[]
  invocationIds: string[]
  finishReason?: NormalizedFinishReason
  metadata?: Record<string, unknown>
}

export type StageExecutionInput = { baseMessages: ProviderMessage[]; upstream: CandidateOutput[] }
```

Rules:

- `single`: one stage produces the final answer.
- `fallback`: ordered executor stages. Only the first successful stage
  may produce the final answer.
- `committee`: multiple advisor stages run in parallel and feed one
  synthesizer or executor stage.
- `pipeline`: one stage feeds the next intentionally, for example
  planner -> executor -> judge.
- `shadow`: one visible execution stage plus one or more shadow stages
  used for evaluation, telemetry, or regression comparison.
- `exposure = admin-only` hides the profile from normal users and
  standard agent creation flows.
- `stages` is the canonical representation. Simple routes are just small
  graphs.
- stage IDs must be unique within a profile.
- exactly one stage in the profile may have `userVisible = true`, and it
  must be terminal.
- `userVisible` defaults to `false` for all non-terminal stages.
- `toolCallingMode` defaults to the resolved capability snapshot for the
  selected stage model.
- `single` and `fallback` may only contain executor stages.
- `committee` requires:
  - two or more advisor stages,
  - exactly one terminal synthesizer or executor stage,
  - optional judge stages that are never `userVisible`.
- committee advisor stages are roots and must not declare `inputFrom`.
- `pipeline` must be acyclic. Every non-root stage must declare
  `inputFrom`.
- reject missing `inputFrom` references, cycles, or profiles with no
  explicit `userVisible = true` stage at save time.
- `shadow` requires exactly one visible non-shadow stage plus one or
  more shadow stages.
- `inputFrom` is ordered. The orchestration engine builds one
  deterministic `StageExecutionInput` from those upstream candidates and
  injects it as a labeled context block. Stages do not receive raw
  parallel transcripts.
- all multi-provider profiles still end in one user-visible terminal
  stage that owns the final answer.
- `toolMediatorId` is required whenever any stage uses
  `prompt-translated` tool calling or structured-output repair.

For current schema compatibility, keep `Agent.provider` and
`Agent.model` as the simple path, add optional `Agent.routingProfileId`,
and treat `routingProfileId` as the source of truth when present.

## 8) Tool mediation for models without native tool calling

State terms:

- **turn**: one user request from entry into `InferenceService.run()`
  until terminal success or terminal failure.
- **round**: one model invocation within a turn for the current tool
  owner.
- **tool consumption**: the point at which a validated tool call starts
  executing.
- **tool owner**: the single stage allowed to execute tools in the
  current turn.

### 8.1 Strategy modes

- `native`: provider emits structured tool calls directly.
- `prompt-translated`: model emits a textual intent block, then Nessie
  translates it into canonical JSON.
- `disabled`: tool definitions are not shown to the model.

### 8.2 Prompt-translated tool flow

For models without native tools, inject a strict instruction:

```text
If you need a tool, do not describe the tool call in prose.
Emit exactly one block in this format and then stop:

<<NESSIE_TOOL_INTENT>>
tool: <tool-name>
arguments:
<single JSON object>
reason: <short sentence>
<<END_NESSIE_TOOL_INTENT>>
```

Rules:

- v1 supports one tool intent block per round. If more tools are needed, loop.
- if the `arguments` block parses as valid JSON and passes schema
  validation, execute directly.
- if parsing fails but the intent block exists, call a cheap translator
  route to convert the block into canonical JSON.
- if translation is ambiguous or schema validation fails, fail closed.
  Do not execute a guessed tool call.
- translator calls must be logged as separate invocation records with
  `operationType = 'tool-translation'`.
- once a tool call is consumed, tool ownership is pinned to the current
  stage for the rest of the turn.
- fallback may happen only before tool consumption.
- if a stage fails after a side-effectful tool executes, retry the same
  stage or fail the turn. Do not hand tool ownership to another stage.

### 8.3 Translator contract

The cheap translator route receives:

- the raw tool intent block,
- the allowed tool schemas for this turn.

It returns:

```ts
type ToolCallIntent = {
  toolName: string
  arguments: Record<string, unknown>
  reason?: string
}
```

Rules:

- `arguments` must always be validated against the selected tool schema
  before execution.
- translator invocations reuse the parent `requestId` and `correlationId`.
- the orchestration layer, not the connector, owns tool-loop state and
  decides whether translation is attempted.

### 8.4 Structured output fallback

The same pattern should handle structured final outputs when
`structuredOutputMode !== 'native-json'`.

Rules:

- first ask the primary model for a strict JSON block.
- if the block parses and validates, return it directly.
- if the model cannot reliably emit valid JSON, run the same cheap
  translator route against the raw output and target schema.
- record that helper call as a separate invocation record with
  `operationType = 'translation'`.
- `structuredOutput` fallback requires a configured tool mediator. Do not
  silently invent a second fixer path.

Do not build a second provider-specific "JSON fixer" path outside the
mediation layer.

### 8.5 Feeding tool results back

When the selected model lacks native tool message support, the connector
must feed tool results back as a labeled context block, for example:

```text
<<NESSIE_TOOL_RESULT>>
tool: web_search
payload:
<tool output here>
<<END_NESSIE_TOOL_RESULT>>
```

That behavior is capability-driven through `toolResultMode`, not
hardcoded in the worker.

Responsibility split:

- connector: provider-specific prompt folding, native message layout,
  stream-event normalization, and capability-driven tool-result
  formatting.
- tool mediator: translation and repair for tool intent or structured
  JSON output.
- orchestration engine: turn state, retries, fallback decisions, stage
  graph traversal, and final-answer ownership.

## 9) Orchestration modes

### 9.1 Single

Default path for normal chat. Lowest latency and lowest cost.

### 9.2 Fallback

Use when a provider is preferred but not required.

Rules:

- fallback is for availability or hard incompatibility, not for silent
  answer shopping.
- executor stages run in order. Only the first successful stage may
  produce the final answer.
- every attempted provider call produces its own invocation record.
- **mid-turn fallback**: if primary fails before tool consumption, the
  fallback stage receives the last committed conversation state from
  before the failed round started. Earlier committed tool results may be
  present and are re-encoded for the fallback stage's `toolResultMode`;
  the failed round never synthesizes a new tool-result block.
- the orchestration engine owns fallback decisions and passes the
  reconstructed message state to the next stage.

### 9.3 Committee

Use when multiple providers contribute to one answer before the
terminal stage synthesizes.

Rules:

- advisor stages run in parallel against the same normalized request.
- each advisor normalizes its output into a `CandidateOutput` before the
  terminal stage.
- only one terminal stage may produce the user-facing answer.
- if a judge stage exists, it ranks or filters candidate outputs but
  does not stream.
- record every advisor and judge invocation separately.
- advisor failure does not fail the turn if at least one candidate still
  reaches the terminal stage.
- if all advisor stages fail, the turn fails.

### 9.4 Pipeline

Use when provider outputs are intentionally sequential rather than
parallel: planner -> executor, generator -> critic -> reviser, or
retrieval summarizer -> answer model.

Rules:

- each stage consumes normalized output from named upstream stages.
- only the terminal stage may emit the final user-facing answer.
- keep pipeline width narrow in v1. Linear flows are enough.
- any failed required upstream stage fails the pipeline unless the
  profile explicitly includes a fallback path.

### 9.5 Shadow

Use when another provider should observe the same request without owning
the user-facing answer.

Rules:

- the visible stage owns the answer.
- shadow stages never affect the live transcript in v1.
- for evaluation, telemetry, or regression comparison only.
- shadow failure is recorded in telemetry but does not fail the live turn
  in v1.

### 9.6 Tool execution ownership

Tool execution must have exactly one owner per turn. Rules:

- only executor and synthesizer stages may execute tools by default.
- advisor and shadow stages should default to
  `toolCallingMode = 'disabled'`.
- if a non-native-tools provider owns tool execution, use the
  prompt-translated mediation path and log that translation as a
  separate invocation.
- a turn has exactly one tool owner. Do not hand tool execution to a
  second stage after a tool call has been consumed.

### 9.7 Streaming policy

For interactive chat, the only sane default is:

- stream only from the terminal user-visible stage,
- allow upstream advisor or shadow stages to run in parallel,
- surface divergence and traces in admin telemetry,
- do not splice multiple token streams together.

If the use case needs "best final answer" rather than live
interactivity, use `streamPolicy = 'buffered-judge'` and do not stream
partial user-facing text until selection is complete.

Retry rules:

- connector-level transport retries are allowed only before any stream
  bytes are emitted and before tool consumption.
- orchestration retries are stage-local. Every retry creates a new
  `invocationId` and records `metadata.retryOfInvocationId`.

## 10) Invocation accounting and ledger integration

Replace the runtime output with an invocation array returned from
`InferenceService`. Every physical call gets its own `InvocationRecord`
with the shared `requestId`. A `correlationId` groups helper calls under
the same turn.

### 10.1 Step categorization via metadata

```ts
type StepMetadata = {
  step: 'primary' | 'fallback' | 'advisor' | 'synthesizer' | 'shadow' | 'judge' | 'tool-translation'
  stageRole: StageRole
  routingMode: RoutingMode
  stageId?: string
  retryOfInvocationId?: string
}
```

### 10.2 Ledger mapping

| What ran | operationType | metadata.step |
| --- | --- | --- |
| Primary/fallback answer | `chat` | `primary` / `fallback` |
| Advisor in committee | `chat` | `advisor` |
| Shadow peer | `chat` or `reasoning` | `shadow` |
| Judge selection | `reasoning` | `judge` |
| Tool translator | `tool-translation` | `tool-translation` |
| Structured output repair | `translation` | `primary/fallback/synthesizer` |
| Embedding | `embedding` | `primary` |

Each invocation record flushes to one `TokenLedgerEvent` at run completion.

### 10.3 Final result shape

```ts
type MultiProviderResult = {
  requestId: string
  correlationId?: string
  status: 'completed' | 'failed'
  finalAnswer?: string
  structuredOutput?: unknown
  answerOwner?: {
    stageId: string
    stageRole: StageRole
    provider: string
    model: string
    invocationId: string
  }
  toolExecutionOwner:
    | { stageId: string; provider: string; model: string; invocationId: string }
    | null
  failure?: {
    code: string
    message: string
    stageId?: string
  }
  invocations: InvocationRecord[]
}
```

All downstream consumers (UI, audit, billing, evals) derive from
`invocations[]`. The owner fields are metadata on that array. Do not
collapse multi-provider runs into a synthetic rollup record. That
destroys billing, debugging, and governance value.

This is the canonical top-level return shape from `InferenceService.run()`.
If the request asked for structured output and validation succeeds, the
primary payload returns in `structuredOutput`; `finalAnswer` stays for
human-readable text.

## 11) Admin and policy surface

Admin-only control-plane surfaces:

- provider connectors
- credential bindings
- manual model records
- capability overrides
- routing profiles
- tool mediator profiles
- eval suites
- eval runs
- orchestration health and trace inspection

Standard users and non-admin agent creators should only see approved
routing profiles that policy allows in their scope.

Rules:

- inference control-plane objects are organization-scoped in v1 unless a
  platform-managed seed object is explicitly marked global.
- provider credentials never live on the `Agent` record.
- agents reference routes, not raw credentials.
- admin-only routes do not appear in standard agent designer pickers or
  non-admin list/read responses.
- admin-only is a server-enforced policy boundary, not a UI-only hiding
  rule. Non-admin callers must be rejected on create, read, update,
  delete, bind, and run paths for admin-only objects.
- workers must reject execution if an agent or run references a routing
  profile outside its allowed exposure/scope.
- the admin UI should show whether a provider supports model discovery:
  - if yes, show discovered models,
  - if no, show provider name plus a manual/default model field.
- `custom` providers in v1 mean one of:
  - a compiled `ProviderConnector` registered server-side, or
  - a constrained OpenAI-compatible HTTP connector configured by
    `base_url` plus auth.
- `compiled` custom providers are valid only when `provider_key` is
  already registered in `ConnectorRegistry.listRegistered()`.
- `openai-compatible` custom providers require `base_url`,
  credential binding, and a successful health check before enablement.
- arbitrary admin-authored transformation adapters are out of scope for v1.
- health status is computed by `ProviderConnector.checkHealth()` on save,
  on a background schedule, and before enabling a previously unhealthy
  provider.
- mutable runnable objects start in `draft`. Only `approved` and
  `enabled` objects may execute. Any material edit clears approval and
  returns the object to `draft`.
- material edits are changes to runtime-affecting fields: provider
  connection/auth, capability snapshot/override, route graph, mediator
  config, eval dataset reference, or eval judge/target route.
- eval runs are the only allowed path that may target a draft routing
  profile. End-user traffic may execute only approved and enabled routes.
- promoting a routing profile to `approved` requires at least one
  passing eval run against the current content since the last material edit.

## 12) Minimal data model

Keep this lean. Do not over-normalize in v1.

```text
InferenceProvider
  id
  organization_id
  provider_key
  connector_kind
  display_name
  enabled
  lifecycle_status
  base_url?
  supports_model_discovery
  active_credential_binding_id?
  health_status
  last_checked_at
  created_by_actor_id
  updated_by_actor_id
  approved_by_actor_id?
  approved_at?

InferenceCredentialBinding
  id
  organization_id
  provider_id
  label
  auth_secret_ref   // server-only: resolved at inference time, NEVER returned in API responses
  created_by_actor_id
  created_at
  revoked_at?

InferenceModel
  id
  organization_id
  provider_id
  model
  display_name?
  enabled
  lifecycle_status
  capability_snapshot_json
  source
  discovered_at
  last_verified_at?
  created_by_actor_id
  approved_by_actor_id?
  approved_at?

InferenceCapabilityOverride
  id
  organization_id
  provider_id
  model
  lifecycle_status
  override_snapshot_json
  created_by_actor_id
  created_at
  cleared_at?
  approved_by_actor_id?
  approved_at?

InferenceRoutingProfile
  id
  organization_id
  label
  enabled
  exposure
  lifecycle_status
  mode
  route_graph_json
  created_by_actor_id
  approved_by_actor_id?
  approved_at?

ToolMediatorProfile
  id
  organization_id
  label
  enabled
  translator_provider
  translator_model
  mediator_config_json
  created_by_actor_id
  approved_by_actor_id?
  approved_at?

InferenceEvalSuite
  id
  organization_id
  label
  exposure
  enabled
  dataset_ref
  target_routing_profile_id
  judge_routing_profile_id?
  lifecycle_status
  created_by_actor_id
  approved_by_actor_id?
  approved_at?

InferenceEvalRun
  id
  organization_id
  eval_suite_id
  started_by_actor_id
  started_at
  finished_at?
  status
  summary_json
  result_json
  case_results_json
  target_profile_snapshot_json
  judge_profile_snapshot_json?
```

Notes:

- `capability_snapshot_json` is correct here. It will evolve.
- `route_graph_json` is correct here. Committee and pipeline flows do not
  need a dozen join tables in v1.
- `lifecycle_status` is `draft | approved | deprecated`. `enabled` alone
  never grants runtime eligibility.
- audit fields shown here are the minimum needed for ownership, approval,
  and evaluation traceability.
- if pricing or provider metadata becomes first-class later, split it later.
- eval contracts:
- `dataset_ref` is a typed locator stored as JSON with `{ kind: 'file' |
  'dataset' | 'query'; value: string }`.
- `summary_json` must contain `{ totalCases, passedCases, failedCases,
  score, blockingFailures[] }`.
- `result_json` stores aggregate metrics and judge output.
- `case_results_json` stores per-case inputs, outputs, verdicts, and
  invocation references.
- `InferenceEvalRun.status` is `queued | running | completed | failed | cancelled`.
- `case_results_json` entries store `{ caseId, input, expected?, actual, verdict, invocationIds[] }`.

## 13) Runtime integration plan

1. Add shared connector/orchestration types to `packages/schemas`.
2. Introduce `InferenceService` in `packages/runtime`.
3. Move existing OpenAI and MiniMax logic behind `ProviderConnector`
   implementations.
4. Change worker execution to depend on `InferenceService.run()` rather
   than `ModelClient.stream()`.
5. Return `MultiProviderResult` with `invocations[]`.
6. Flush `invocations[]` into `TokenLedgerEvent` rows at run completion.
7. Add manual-model capability resolution and override handling.
8. Add routing profile resolution to agent execution.
9. Add server-enforced admin policy for connectors, credential
   bindings, manual models, routing profiles, tool mediators, eval
   suites, and eval runs.
10. Add worker-queued eval execution and `InferenceEvalRun` persistence.
11. Add admin UI for connector setup, capability inspection, evals, and routing profile management.

## 14) Phase 2 scope and explicit non-goals

Phase 2 scope:

- shared connector/orchestration contracts,
- native-tool providers,
- prompt-translated tool calling for providers like MiniMax,
- manual model entry for providers without model discovery,
- single, fallback, committee, pipeline, and shadow routing,
- server-enforced admin-only policy for inference control-plane objects,
- eval suites for routing/profile validation,
- per-invocation ledger output.

Non-goals for v1:

- merging multiple live provider streams into one transcript,
- automatic pricing scraping from providers,
- multi-tool batching in prompt-translated mode,
- exposing admin-only orchestration profiles to normal users,
- provider-specific logic scattered across worker execution code.

## 15) Deliverables checklist

- [ ] D1 Shared contracts: connector/orchestration types, canonical `MultiProviderResult`, normalized `finishReason`.
- [ ] D2 Connector registry and health: registry, `checkHealth()`, persistence, enablement gating.
- [ ] D3 Capability catalog and manual models: manual/live/static/override resolution with explicit enablement.
- [ ] D4 Tool mediation: prompt-translated tools, structured-output repair, schema validation, pinned ownership.
- [ ] D5 Orchestration engine: `single`, `fallback`, `committee`, `pipeline`, `shadow`, and graph validation.
- [ ] D6 Ledger integration: one `InvocationRecord` per physical call mapped to `TokenLedgerEvent`.
- [ ] D7 Admin control plane: server-enforced CRUD/read/run policy, approval lifecycle, routing/tool-mediator/eval admin.
- [ ] D8 Evals: suite storage, queued execution, result persistence, and admin UI for launch/inspection.

## 16) Required eval suites

- [ ] Connector normalization: valid normalized result, finish reason, and usage mapping.
- [ ] Manual model gating: incomplete/draft models cannot run; approval and enablement are required.
- [ ] Tool mediation: valid intent executes, malformed intent translates, ambiguous translation fails closed.
- [ ] Fallback: fallback happens only before tool consumption and never duplicates side effects.
- [ ] Committee: advisors normalize to `CandidateOutput`, one visible terminal stage owns the answer, judges never stream.
- [ ] Pipeline: ordered `StageExecutionInput` stays valid and required upstream failure propagates deterministically.
- [ ] Shadow: shadow stages never affect the live transcript and shadow failure stays non-blocking.
- [ ] Ledger: every physical call yields one invocation and preserves retry metadata.
- [ ] Policy and approvals: non-admin CRUD/bind/run is rejected server-side and material edits clear approval.
- [ ] End-to-end promotion: a saved profile can be evaluated, approved, executed, and inspected through admin tooling.

## 17) Cross-links

- [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md)
- [implementation-phases.md](./implementation-phases.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [token-ledger-spec.md](./token-ledger-spec.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
