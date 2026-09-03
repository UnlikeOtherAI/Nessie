# Runtime, Platform, and Reference

### 3.1 Embedded Runtime (primary)

File: `src/agents/pi-embedded-runner/run.ts`

`runEmbeddedPiAgent()` / `runEmbeddedAgent()` — both are exported separately from `pi-embedded.ts`; prefer `runEmbeddedPiAgent` for clarity.

**Return type:** `Promise<EmbeddedPiRunResult>`

**Execution flow:**

```
1. Session lane resolution
   ├── resolveSessionLane(sessionKey)
   └── resolveGlobalLane(lane)

2. Team resolution
   └── resolveRunTeamDir(sessionKey, agentId, config)

3. Plugin loading
   └── ensureRuntimePluginsLoaded(config, teamDir)

4. Model resolution
   ├── provider = params.provider ?? DEFAULT_PROVIDER
   ├── modelId = params.model ?? DEFAULT_MODEL
   └── resolveModelAsync() + resolveHookModelSelection()  [run/setup.ts]

5. Auth profile selection
   ├── resolveAuthProfileEligibility()
   ├── resolveAuthProfileOrder()
   └── applyAuthHeaderOverride()

6. System prompt building
   ├── resolveSkillsPromptForRun()  [skills/team.ts]
   ├── buildEmbeddedSystemPrompt()  [system-prompt.ts]
   └── buildEmbeddedSandboxInfo()   [sandbox-info.ts]

7. Subscribe stream — start LLM call
   └── subscribeEmbeddedPiSession() → streams text, reasoning, tool calls

8. Tool execution loop  [run/attempt.ts — `runEmbeddedAttempt()`]
   ├── tool call normalization   [run/attempt.tool-call-normalization.ts]
   │     └── wraps stream: `wrapStreamFnSanitizeMalformedToolCalls`, `wrapStreamFnTrimToolCallNames`
   ├── argument repair            [run/attempt.tool-call-argument-repair.ts]
   │     └── `decodeHtmlEntitiesInObject`, `wrapStreamFnRepairMalformedToolCallArguments`
   ├── sandbox routing (docker/ssh/browser) or in-process
   ├── MCP tool bundling          [getOrCreateSessionMcpRuntime() + materializeBundleMcpToolsForRun(), pi-bundle-mcp-tools.ts]
   ├── stream resolution          [resolveEmbeddedAgentStreamFn()]
   └── pi-agent-core execution

   Teardown (on session end):
   └── disposeSessionMcpRuntime()  [pi-bundle-mcp-tools.ts]

9. Compaction (on context overflow or timeout)
   ├── buildEmbeddedCompactionRuntimeContext()  [compaction-runtime-context.ts]
   ├── compact.ts — queued (periodic/scheduled) vs on-demand compaction
   ├── summarize old history
   └── inject summary into session as compact message; increment compactionCount on SessionEntry

10. Error handling / failover
    ├── isBillingAssistantError / isRateLimitAssistantError / isLikelyContextOverflowError
    ├── handleAssistantFailover()       [run/assistant-failover.ts]
    ├── handleRetryLimitExhaustion()    [run/retry-limit.ts]
    └── retry or rotate auth profile     [run/auth-controller.ts]

11. Reply payload
    └── return EmbeddedPiRunResult
```

**Key files in the runner:**

| File | Role |
|---|---|
| `run.ts` | Main entry point — orchestrates the full run |
| `run/attempt.ts` | `runEmbeddedAttempt()` — single-attempt orchestrator: team setup, prompt building, streaming, compaction, teardown (~2400 lines) |
| `runs.ts` | Active run tracking, abort, queue |
| `run/setup.ts` | `resolveEffectiveRuntimeModel()` and `resolveHookModelSelection()` |
| `run/helpers.ts` | Shared helpers (`scrubAnthropicRefusalMagic`, `resolveFinalAssistantRawText`, etc.) |
| `run/llm-idle-timeout.ts` | LLM idle timeout handling |
| `run/trigger-policy.ts` | Compaction trigger policy |
| `run/preemptive-compaction.ts` | Proactive context management |
| `run/auth-controller.ts` | Auth profile rotation during a run |
| `run/backend.ts` | `runEmbeddedAttemptWithBackend()` — single LLM attempt |
| `run/failover-policy.ts` | Retry/failover decision logic |
| `run/assistant-failover.ts` | Model-level failover handling |
| `run/incomplete-turn.ts` | Empty/reasoning-only turn retry logic |
| `run/retry-limit.ts` | Retry budget exhaustion handling |
| `run/payloads.ts` | Build embedded run payloads |
| `run/tool-media-payloads.ts` | Merge tool media payloads |
| `run/attempt.tool-call-normalization.ts` | Classify and normalize tool calls before execution |
| `run/attempt.tool-call-argument-repair.ts` | Attempt to repair malformed tool arguments |
| `run/attempt.tool-run-context.ts` | Tool execution context (sandbox routing, team injection) |
| `run/attempt.thread-helpers.ts` | Thread-level helpers |
| `run/attempt.sessions-yield.ts` | Session yielding to sub-agents |
| `run/attempt.stop-reason-recovery.ts` | Handles stop reason recovery |
| `run/attempt.subscription-cleanup.ts` | Cleanup on subscription end |
| `run/attempt.context-engine-helpers.ts` | Context engine helpers during attempt |
| `compact.ts` | Session compaction on overflow/timeout |
| `compact.queued.ts` | Queued/scheduled compaction (flat file, not subdirectory) |
| `compact.runtime.ts` | Compaction runtime helpers |
| `compaction-runtime-context.ts` | `buildEmbeddedCompactionRuntimeContext()` — context for compaction hooks |
| `anthropic-cache-control-payload.ts` | Anthropic-specific cache payloads |
| `prompt-cache-retention.ts` | Anthropic cache control |
| `lanes.ts` | Session lane + global lane management |
| `model.ts` | Model resolution with fallback chains |
| `history.ts` | Turn/history limiting |
| `session-truncation.ts` | Session truncation |
| `tool-result-truncation.ts` | Tool result size management |
| `tool-result-char-estimator.ts` | Character estimation for truncation |
| `replay-state.ts` | State replay for retries (`createEmbeddedRunReplayState`) |
| `sandbox-info.ts` | `buildEmbeddedSandboxInfo()` — team mount, elevated access, browser bridge URL |
| `system-prompt.ts` | `buildEmbeddedSystemPrompt()` — skills, overrides, sandbox info |
| `thinking.ts` | Thinking level handling |
| `stream-resolution.ts` | Stream resolution logic |
| `stream-payload-utils.ts` | Streaming payload utilities |
| `context-engine-maintenance.ts` | Post-run context engine cleanup |
| `pi-embedded-subscribe.ts` | `subscribeEmbeddedPiSession()` — streaming response handler (see §3.2) |
| `pi-embedded-payloads.ts` | Block reply payload types |
| `pi-embedded-messaging.ts` | Messaging tool send helpers |
| `pi-embedded-block-chunker.ts` | Splits streamed code/fenced blocks |
| `pi-embedded-helpers.ts` | Error classification (`classifyFailoverReason`, `isBillingAssistantError`, etc.) |

### 3.2 Streaming Response Handler

File: `src/agents/pi-embedded-subscribe.ts`

Handles streaming responses from the LLM. Not a subdirectory — the handlers are individual files co-located in `src/agents/` using `.handlers.` naming:

```
pi-embedded-subscribe.ts                          — main entry
pi-embedded-subscribe.handlers.ts                 — handler registry barrel
pi-embedded-subscribe.handlers.types.ts          — handler type definitions
pi-embedded-subscribe.handlers.lifecycle.ts       — start/end/retry/compaction lifecycle
pi-embedded-subscribe.handlers.messages.ts        — text/reasoning accumulation
pi-embedded-subscribe.handlers.tools.ts           — tool call/result processing
pi-embedded-subscribe.handlers.tools.media.ts     — tool media handling
pi-embedded-subscribe.handlers.compaction.ts       — compaction event handling
pi-embedded-subscribe.handlers.compaction.runtime.ts — compaction runtime helpers
```

**What it accumulates:**
- Text chunks (visible + hidden/reasoning)
- Reasoning text
- Tool call requests and results
- Code spans (with block chunking for multi-span code)
- Lifecycle events (start, end, retry, compaction)

### 3.3 ACP Runtime (out-of-process)

File: `src/agents/acp-spawn.ts`

`spawnAcpDirect(params, ctx)` — launches a separate OpenClaw process as a child:

```typescript
export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult>
// SpawnAcpParams.mode = "run" | "session" ("run"=oneshot, "session"=persistent)
// SpawnAcpParams also includes: cwd, backend, agentId, sessionKey, ...etc
```

- Uses ACP (Agent Communication Protocol) over stdio
- Used for strong isolation or running agents on remote machines
- ACP bindings are defined in `BindingsSchema`
- **Invocation path:** ACP agents are spawned via `tools/sessions-spawn-tool.ts` (the `spawn` tool), not directly from `agent-runner-execution.ts`

### 3.4 CLI Runtime

File: `src/agents/cli-runner.ts`

`runCliAgent()` / `runPreparedCliAgent()` — runs the embedded Pi agent but formats output for CLI display.

---

## 4. Orchestration — Auto-Reply Pipeline

File: `src/auto-reply/reply/agent-runner.ts`

`runReplyAgent()` — the central orchestrator that ties channels to agents:

```typescript
async function runReplyAgent(params: GetReplyOptions): Promise<ReplyPayload>
```

**Execution flow:**

```
1. Session resolution
   ├── resolveSessionAgentId(session)
   └── resolveSessionEntry(session)

2. Agent config resolution
   ├── resolveAgentConfig(agentId)
   └── resolveAgentExecutionContract()  // resolves executionContract: "default" | "strict-agentic"

3. Auth profile resolution
   └── resolveRunAuthProfile(config, agentId)

4. Build execution params
   └── buildEmbeddedRunExecutionParams()

5. Route to runtime
   ├── embedded  → runEmbeddedPiAgent()
   └── ACP        → spawnAcpDirect() via tools/sessions-spawn-tool.ts

6. Reply delivery
   └── createBlockReplyDeliveryHandler() → channel.send()

7. Post-processing
   ├── followup scheduling
   ├── cron scheduling
   └── hook emission (agent events)

8. Error classification → action mapping
   ├── billing error        → surface to user
   ├── rate limit           → backoff + retry
   ├── context overflow     → trigger compaction
   └── transient error      → failover + retry
```

---

## 5. Auth Profiles — Multi-Key Rotation

Directory: `src/agents/auth-profiles/`

A full subsystem with its own store, credential state machine, OAuth flow, health tracking, and repair workflows. The directory contains **36 files** — the key surface:

```typescript
// profiles.ts — AuthProfile type and store
AuthProfile = {
  id: string,
  provider: string,
  credentials: AuthProfileCredential[],   // discriminated union (see below)
  // ...
}

// types.ts — AuthProfileCredential discriminated union
AuthProfileCredential =
  | { type: "api_key",  provider: string, key?: string, keyRef?: SecretRef, email?: string, displayName?: string }
  | { type: "token",    provider: string, token?: string, tokenRef?: SecretRef, expires?: number, email?: string, displayName?: string }
  | { type: "oauth",   provider: string, clientId?: string, email?: string, displayName?: string, managedBy?: ExternalOAuthManager,
      access?: string, refresh?: string, clientSecret?: string, refreshToken?: string }

// types.ts — core AuthProfile type
// persisted.ts — persisted credential representation
// store.ts — persistent JSON-backed credential store (plain JSON files, NOT encrypted)
// credential-state.ts — credential lifecycle state machine
// identity.ts — identity resolution

// order.ts — round-robin with cooldown + per-request eligibility
resolveAuthProfileOrder()
resolveAuthProfileEligibility()

// oauth.ts — OAuth2 refresh flow
refreshOAuthToken()
classifyOAuthRefreshFailure()

// oauth-refresh-failure.ts — OAuth failure handling
// external-auth.ts — external auth flows
// external-cli-sync.ts — CLI auth sync

// policy.ts — policy resolution (additional policy checks)

// state-observation.ts — live health tracking types (no-op barrel)

// profiles.ts — live health tracking
markAuthProfileGood()

// runtime-snapshots.ts — snapshot isolation during config reload
// session-override.ts — per-session auth overrides
// usage.ts — usage tracking + markAuthProfileFailure()
// upsert-with-lock.ts — concurrent profile updates
// repair.ts — credential repair workflows
// doctor.ts — health diagnostics

// path-constants.ts, paths.ts, path-resolve.ts — path management
// constants.ts — constants
// display.ts — display formatting
// source-check.ts — credential source validation
```

**Rotation trigger:** Profiles are ordered by `resolveAuthProfileOrder()` (round-robin) and selected per-request by `resolveAuthProfileEligibility()`. On failure (401, 429), `markAuthProfileFailure()` is called which marks that profile as ineligible until cooldown expires, then the next eligible profile is used.

---

## 6. Skills System

Directory: `src/agents/skills.ts` + `src/agents/skills/`

Skills are plugin-like modules that inject into the system prompt:

```typescript
// src/agents/skills.ts — primary exports
resolveSkillsInstallPreferences()
buildTeamSkillSnapshot()      // copies skills to team
syncSkillsToTeam()            // syncs skill files to team
loadTeamSkillEntries()        // loads skill metadata
resolveSkillsPromptForRun()         // builds skills section of system prompt

// src/agents/skills/config.ts
resolveSkillConfig()
isBundledSkillAllowed()
resolveBundledAllowlist()

// src/agents/skills/team.ts
buildTeamSkillSnapshot()
loadTeamSkillEntries()
resolveSkillsPromptForRun()

// src/agents/skills/filter.ts
matchesSkillFilter()

// src/agents/skills/agent-filter.ts
resolveEffectiveAgentSkillFilter()

// src/agents/skills/refresh-state.ts  ← defined here, re-exported by refresh.ts
getSkillsSnapshotVersion()           // current snapshot version
shouldRefreshSnapshotForVersion()    // whether to refresh for given version

// src/agents/skills/refresh.ts  — re-exports from refresh-state.ts + watcher
ensureSkillsWatcher()
resetSkillsRefreshForTest()
```

**Snapshot versioning:** Each team skill snapshot has a version number. `getSkillsSnapshotVersion()` returns the current version. `shouldRefreshSnapshotForVersion()` decides whether to rebuild the snapshot when the skill config changes.

---

## 7. Memory Engine

Directory: `src/memory-host-sdk/` (not `memory-core/`)

A full monorepo package (`packages/memory-host-sdk/`) providing LanceDB-backed vector + full-text search. This is **not** under `src/` — it's a package.

```
packages/memory-host-sdk/
  engine.ts                  — main engine entry
  engine-storage.ts          — persistence layer
  engine-qmd.ts            — QMD query engine for semantic search
  engine-foundation.ts     — foundation model integration
  engine-embeddings.ts     — embedding generation
  runtime.ts                — runtime interface
  runtime-core.ts           — core runtime
  runtime-files.ts          — file-based runtime
  runtime-cli.ts            — CLI runtime
  host/                     — host-side memory operations
  multimodal.ts            — multimodal memory
  query.ts                 — query builder
  events.ts                — event types
  secret.ts                — secret handling
  status.ts                — engine status
  batch/                    — batch providers (openai, gemini, voyage, bedrock)
  embeddings/              — embedding providers (openai, gemini, ollama, voyage, bedrock)
```

**Sync triggers:**
- `onSessionStart` — load memory when session begins
- `onSearch` — fetch relevant memories on each search
- `watch` — live file watching with debounce
- `intervalMinutes` — periodic sync
- `postCompactionForce` — force sync after compaction

**Query modes:**
- Vector similarity search
- Full-text search (FTS5 with unicode61 or trigram tokenizer)
- Hybrid search (vector + FTS, weighted)
- MMR reranking (Maximal Marginal Relevance)
- Temporal decay (recent memories weighted higher, configurable half-life)

**Remote memory:**
- Remote provider via HTTP API
- Batch mode with configurable concurrency and polling

---

## 8. Event Bus Architecture

The hook/event system lives in `src/plugins/`:

```typescript
// src/plugins/hook-runner-global.ts — global hook runner singleton
getGlobalHookRunner()                 // returns HookRunner | null
initializeGlobalHookRunner(registry)  // initialize from registry

// src/plugins/hooks.js — HookRunner implementation
createHookRunner(registry, options) → HookRunner

// src/plugins/hook-registry.types.ts — registry types
HookRunnerRegistry       // registry of hook implementations
GlobalHookRunnerRegistry // extends HookRunnerRegistry

// src/plugins/runtime/runtime-events.ts — PluginRuntime.events surface
// src/infra/agent-events.ts — agent event emission
emitAgentEvent()         // emit event to the event bus
registerAgentRunContext() // register run context for events
emitAgentPlanEvent()      // emit plan events
```

**Hook types** — all 29 hook names in `src/plugins/hook-types.ts` (`PluginHookName` union):

```typescript
type PluginHookName =
  | "before_model_resolve"      // intercept model selection
  | "before_prompt_build"       // intercept prompt construction
  | "before_agent_start"        // pre-run hook
  | "before_agent_reply"        // pre-reply hook
  | "llm_input"                // mutate LLM input
  | "llm_output"               // mutate LLM output
  | "agent_end"                 // post-run hook
  | "before_compaction"         // pre-compaction hook
  | "after_compaction"         // post-compaction hook
  | "before_reset"             // pre-session reset hook
  | "inbound_claim"            // claim inbound message
  | "message_received"         // post-message-received hook
  | "message_sending"          // pre-send hook (can mutate)
  | "message_sent"             // post-send hook
  | "before_tool_call"         // pre-tool-call hook
  | "after_tool_call"         // post-tool-call hook
  | "tool_result_persist"     // tool result persistence hook
  | "before_message_write"    // pre-message-write hook
  | "session_start"           // session start hook
  | "session_end"             // session end hook
  | "subagent_spawning"       // pre-subagent-spawn hook
  | "subagent_delivery_target" // subagent delivery routing
  | "subagent_spawned"        // post-subagent-spawn hook
  | "subagent_ended"          // subagent ended hook
  | "gateway_start"           // gateway startup hook
  | "gateway_stop"            // gateway shutdown hook
  | "before_dispatch"         // pre-dispatch hook
  | "reply_dispatch"          // reply dispatch hook
  | "before_install"          // pre-install hook
```

> All hook names use `snake_case`. The plugin SDK registers hooks using these string names.

**Execution order:** Hooks run in **priority order (higher first)**, not registration order. Within the same priority, order is undefined. Default priority is `0`. Global hooks are initialized once at startup via `initializeGlobalHookRunner()` in `src/plugins/loader.ts` (called from `activatePluginRegistry()` inside `loadOpenClawPlugins()`). Return values can mutate the intercepted data (e.g., `before_prompt_build` can return an overridden prompt).

---

## 9. MCP Integration

MCP tools are bundled and routed in the tool execution loop. The key files:

```typescript
// src/agents/pi-bundle-mcp-tools.ts (barrel re-exporting from pi-bundle-mcp-runtime.js / pi-bundle-mcp-materialize.js)
disposeSessionMcpRuntime()                  // disposes MCP runtime for a session
getOrCreateSessionMcpRuntime()              // creates/bundles MCP tools for a session (getOrCreateSessionMcpRuntime)
createBundleMcpToolRuntime()                // creates a fresh MCP tool runtime bundle
materializeBundleMcpToolsForRun()            // materializes bundled tools for a run
disposeAllSessionMcpRuntimes()              // disposes all session MCP runtimes
getSessionMcpRuntimeManager()               // returns the MCP runtime manager

// src/plugins/runtime/runtime-agent.ts — MCP tool bundling in plugin runtime
```

**What is bundled:** All MCP servers registered with the gateway are exposed to the agent as tools. The bundling transforms MCP tool schemas into the Pi agent's tool format.

**Protocol:** MCP tools use JSON-RPC 2.0 over stdio (the standard MCP protocol). The MCP server can be in-process or a separate process.

**Lifecycle:**
1. Session starts → `getOrCreateSessionMcpRuntime()` bundles MCP tools + `materializeBundleMcpToolsForRun()` materializes them for the run
2. Tool call routed to MCP server via JSON-RPC
3. Result returned to agent
4. Session ends → `disposeSessionMcpRuntime()`

---

## 10. Error Taxonomy

Error handling is centralized in `src/agents/pi-embedded-helpers/errors.ts`:

```typescript
// Classification — determines recovery strategy
classifyFailoverReason(error)           // → FailoverReason enum

isBillingAssistantError(error)         // → retry with exponential backoff, surface to user
isRateLimitAssistantError(error)        // → rotate profile, backoff
isLikelyContextOverflowError(error)    // → trigger compaction
isCompactionFailureError(error)        // → retry compaction or abort
isFailoverAssistantError(error)       // → retry with failover
isAuthAssistantError(error)            // → refresh OAuth token

// FailoverReason — string union (from pi-embedded-helpers/types.ts)
FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown"

// Resolution — resolveRunFailoverDecision() in run/failover-policy.ts (3 overloads)
resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision
resolveRunFailoverDecision(params: RunFailoverDecisionParams): RunFailoverDecision
resolveRunFailoverDecision(params: RetryLimitDecisionParams): RetryLimitFailoverDecision
handleRetryLimitExhaustion(params)           // dead-letter path
handleAssistantFailover(attempt, error)       // model-level failover

// FailoverError lives in src/agents/failover-error.ts (separate from errors.ts)
FailoverError                                 // structured error type (failover-error.ts)
resolveFailoverStatus(reason: FailoverReason)  // maps FailoverReason → status code; takes FailoverReason, NOT arbitrary error
```

**ACP error codes** (`acp-spawn.ts`):
```typescript
ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "thread_required",
  "target_agent_required",
  "agent_forbidden",
  "cwd_resolution_failed",
  "thread_binding_invalid",
  "spawn_failed",
  "dispatch_failed",
]
```
ACP errors from `spawnAcpDirect()` are returned as `SpawnAcpResult` with an `errorCode` field on failed results. They are **not** wrapped in `FailoverError`.

**Retry budget:** Each run has a configurable `retryLimit`. Once exhausted, `handleRetryLimitExhaustion()` determines the dead-letter path — surface error to user or archive session.

---

## 11. Session State

Sessions are **not** a formal state machine. State is event-driven and timestamp-based. There are three relevant surfaces:

**1. Diagnostic state** (`src/infra/diagnostic-events.ts`):
```typescript
DiagnosticSessionState = "idle" | "processing" | "waiting"
// idle       — created, no active work
// processing — LLM or tool execution in progress
// waiting    — queued, not yet processing
```
Purely an in-memory diagnostic/observability map. Not persisted.

**2. ACP agent process state** (`SessionAcpMeta.state` in `sessions.ts`):
```typescript
SessionAcpMeta.state = "idle" | "running" | "error"
```
Applies only to out-of-process ACP agents.

**3. Sub-agent completion status** (`SessionEntry.status` in `sessions.ts`):
```typescript
SessionEntry.status = "running" | "done" | "failed" | "killed" | "timeout"
```
Set after a sub-agent session completes.

**Persistence layer:** Sessions are stored in `sessions/` as JSON files. Full `SessionEntry` type (only `sessionId` and `updatedAt` are required, everything else optional):
```typescript
SessionEntry = {
  sessionId: string,
  updatedAt: number,
  lastHeartbeatText?: string,
  lastHeartbeatSentAt?: number,
  heartbeatIsolatedBaseSessionKey?: string,
  heartbeatTaskState?: Record<string, number>,
  sessionFile?: string,
  spawnedBy?: string,
  spawnedTeamDir?: string,
  parentSessionKey?: string,
  forkFromParent?: boolean,
  spawnDepth?: number,
  subagentRole?: "orchestrator" | "leaf",
  subagentControlScope?: "children" | "none",
  startedAt?: number,
  endedAt?: number,
  runtimeMs?: number,
  status?: "running" | "done" | "failed" | "killed" | "timeout",
  abortCutoffMessageSid?: string,
  abortCutoffTimestamp?: number,
  inputTokens?: number,
  outputTokens?: number,
  totalTokens?: number,
  estimatedCostUsd?: number,
  modelProvider?: string,
  model?: string,
  contextTokens?: number,
  compactionCount?: number,
  compactionCheckpoints?: SessionCompactionCheckpoint[],
  memoryFlushAt?: number,
  channel?: string,
  groupId?: string,
  subject?: string,
  label?: string,
  displayName?: string,
  acp?: SessionAcpMeta,
  // ... many more optional fields
}
```
Session pruning is driven by `updatedAt` vs `idleExpiresAt` and `archiveAfterMinutes`.

**Heartbeat:** Heartbeat agents run in isolated sessions with `:heartbeat` key suffix (`resolveSessionAgentId()`). They are independent sessions, not sub-states of the parent.

**Lane isolation:** `resolveSessionLane()` assigns each session to a lane. `enqueueCommandInLane(lane, task, opts)` serializes work within a lane. Concurrent tool calls within the same session are serialized. The sandbox `scope: "shared"` option causes all sessions to share a single team container/browser rather than creating per-session isolation — it does NOT share lanes between sessions.

---

## 12. Plugin SDK — External Extension Interface

File: `src/plugins/runtime/index.ts` — `createPluginRuntime()`

The full `PluginRuntime` object (extends `PluginRuntimeCore` with `subagent` and `channel`):

```typescript
// PluginRuntimeCore (types-core.ts) — base fields
PluginRuntimeCore = {
  version: string,        // OpenClaw version
  config,                 // agent config access
  agent,                   // runEmbeddedPiAgent
  system,                  // system runtime
  media,                   // media runtime
  tts,                     // text-to-speech
  mediaUnderstanding,
  imageGeneration,
  videoGeneration,
  musicGeneration,
  webSearch,              // search tools
  stt,                    // speech-to-text
  events,                 // { onAgentEvent, onSessionTranscriptUpdate } — NOT the full hook system
  logging,                // structured logging
  state,                  // plugin state management
  tasks,                  // task CRUD
  taskFlow,               // workflow orchestration (deprecated)
  modelAuth,              // auth profile management
}

// PluginRuntime = PluginRuntimeCore + subagent + channel
PluginRuntime = PluginRuntimeCore & {
  subagent: {
    run(params: SubagentRunParams): Promise<SubagentRunResult>
    waitForRun(params: SubagentWaitParams): Promise<SubagentWaitResult>
    getSessionMessages(params: SubagentGetSessionMessagesParams): Promise<SubagentGetSessionMessagesResult>
    deleteSession(params: SubagentDeleteSessionParams): Promise<void>
  },
  channel: PluginRuntimeChannel,
}
```

> **Note:** `PluginRuntime` has **no `memory` field**. Memory is provided as a separate plugin slot (`plugins.slots.memory = "memory-lancedb"`) with a separate `memory-lancedb` plugin package, not as part of the core runtime surface.

File: `src/plugins/runtime/runtime-agent.ts` — plugin-facing agent surface
File: `src/plugins/runtime/runtime-taskflow.ts` — task flow runtime
File: `src/plugins/runtime/runtime-tasks.ts` — task CRUD
File: `src/plugins/runtime/runtime-channel.ts` — channel runtime
File: `src/plugins/runtime/runtime-config.ts` — config access
File: `src/plugins/runtime/runtime-logging.ts` — logging
File: `src/plugins/runtime/runtime-web-channel-plugin.ts` — web channel plugin

File: `src/plugin-sdk/agent-harness.ts` — harness replaceability:
```typescript
AgentHarness*                              // harness types
EmbeddedRunAttemptParams / EmbeddedRunAttemptResult
EmbeddedPiCompactResult
abortAgentHarnessRun()
queueAgentHarnessMessage()
disposeRegisteredAgentHarnesses()
```

Plugins can replace the low-level agent runtime by registering an `AgentHarness`. When registered, the harness intercepts attempt execution.

---

## 13. Sub-Agent / Spawn System

Sub-agents are spawned from the main agent via the `sessions_spawn` tool (in `tools/sessions-spawn-tool.ts`):

```typescript
// src/agents/tools/sessions-spawn-tool.ts
name: "sessions_spawn"   // NOT "spawn"
runtime: params.runtime === "acp" ? "acp" : "subagent"  // default is "subagent", NOT "spawn"
```

```typescript
// Config (from SubagentsSchema in AgentDefaultsSchema)
subagents: {
  allowAgents?: string[],           // whitelist of agent IDs allowed to spawn
  maxConcurrent?: number,           // max parallel sub-agents
  maxSpawnDepth?: number,           // 1–5, default 1 (no nesting)
  maxChildrenPerAgent?: number,     // 1–20, default 5
  archiveAfterMinutes?: number,
  model?: AgentModelSchema,
  thinking?: string,
  runTimeoutSeconds?: number,
  announceTimeoutMs?: number,
  requireAgentId?: boolean,
}
```

**Files:**
- `src/agents/command/session-store.ts` — sub-agent session store management
- `src/agents/spawned-context.ts` — `normalizeSpawnedRunMetadata()` (types: `SpawnedRunMetadata`, `NormalizedSpawnedRunMetadata`, `SpawnedToolContext`)
- `src/cron/isolated-agent/` — isolated sessions for heartbeat/cron agents

**IPC mechanism:** Sub-agent sessions communicate via the session store (`session-store.ts`). The parent agent can send messages to and receive messages from child sessions. Lifecycle teardown: when a parent session terminates, child sessions are marked for archival and no further messages are routed to them.

---

## 14. System Diagram

```
Config (zod-schema.agents.ts)
  ├── agents.defaults — global fallbacks (AgentDefaultsSchema)
  ├── agents.list[] — named agent entries (AgentEntrySchema)
  │     ├── runtime: RuntimeSchema  // discriminated object: { type: "embedded" } | { type: "acp"; acp?: {...} }
  │     ├── embeddedPi: project settings, execution contract
  │     ├── sandbox: docker / ssh / browser
  │     ├── tools: allowlists, exec policies, loop detection
  │     ├── memorySearch: vector + FTS config
  │     ├── skills: team skill snapshots
  │     ├── subagents: spawn permissions
  │     └── heartbeat: periodic agent
  └── bindings[] — channel → agent routing
        ├── type: "route" — in-process embedded
        └── type: "acp"   — out-of-process child via spawnAcpDirect()

Incoming Message
  │
  ▼
runReplyAgent()  [agent-runner.ts]
  │
  ├── resolveSessionAgentId()
  ├── resolveAgentExecutionContract()  // resolves executionContract: "default" | "strict-agentic"
  ├── resolveRunAuthProfile()
  ├── buildEmbeddedRunExecutionParams()
  │
  ▼
┌─ embedded ─────────────────────────────────────────────────────────┐
│ runEmbeddedPiAgent()  [pi-embedded-runner/run.ts]                     │
│                                                                        │
│  1. team resolution                                                │
│  2. plugin loading                                                      │
│  3. model + hook resolution  [run/setup.ts]                           │
│  4. auth profile (eligibility + order + OAuth refresh)                 │
│  5. system prompt (skills + sandbox info)                              │
│  6. subscribeEmbeddedPiSession() — stream to LLM                       │
│       ↓                                                                │
│  7. Tool execution loop  [run/attempt.ts]                             │
│       ├── tool-call-normalization / argument-repair                    │
│       ├── sandbox routing (docker/ssh/browser)                         │
│       ├── MCP tool bundling  [pi-bundle-mcp-tools.ts]                  │
│       └── pi-agent-core execution                                       │
│  8. Compaction (context overflow → summarize → inject summary)       │
│  9. Error handling (classify → retry | rotate | abort)                │
│       [pi-embedded-helpers.ts, run/failover-policy.ts]                  │
│ 10. return EmbeddedPiRunResult                                         │
└────────────────────────────────────────────────────────────────────────┘

ACP runtime path:
┌─ acp ───────────────────────────────────────────────────────────────┐
│ tools/sessions-spawn-tool.ts                                          │
│   → spawnAcpDirect("run"|"session")  [acp-spawn.ts]  (via sessions_spawn tool, defaults to "subagent" runtime)                   │
│     → separate OpenClaw process, ACP protocol over stdio              │
└───────────────────────────────────────────────────────────────────────┘

Reply Delivery
  │
  ▼
createBlockReplyDeliveryHandler() → channel.send()

Post-Processing
  ├── emitAgentEvent()  [infra/agent-events.ts]
  ├── runContextEngineMaintenance()  [context-engine-maintenance.ts]
  └── memory sync (on session end)

Hooks (src/plugins/hook-runner-global.ts)
  ├── before_model_resolve, before_prompt_build, llm_input, llm_output
  ├── before_agent_start, before_agent_reply, agent_end
  ├── before_compaction, after_compaction, before_reset
  ├── before_tool_call, after_tool_call, tool_result_persist
  ├── message_received, message_sending, message_sent, before_message_write
  ├── session_start, session_end
  ├── subagent_spawning, subagent_delivery_target, subagent_spawned, subagent_ended
  └── gateway_start, gateway_stop, before_dispatch, reply_dispatch, before_install
```

---

## 15. Key Dependencies

| Package | Role |
|---|---|
| `@mariozechner/pi-agent-core` | Core agent runtime (tool execution, LLM calls) |
| `zod` | All configuration validation |
| `lancedb` | Vector store backend for the `memory-lancedb` plugin slot |
| `packages/memory-host-sdk/` | Memory engine (monorepo package, SQLite/FTS/sqlite-vec backend) |
| `packages/plugin-sdk/` | Plugin SDK types and interfaces |
| `packages/plugin-package-contract/` | Plugin package contract |
| `openclaw internal` | Channel integrations, MCP tool bundling, auth profiles |

---

## 16. Patterns to Reference for Nessie

1. **Config as data** — agents defined declaratively in Zod schemas, resolved with defaults merged before per-agent overrides
2. **Auth profile rotation** — round-robin with cooldown, OAuth refresh on 401, health tracking per profile, snapshot isolation on reload
3. **Lane-based concurrency** — session lanes serialize per-session work; global lane coordinates cross-session work; lanes are queues backed by `enqueueCommandInLane()`
4. **Compaction** — triggered on context overflow or timeout; summarize old history into a compact message; inject as a new session entry; `postCompactionForce` can force memory sync afterward
5. **Sandbox isolation** — Docker/SSH/Browser with security policies enforced at config parse time (before any container starts); seccomp/AppArmor/network restrictions prevent escape
6. **Skills snapshots** — versioned team snapshots; `getSkillsSnapshotVersion()` tracks current version; `shouldRefreshSnapshotForVersion()` decides whether to rebuild on config change
7. **Memory engine** — SQLite/FTS/sqlite-vec backend via `packages/memory-host-sdk/`; `memory-lancedb` plugin occupies the `plugins.slots.memory` slot; MMR reranking for diversity; temporal decay for recency weighting; sync on session start, search, interval, or watch
8. **Plugin harness** — plugins register `AgentHarness*` to replace the low-level agent runtime; harness intercepts `EmbeddedRunAttemptParams` / `EmbeddedRunAttemptResult`
9. **Hook runner** — `getGlobalHookRunner()` provides typed hook execution; 29 hooks in `PluginHookName` (`before_model_resolve`, `llm_input`, `before_tool_call`, `agent_end`, etc.); hooks initialized at startup in `src/plugins/loader.ts`; execution order is **priority order (higher first)**, not registration order; return values can mutate intercepted data
10. **Failover policy** — `FailoverReason` enum drives recovery: billing → surface error, rate_limit → rotate + backoff, auth → refresh token, context_overflow → compact, model_not_found → retry with failover; retry budget prevents infinite loops
