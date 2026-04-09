# Model Provider Connector and Orchestration System

> Status: target-state design.

## 1) Objective

Build one provider-agnostic inference layer that lets Nessie switch
between model providers, route one request across multiple providers
when needed, and account for every physical model call in the token
ledger.

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
  - shadow/fanout calls,
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

export type InvocationUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cachedOutputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}

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
  finishReason?: string
  metadata?: Record<string, unknown>
}

export type InferenceResult = {
  outputText: string
  selectedInvocationId?: string
  invocations: InvocationRecord[]
  toolCalls?: ToolCallIntent[]
  metadata?: Record<string, unknown>
}

export interface ProviderConnector {
  readonly provider: string
  getProviderMeta(): Promise<{
    provider: string
    displayName: string
    supportsModelDiscovery: boolean
  }>
  listModels(): Promise<ModelCapabilitySnapshot[]>
  getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot>
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
```

Rules:

- if `supportsModelDiscovery = false`, `listModels()` returns an empty
  array and the admin UI shows the provider plus a manual model field.
- provider quirks such as system-message folding, streaming payload
  shape, or usage field mapping live inside the connector only.
- connectors must normalize back into the same `InvocationRecord` shape
  regardless of provider.

## 6) Capability catalog

The system needs a real capability catalog instead of assuming provider-wide behavior.

Sources, in precedence order:

1. admin manual override,
2. provider live discovery/probe,
3. checked-in static defaults.

Rules:

- live discovery is optional per provider.
- capability snapshots are cached and versioned.
- agent/runtime selection uses the cached snapshot, not a live network
  probe on every request.
- if a provider changes behavior and a request fails due to capability
  mismatch, mark the snapshot stale and re-verify asynchronously.

This solves the actual problem behind MiniMax-style exceptions:
"provider exists" is not enough. The runtime needs "this exact model
supports streaming/json/tools/system-role usage reporting" before
building the prompt.

## 7) Routing profiles

Agents should not directly own secrets or orchestration logic.

They should reference a routing profile:

```ts
export type RoutingMode = 'single' | 'fallback' | 'fanout'
export type StreamPolicy = 'primary-only' | 'buffered-judge' | 'first-complete'

export type RoutingProfile = {
  id: string
  label: string
  enabled: boolean
  exposure: 'standard' | 'admin-only'
  mode: RoutingMode
  primary: { provider: string; model?: string }
  fallbacks?: Array<{ provider: string; model?: string }>
  peers?: Array<{ provider: string; model?: string }>
  streamPolicy: StreamPolicy
  toolMediatorId?: string
  judge?: { provider: string; model?: string }
}
```

Rules:

- `single`: one provider/model path.
- `fallback`: try the primary route, then fail over on outage,
  rate-limit, or hard capability mismatch.
- `fanout`: run multiple peers for the same request.
- `exposure = admin-only` hides the profile from normal users and
  standard agent creation flows.

For current schema compatibility:

- keep `Agent.provider` and `Agent.model` as the simple path for now,
- add optional `Agent.routingProfileId`,
- when `routingProfileId` is set, it is the source of truth and
  `provider` / `model` become denormalized snapshots for quick display.

## 8) Tool mediation for models without native tool calling

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

### 8.3 Translator contract

The cheap translator route receives:

- the raw tool intent block,
- the allowed tool schemas for this turn,
- the expected JSON output schema.

It returns:

```ts
type ToolCallIntent = {
  toolName: string
  arguments: Record<string, unknown>
  reason?: string
}
```

This is the minimum-complexity way to support tool-poor providers
without contaminating the main worker flow with provider-specific hacks.

### 8.4 Structured output fallback

The same pattern should handle structured final outputs when
`structuredOutputMode !== 'native-json'`.

Rules:

- first ask the primary model for a strict JSON block.
- if the block parses and validates, return it directly.
- if the model cannot reliably emit valid JSON, run the same cheap
  translator route against the raw output and target schema.
- record that helper call as a separate invocation record.

Do not build a second provider-specific "JSON fixer" path outside the
mediation layer.

### 8.5 Feeding tool results back

When the selected model lacks native tool message support, the connector
must feed tool results back as a labeled context block, for example:

```text
Tool result: web_search
<tool output here>
```

That behavior is capability-driven through `toolResultMode`, not
hardcoded in the worker.

## 9) Orchestration modes

### 9.1 Single

Default path for normal chat. Lowest latency and lowest cost.

### 9.2 Fallback

Use when a provider is preferred but not required.

Rules:

- fallback is for availability or hard incompatibility, not for silent answer shopping.
- every attempted provider call still produces its own invocation record.

### 9.3 Fanout

Use for admin-only high-reliability profiles.

Rules:

- send the same normalized request to all peers.
- keep peer prompts and tool access identical unless the routing
  profile explicitly says otherwise.
- record every peer invocation separately.
- if a judge model is used, record the judge call separately as
  `operationType = 'reasoning'` with metadata marking it as a judge
  step.

### 9.4 Streaming rule for fanout

For interactive chat, the only sane default is:

- stream from one designated primary peer,
- run the others in shadow,
- surface divergence and traces in admin telemetry,
- do not splice multiple token streams together.

If the use case needs "best final answer" rather than live
interactivity, use `streamPolicy = 'buffered-judge'` and do not stream
partial user-facing text until selection is complete.

## 10) Invocation accounting and ledger integration

The current `ModelUsageTracker` is too narrow because it groups only by
model name and assumes one provider path.

Replace that runtime output with an invocation array returned from `InferenceService`.

Rules:

- one user request may produce many invocation records.
- each invocation record flushes to one `TokenLedgerEvent`.
- all events from one top-level request share the same `requestId`.
- `correlationId` groups helper calls such as tool translation, judge
  calls, and fallback attempts under the same run.
- use metadata to distinguish steps:
  - `step = primary`
  - `step = fallback`
  - `step = shadow`
  - `step = judge`
  - `step = tool-translation`

This fits the existing token-ledger design cleanly:

- primary answer generation: `operationType = 'chat'`
- tool translation helper: `operationType = 'tool-translation'`
- judge/ranking helper: `operationType = 'reasoning'`
- embeddings: `operationType = 'embedding'`

Do not collapse multi-provider runs into one synthetic usage record.
That destroys billing, debugging, and governance value.

## 11) Admin and policy surface

Admin-only control-plane surfaces:

- provider connectors
- credential bindings
- capability overrides
- routing profiles
- tool mediator profiles
- orchestration health and trace inspection

Standard users and non-admin agent creators should only see approved
routing profiles that policy allows in their scope.

Rules:

- provider credentials never live on the `Agent` record.
- agents reference routes, not raw credentials.
- admin-only routes do not appear in standard agent designer pickers.
- the admin UI should show whether a provider supports model discovery:
  - if yes, show discovered models,
  - if no, show provider name plus a manual/default model field.

## 12) Minimal data model

Keep this lean. Do not over-normalize in v1.

```text
InferenceProvider
  id
  provider_key
  display_name
  enabled
  base_url?
  supports_model_discovery
  auth_secret_ref
  health_status
  last_checked_at

InferenceModel
  id
  provider_id
  model
  display_name?
  enabled
  capability_snapshot_json
  source
  discovered_at
  last_verified_at?

InferenceRoutingProfile
  id
  label
  enabled
  exposure
  mode
  route_config_json

ToolMediatorProfile
  id
  label
  enabled
  translator_provider
  translator_model
  mediator_config_json
```

Notes:

- `capability_snapshot_json` is correct here. It will evolve.
- `route_config_json` is correct here. Fanout/fallback trees do not
  need a dozen join tables in v1.
- if pricing or provider metadata becomes first-class later, split it later.

## 13) Runtime integration plan

1. Introduce `InferenceService` in `packages/runtime`.
2. Move existing OpenAI and MiniMax logic behind `ProviderConnector` implementations.
3. Change worker execution to depend on `InferenceService.run()` rather than `ModelClient.stream()`.
4. Return `InferenceResult` with `invocations[]`.
5. Flush `invocations[]` into `TokenLedgerEvent` rows at run completion.
6. Add routing profile resolution to agent execution.
7. Add admin UI for connector setup, capability inspection, and routing
   profile management.

## 14) Initial scope and explicit non-goals

Initial scope:

- native-tool providers,
- prompt-translated tool calling for providers like MiniMax,
- manual model entry for providers without model discovery,
- single, fallback, and fanout routing,
- per-invocation ledger output.

Non-goals for v1:

- merging multiple live provider streams into one transcript,
- automatic pricing scraping from providers,
- multi-tool batching in prompt-translated mode,
- exposing admin-only orchestration profiles to normal users,
- provider-specific logic scattered across worker execution code.

## 15) Cross-links

- [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md)
- [implementation-phases.md](./implementation-phases.md)
- [token-ledger-spec.md](./token-ledger-spec.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
