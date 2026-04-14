# OpenClaw Agent System Architecture

> Documenting for use in the Nessie project. Source: `/System/Volumes/Data/.internal/projects/Projects/openclaw/`

---

## Overview

OpenClaw is a multi-channel AI gateway with an extensible, multi-agent runtime. It is a TypeScript/Node.js monorepo. Agents are primarily powered by `@mariozechner/pi-agent-core` with OpenClaw providing routing, sandboxing, memory, tool policies, and channel integrations.

Agents can run in two modes:
- **Embedded** — runs in-process, the primary runtime
- **ACP** — runs as a separate child process via the Agent Communication Protocol

---

## 1. Config Layer

### 1.1 Top-Level Schema

File: `src/config/zod-schema.agents.ts`

```typescript
AgentsSchema = {
  defaults?: AgentDefaultsSchema,   // global fallbacks applied before per-agent overrides
  list?: AgentEntrySchema[],        // named agents array
  bindings?: BindingsSchema,        // channel → agent routing
  broadcast?: BroadcastSchema,
}
```

### 1.2 Agent Entry Schema

File: `src/config/zod-schema.agent-runtime.ts`

Each agent in `agents.list[]` is defined by `AgentEntrySchema`:

```typescript
AgentEntrySchema = {
  id: string,                                    // unique agent identifier
  default?: boolean,                             // marks the default agent (used when none specified)
  name?: string,                                 // human-readable name
  workspace?: string,                            // workspace directory for this agent
  agentDir?: string,                             // agent-specific files directory
  systemPromptOverride?: string,                 // override the default system prompt
  embeddedHarness?: AgentEmbeddedHarnessSchema,  // harness selection for embedded runtime
  model?: AgentModelSchema,                       // provider + model selection
  thinkingDefault?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"adaptive",
  reasoningDefault?: "on"|"off"|"stream",
  fastModeDefault?: boolean,
  skills?: string[],                              // skills to load for this agent
  memorySearch?: MemorySearchSchema,              // memory engine config
  humanDelay?: HumanDelaySchema,
  heartbeat?: HeartbeatSchema,                    // periodic heartbeat / cron agent
  identity?: IdentitySchema,
  groupChat?: GroupChatSchema,
  subagents?: SubagentsSchema,                    // nested sub-agent config
  embeddedPi?: EmbeddedPiSchema,                  // embedded Pi agent settings
  sandbox?: AgentSandboxSchema,                   // docker/ssh/browser isolation
  tools?: AgentToolsSchema,                       // tool allowlists, exec policies, loop detection
  runtime?: RuntimeSchema,                        // "embedded" | "acp"
}
```

Where `EmbeddedPiSchema` controls project settings and execution contracts:
```typescript
embeddedPi: {
  projectSettingsPolicy?: "trusted"|"sanitize"|"ignore",
  executionContract?: "default"|"strict-agentic",
}
```

### 1.3 Agent Defaults Schema

File: `src/config/zod-schema.agent-defaults.ts`

Global fallbacks applied **before** per-agent overrides. This is the full schema:

```typescript
AgentDefaultsSchema = {
  params?: Record<string, unknown>,              // provider params applied before per-model overrides
  embeddedHarness?: AgentEmbeddedHarnessSchema,
  model?: AgentModelSchema,
  imageModel?: AgentModelSchema,
  imageGenerationModel?: AgentModelSchema,
  videoGenerationModel?: AgentModelSchema,
  musicGenerationModel?: AgentModelSchema,
  mediaGenerationAutoProviderFallback?: boolean,
  pdfModel?: AgentModelSchema,
  pdfMaxBytesMb?: number,
  pdfMaxPages?: number,
  models?: Record<string, {
    alias?: string,
    params?: Record<string, unknown>,
    streaming?: boolean,                         // default true; false for Ollama
  }>,
  workspace?: string,
  skills?: string[],
  repoRoot?: string,
  systemPromptOverride?: string,
  skipBootstrap?: boolean,
  contextInjection?: "always"|"continuation-skip",
  bootstrapMaxChars?: number,
  bootstrapTotalMaxChars?: number,
  bootstrapPromptTruncationWarning?: "off"|"once"|"always",
  userTimezone?: string,
  startupContext?: {
    enabled?: boolean,
    applyOn?: ("new"|"reset")[],
    dailyMemoryDays?: number,                    // 1–14
    maxFileBytes?: number,                        // bytes
    maxFileChars?: number,
    maxTotalChars?: number,
  },
  timeFormat?: "auto"|"12"|"24",
  envelopeTimezone?: string,
  envelopeTimestamp?: "on"|"off",
  envelopeElapsed?: "on"|"off",
  contextTokens?: number,                        // max context window
  cliBackends?: Record<string, CliBackendSchema>,
  memorySearch?: MemorySearchSchema,
  contextPruning?: {
    mode?: "off"|"cache-ttl",
    ttl?: string,
    keepLastAssistants?: number,
    softTrimRatio?: number,                      // 0–1
    hardClearRatio?: number,                      // 0–1
    minPrunableToolChars?: number,
    tools?: { allow?: string[], deny?: string[] },
    softTrim?: {
      maxChars?: number,
      headChars?: number,
      tailChars?: number,
    },
    hardClear?: {
      enabled?: boolean,
      placeholder?: string,
    },
  },
  llm?: {
    idleTimeoutSeconds?: number,                  // default: DEFAULT_LLM_IDLE_TIMEOUT_SECONDS
  },
  compaction?: {
    mode?: "default"|"safeguard",
    provider?: string,
    reserveTokens?: number,
    keepRecentTokens?: number,
    reserveTokensFloor?: number,
    maxHistoryShare?: number,                     // 0.1–0.9
    customInstructions?: string,
    identifierPolicy?: "strict"|"off"|"custom",
    identifierInstructions?: string,
    recentTurnsPreserve?: number,                 // 0–12
    qualityGuard?: { enabled?: boolean, maxRetries?: number },
    postIndexSync?: "off"|"async"|"await",
    postCompactionSections?: string[],
    model?: string,
    timeoutSeconds?: number,
    memoryFlush?: {
      enabled?: boolean,
      softThresholdTokens?: number,
      forceFlushTranscriptBytes?: number | string,
      prompt?: string,
      systemPrompt?: string,
    },
    notifyUser?: boolean,
  },
  embeddedPi?: {
    projectSettingsPolicy?: "trusted"|"sanitize"|"ignore",
    executionContract?: "default"|"strict-agentic",
  },
  thinkingDefault?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"adaptive",
  verboseDefault?: "off"|"on"|"full",
  elevatedDefault?: "off"|"on"|"ask"|"full",
  blockStreamingDefault?: "off"|"on",
  blockStreamingBreak?: "text_end"|"message_end",
  blockStreamingChunk?: BlockStreamingChunkSchema,
  blockStreamingCoalesce?: BlockStreamingCoalesceSchema,
  humanDelay?: HumanDelaySchema,
  timeoutSeconds?: number,
  mediaMaxMb?: number,
  imageMaxDimensionPx?: number,
  typingIntervalSeconds?: number,
  typingMode?: TypingModeSchema,
  heartbeat?: HeartbeatSchema,
  maxConcurrent?: number,
  subagents?: {
    allowAgents?: string[],
    maxConcurrent?: number,
    maxSpawnDepth?: number,                       // 1–5, default 1
    maxChildrenPerAgent?: number,                  // 1–20, default 5
    archiveAfterMinutes?: number,
    model?: AgentModelSchema,
    thinking?: string,
    runTimeoutSeconds?: number,
    announceTimeoutMs?: number,
    requireAgentId?: boolean,
  },
  sandbox?: AgentSandboxSchema,
}
```

Default constants (from `src/agents/defaults.ts`):
```typescript
DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_CONTEXT_TOKENS = 200_000
```

### 1.4 Bindings — Channel-to-Agent Routing

File: `src/config/zod-schema.agents.ts`

Routes incoming channel messages to specific agents. `BindingsSchema` is `z.array(z.union([RouteBindingSchema, AcpBindingSchema]))`:

```typescript
// Route-based binding — routes in-process
RouteBindingSchema = {
  type?: "route",     // optional label
  agentId: string,
  comment?: string,
  match: {
    channel: string,
    accountId?: string,
    peer?: { kind: "direct"|"group"|"channel"|"dm", id: string },
    guildId?: string,
    teamId?: string,
    roles?: string[],
  },
}

// ACP binding — spawns an out-of-process agent
AcpBindingSchema = {
  type: "acp",
  agentId: string,
  comment?: string,
  match: {
    channel: string,
    accountId?: string,
    peer?: { kind: "direct"|"group"|"channel"|"dm", id: string },
    guildId?: string,
    teamId?: string,
    roles?: string[],
  },
  acp?: {
    mode?: "run"|"session",   // "run" = oneshot, "session" = persistent
    label?: string,
    cwd?: string,
    backend?: string,
  },
}
```

> ACP spawn modes map: `"run"` → oneshot (single request/response), `"session"` → persistent (maintains state).

> ACP bindings require `match.peer.id` — the binding must target a concrete conversation.

### 1.5 Sandbox Schema

File: `src/config/zod-schema.agent-runtime.ts`

Supports three isolation environments:

```typescript
AgentSandboxSchema = {
  mode?: "off"|"non-main"|"all",
  backend?: string,
  workspaceAccess?: "none"|"ro"|"rw",
  scope?: "session"|"agent"|"shared",
  workspaceRoot?: string,
  docker?: SandboxDockerSchema,
  ssh?: SandboxSshSchema,
  browser?: SandboxBrowserSchema,
  prune?: SandboxPruneSchema,
}
```

**Security restrictions enforced at config parse time:**
- `network: "host"` blocked for Docker and Browser
- `network: "container:*"` blocked unless `dangerouslyAllowContainerNamespaceJoin=true`
- `seccompProfile: "unconfined"` blocked
- `apparmorProfile: "unconfined"` blocked
- Bind mounts require absolute POSIX paths

**`SandboxDockerSchema`** key fields:
```typescript
{
  image?: string,
  containerPrefix?: string,
  workdir?: string,
  readOnlyRoot?: boolean,
  tmpfs?: string[],
  network?: string,
  memory?: string | number,
  cpus?: number,
  binds?: string[],             // must be absolute POSIX paths
  dns?: string[],
  dangerouslyAllowReservedContainerTargets?: boolean,
  dangerouslyAllowExternalBindSources?: boolean,
  dangerouslyAllowContainerNamespaceJoin?: boolean,
}
```

**`SandboxBrowserSchema`** key fields:
```typescript
{
  enabled?: boolean,
  image?: string,
  network?: string,
  cdpPort?: number,
  headless?: boolean,
  autoStart?: boolean,
  binds?: string[],
}
```

**`SandboxSshSchema`** key fields:
```typescript
{
  target?: string,
  command?: string,
  workspaceRoot?: string,
  identityFile?: string,
  knownHostsFile?: string,
  identityData?: SecretInput,    // injected at runtime, never stored
}
```

### 1.6 Tools Schema

File: `src/config/zod-schema.agent-runtime.ts`

```typescript
AgentToolsSchema = {
  profile?: "minimal"|"coding"|"messaging"|"full",
  allow?: string[],
  alsoAllow?: string[],
  deny?: string[],
  byProvider?: Record<string, ToolPolicyWithProfileSchema>,
  elevated?: {
    enabled?: boolean,
    allowFrom?: Record<string, (string | number)[]>,  // provider → agent IDs
  },
  exec?: {
    host?: "auto"|"sandbox"|"gateway"|"node",
    security?: "deny"|"allowlist"|"full",
    ask?: "off"|"on-miss"|"always",
    safeBins?: string[],
    safeBinProfiles?: Record<string, {
      minPositional?: number,
      maxPositional?: number,
      allowedValueFlags?: string[],
      deniedFlags?: string[],
    }>,
    timeoutSec?: number,
    cleanupMs?: number,
    backgroundMs?: number,
    applyPatch?: {
      enabled?: boolean,
      workspaceOnly?: boolean,
      allowModels?: string[],
    },
  },
  fs?: { workspaceOnly?: boolean },
  loopDetection?: {
    enabled?: boolean,
    historySize?: number,
    warningThreshold?: number,
    criticalThreshold?: number,
    globalCircuitBreakerThreshold?: number,
    detectors?: {
      genericRepeat?: boolean,
      knownPollNoProgress?: boolean,
      pingPong?: boolean,
    },
  },
  sandbox?: { tools?: ToolPolicySchema },
}
```

### 1.7 Memory Search Schema

File: `src/config/zod-schema.agent-runtime.ts`

```typescript
MemorySearchSchema = {
  enabled?: boolean,
  sources?: ("memory"|"sessions")[],
  provider?: string,
  model?: string,
  remote?: {
    baseUrl?: string,
    apiKey?: SecretInput,
    headers?: Record<string, string>,
    batch?: {
      enabled?: boolean,
      wait?: boolean,
      concurrency?: number,
      pollIntervalMs?: number,
      timeoutMinutes?: number,
    },
  },
  store?: {
    driver?: "sqlite",
    path?: string,
    fts?: { tokenizer?: "unicode61"|"trigram" },
    vector?: { enabled?: boolean, extensionPath?: string },
  },
  chunking?: { tokens?: number, overlap?: number },
  sync?: {
    onSessionStart?: boolean,
    onSearch?: boolean,
    watch?: boolean,
    watchDebounceMs?: number,
    intervalMinutes?: number,
    sessions?: {
      deltaBytes?: number,
      deltaMessages?: number,
      postCompactionForce?: boolean,
    },
  },
  query?: {
    maxResults?: number,
    minScore?: number,
    hybrid?: {
      enabled?: boolean,
      vectorWeight?: number,
      textWeight?: number,
      candidateMultiplier?: number,
      mmr?: { enabled?: boolean, lambda?: number },
      temporalDecay?: { enabled?: boolean, halfLifeDays?: number },
    },
  },
  cache?: { enabled?: boolean, maxEntries?: number },
}
```

---

## 1X. Referenced Type Definitions

The following types are referenced throughout the config schemas but not fully defined inline:

```typescript
// AgentModelSchema — model selection, in src/config/zod-schema.agent-model.ts
AgentModelSchema = z.union([
  z.string(),                              // e.g., "openai/gpt-4o"
  z.object({
    primary: z.string(),                  // primary model ID
    fallbacks: z.array(z.string()),       // fallback model IDs in order
  }).strict(),
])

// AgentEmbeddedHarnessSchema — in src/config/zod-schema.agent-runtime.ts
AgentEmbeddedHarnessSchema = {
  runtime?: string,   // harness runtime identifier
  fallback?: "pi"|"none",
}

// GetReplyOptions — input to runReplyAgent(), in src/auto-reply/get-reply-options.types.ts
GetReplyOptions = {
  runId?: string,                            // override run ID (defaults to random UUID)
  abortSignal?: AbortSignal,
  images?: ImageContent[],
  imageOrder?: PromptImageOrderEntry[],
  onAgentRunStart?: (runId: string) => void,
  onReplyStart?: () => Promise<void> | void,
  onTypingCleanup?: () => void,
  onTypingController?: (typing: TypingController) => void,
  isHeartbeat?: boolean,
  typingPolicy?: "auto"|"user_message"|"system_event"|"internal_webchat"|"heartbeat",
  suppressTyping?: boolean,
  heartbeatModelOverride?: string,
  bootstrapContextMode?: "full"|"lightweight",
  suppressToolErrorWarnings?: boolean,
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void,
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void,
  onReasoningEnd?: () => Promise<void> | void,
  onAssistantMessageStart?: () => Promise<void> | void,
  onBlockReplyQueued?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void,
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void,
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void,
  onToolStart?: (payload: { name?: string; phase?: string }) => Promise<void> | void,
  onItemEvent?: (payload: ItemEventPayload) => Promise<void> | void,
  onPlanUpdate?: (payload: PlanUpdatePayload) => Promise<void> | void,
  onApprovalEvent?: (payload: ApprovalEventPayload) => Promise<void> | void,
  onCommandOutput?: (payload: CommandOutputPayload) => Promise<void> | void,
  onPatchSummary?: (payload: PatchSummaryPayload) => Promise<void> | void,
  onCompactionStart?: () => Promise<void> | void,
  onCompactionEnd?: () => Promise<void> | void,
  onModelSelected?: (ctx: ModelSelectedContext) => void,
  disableBlockStreaming?: boolean,
  blockReplyTimeoutMs?: number,
  skillFilter?: string[],
  hasRepliedRef?: { value: boolean },
  timeoutOverrideSeconds?: number,
}

// ReplyPayload — in src/auto-reply/reply-payload.ts
ReplyPayload = {
  text?: string,
  mediaUrl?: string,
  mediaUrls?: string[],
  interactive?: InteractiveReply,
  btw?: { question: string },
  replyToId?: string,
  replyToTag?: boolean,
  replyToCurrent?: boolean,    // reply_to_current was present but not yet mapped to a message id
  audioAsVoice?: boolean,
  isError?: boolean,
  isReasoning?: boolean,      // reasoning/thinking block marker
  isCompactionNotice?: boolean, // compaction notice, exclude from TTS
  channelData?: Record<string, unknown>, // per-channel envelope
}

// EmbeddedPiRunResult — return of runEmbeddedPiAgent(), in src/agents/pi-embedded-runner/run/types.ts
EmbeddedPiRunResult = {
  text: string,
  stopReason: string,
  usage?: UsageLike,
  agentMeta?: EmbeddedPiAgentMeta,
  // ...
}

// Lane — concurrency isolation primitive, in src/process/lanes.ts + command-queue.ts
// CommandLane = string enum (defined in lanes.ts)
// resolveSessionLane(sessionKey) → CommandLane
// resolveGlobalLane(lane?) → CommandLane
// enqueueCommandInLane(lane: CommandLane, task, opts?) — serializes work within the same lane
```

---

## 2. Resolution Layer

### 2.1 Agent Scope Config

File: `src/agents/agent-scope-config.ts`

```typescript
listAgentIds()                  // returns all agent IDs from config
listAgentEntries()              // returns full AgentEntry[] with defaults merged
resolveAgentConfig(id)          // fetch a specific agent's config
resolveDefaultAgentId()         // find the agent with default: true
ResolvedAgentConfig             // type: resolved config with defaults applied
```

### 2.2 Agent Scope Resolution

File: `src/agents/agent-scope.ts`

```typescript
resolveSessionAgentIds(params)       // picks agent from session key, explicit param, or default
resolveAgentExecutionContract()      // determines embedded vs ACP runtime
resolveSessionAgentId(session)       // resolves agent for a given session
```

---

## 3. Runtime Layer

### 3.1 Embedded Runtime (primary)

File: `src/agents/pi-embedded-runner/run.ts`

`runEmbeddedPiAgent()` / `runEmbeddedAgent()` — both are exported separately from `pi-embedded.ts`; prefer `runEmbeddedPiAgent` for clarity.

**Return type:** `Promise<EmbeddedPiRunResult>`

**Execution flow:**

```
1. Session lane resolution
   ├── resolveSessionLane(sessionKey)
   └── resolveGlobalLane(lane)

2. Workspace resolution
   └── resolveRunWorkspaceDir(sessionKey, agentId, config)

3. Plugin loading
   └── ensureRuntimePluginsLoaded(config, workspaceDir)

4. Model resolution
   ├── provider = params.provider ?? DEFAULT_PROVIDER
   ├── modelId = params.model ?? DEFAULT_MODEL
   └── resolveModelAsync() + resolveHookModelSelection()  [run/setup.ts]

5. Auth profile selection
   ├── resolveAuthProfileEligibility()
   ├── resolveAuthProfileOrder()
   └── applyAuthHeaderOverride()

6. System prompt building
   ├── resolveSkillsPromptForRun()  [skills/workspace.ts]
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
   ├── MCP tool bundling          [ensureSessionMcpRuntime() at loop start, pi-bundle-mcp-tools.ts]
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
| `run/attempt.ts` | `runEmbeddedAttempt()` — single-attempt orchestrator: workspace setup, prompt building, streaming, compaction, teardown (~2400 lines) |
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
| `run/attempt.tool-run-context.ts` | Tool execution context (sandbox routing, workspace injection) |
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
| `sandbox-info.ts` | `buildEmbeddedSandboxInfo()` — workspace mount, elevated access, browser bridge URL |
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

File: `src/auto-reply/reply/agent-runner-execution.ts`

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
   └── resolveAgentExecutionContract()  // embedded vs ACP

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

A full subsystem with its own store, credential state machine, OAuth flow, health tracking, and repair workflows. The directory contains **37 files** — the key surface:

```typescript
// profiles.ts — AuthProfile type and store
AuthProfile = {
  id: string,
  provider: string,
  apiKey?: string,
  oauth?: { clientId, clientSecret, refreshToken },
  // ...
}

// types.ts — core AuthProfile type
// persisted.ts — persisted credential representation
// store.ts — persistent encrypted credential store
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

// state-observation.ts — live health tracking
markAuthProfileGood()
markAuthProfileFailure()

// runtime-snapshots.ts — snapshot isolation during config reload
// session-override.ts — per-session auth overrides
// usage.ts — usage tracking per profile
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
buildWorkspaceSkillSnapshot()      // copies skills to workspace
syncSkillsToWorkspace()            // syncs skill files to workspace
loadWorkspaceSkillEntries()        // loads skill metadata
resolveSkillsPromptForRun()         // builds skills section of system prompt

// src/agents/skills/config.ts
resolveSkillConfig()
isBundledSkillAllowed()
resolveBundledAllowlist()

// src/agents/skills/workspace.ts
buildWorkspaceSkillSnapshot()
loadWorkspaceSkillEntries()
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

**Snapshot versioning:** Each workspace skill snapshot has a version number. `getSkillsSnapshotVersion()` returns the current version. `shouldRefreshSnapshotForVersion()` decides whether to rebuild the snapshot when the skill config changes.

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

**Execution order:** Hooks run in registration order within each type. Global hooks are initialized once at startup via `initializeGlobalHookRunner()` in `src/plugins/loader.ts`. Return values can mutate the intercepted data (e.g., `before_prompt_build` can return an overridden prompt).

---

## 9. MCP Integration

MCP tools are bundled and routed in the tool execution loop. The key files:

```typescript
// src/agents/pi-bundle-mcp-tools.ts
disposeSessionMcpRuntime()     // disposes MCP runtime for a session
ensureSessionMcpRuntime()      // creates/bundles MCP tools for a session

// src/plugins/runtime/runtime-agent.ts — MCP tool bundling in plugin runtime
```

**What is bundled:** All MCP servers registered with the gateway are exposed to the agent as tools. The bundling transforms MCP tool schemas into the Pi agent's tool format.

**Protocol:** MCP tools use JSON-RPC 2.0 over stdio (the standard MCP protocol). The MCP server can be in-process or a separate process.

**Lifecycle:**
1. Session starts → `ensureSessionMcpRuntime()` bundles MCP tools
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

// Failover decision
FailoverReason =
  | "billing"
  | "rate_limit"
  | "context_overflow"
  | "compaction_failure"
  | "model_error"
  | "transient_http"
  | "unknown"

// Resolution — resolveRunFailoverDecision() in run/failover-policy.ts (3 overloads)
resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision
resolveRunFailoverDecision(params: RunFailoverDecisionParams): RunFailoverDecision
resolveRunFailoverDecision(params: RetryLimitDecisionParams): RetryLimitFailoverDecision
handleRetryLimitExhaustion(params)           // dead-letter path
handleAssistantFailover(attempt, error)       // model-level failover
FailoverError                                 // structured error type (failover-error.ts)
resolveFailoverStatus(error)                  // classify + route
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
ACP errors are wrapped in `FailoverError` and classified by `resolveFailoverStatus()`.

**Retry budget:** Each run has a configurable `retryLimit`. Once exhausted, `handleRetryLimitExhaustion()` determines the dead-letter path — surface error to user or archive session.

---

## 11. Session State

Sessions are **not** a formal state machine. State is event-driven and timestamp-based. There are three relevant surfaces:

**1. Diagnostic state** (`src/logging/diagnostic-session-state.ts`):
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

**Persistence layer:** Sessions are stored in `sessions/` as JSON files. Key fields:
```typescript
SessionEntry = {
  id, sessionKey, agentId, createdAt, updatedAt,
  compactionCount, status?, heartbeatKey?,
  updatedAt, idleExpiresAt, lastHeartbeatAt, ...
}
```
Session pruning is driven by `updatedAt` vs `idleExpiresAt` and `archiveAfterMinutes`.

**Heartbeat:** Heartbeat agents run in isolated sessions with `:heartbeat` key suffix (`resolveSessionAgentId()`). They are independent sessions, not sub-states of the parent.

**Lane isolation:** `resolveSessionLane()` assigns each session to a lane. `enqueueCommandInLane(lane, task, opts)` serializes work within a lane. Concurrent tool calls within the same session are serialized. Sessions with `scope: "shared"` in sandbox config share a lane.

---

## 12. Plugin SDK — External Extension Interface

File: `src/plugins/runtime/index.ts` — `createPluginRuntime()`

The full `PluginRuntime` object:

```typescript
PluginRuntime = {
  agent,                   // runEmbeddedAgent / runEmbeddedPiAgent
  subagent,               // spawned sub-agent operations
  tasks,                  // task CRUD
  taskFlow,               // workflow orchestration
  channel,                // channel operations
  memory,                 // memory engine runtime
  webSearch,              // search tools
  config,                 // agent config access
  events,                 // hook system (runtime-events.ts)
  logging,                // structured logging
  tts,                    // text-to-speech
  stt,                    // speech-to-text
  mediaUnderstanding,
  modelAuth,              // auth profile management
  imageGeneration,
  videoGeneration,
  musicGeneration,
}
```

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

Sub-agents are spawned from the main agent via the `spawn` tool (in `tools/sessions-spawn-tool.ts`):

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
- `src/agents/spawned-context.ts` — `normalizeSpawnedRunMetadata()`
- `src/cron/isolated-agent/` — isolated sessions for heartbeat/cron agents

**IPC mechanism:** Sub-agent sessions communicate via the session store (`session-store.ts`). The parent agent can send messages to and receive messages from child sessions. Lifecycle teardown: when a parent session terminates, child sessions are marked for archival and no further messages are routed to them.

---

## 14. System Diagram

```
Config (zod-schema.agents.ts)
  ├── agents.defaults — global fallbacks (AgentDefaultsSchema)
  ├── agents.list[] — named agent entries (AgentEntrySchema)
  │     ├── runtime: "embedded" | "acp"
  │     ├── embeddedPi: project settings, execution contract
  │     ├── sandbox: docker / ssh / browser
  │     ├── tools: allowlists, exec policies, loop detection
  │     ├── memorySearch: vector + FTS config
  │     ├── skills: workspace skill snapshots
  │     ├── subagents: spawn permissions
  │     └── heartbeat: periodic agent
  └── bindings[] — channel → agent routing
        ├── type: "route" — in-process embedded
        └── type: "acp"   — out-of-process child via spawnAcpDirect()

Incoming Message
  │
  ▼
runReplyAgent()  [agent-runner-execution.ts]
  │
  ├── resolveSessionAgentId()
  ├── resolveAgentExecutionContract()
  ├── resolveRunAuthProfile()
  ├── buildEmbeddedRunExecutionParams()
  │
  ▼
┌─ embedded ─────────────────────────────────────────────────────────┐
│ runEmbeddedPiAgent()  [pi-embedded-runner/run.ts]                     │
│                                                                        │
│  1. workspace resolution                                                │
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
│   → spawnAcpDirect("run"|"session")  [acp-spawn.ts]                   │
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
| `lancedb` | Vector + FTS memory store |
| `packages/memory-host-sdk/` | Memory engine (monorepo package) |
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
6. **Skills snapshots** — versioned workspace snapshots; `getSkillsSnapshotVersion()` tracks current version; `shouldRefreshSnapshotForVersion()` decides whether to rebuild on config change
7. **Memory engine** — LanceDB with hybrid vector+FTS; MMR reranking for diversity; temporal decay for recency weighting; sync on session start, search, interval, or watch
8. **Plugin harness** — plugins register `AgentHarness*` to replace the low-level agent runtime; harness intercepts `EmbeddedRunAttemptParams` / `EmbeddedRunAttemptResult`
9. **Hook runner** — `getGlobalHookRunner()` provides typed hook execution; 29 hooks in `PluginHookName` (`before_model_resolve`, `llm_input`, `before_tool_call`, `agent_end`, etc.); hooks initialized at startup in `src/plugins/loader.ts`; execution order matches registration order; return values can mutate intercepted data
10. **Failover policy** — `FailoverReason` enum drives recovery: billing → surface error, rate_limit → rotate + backoff, context_overflow → compact, model_error → retry with failover; retry budget prevents infinite loops
