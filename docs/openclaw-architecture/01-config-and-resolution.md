# Config and Resolution

## 1. Config Layer

### 1.1 Top-Level Schema

File: `src/config/zod-schema.agents.ts`

Four independent top-level exports — `AgentsSchema`, `BindingsSchema`, `BroadcastSchema`, and `AudioSchema` are sibling schemas, not nested:

```typescript
AgentsSchema = {
  defaults?: AgentDefaultsSchema,   // global fallbacks applied before per-agent overrides
  list?: AgentEntrySchema[],        // named agents array
}

BindingsSchema  // route + ACP bindings — independent export
BroadcastSchema // broadcast config — independent export
AudioSchema     // audio config — independent export
```

> `bindings`, `broadcast`, and `audio` are **not** fields inside `AgentsSchema`. They are parsed as independent top-level keys in the gateway config file.

### 1.2 Agent Entry Schema

File: `src/config/zod-schema.agent-runtime.ts`

Each agent in `agents.list[]` is defined by `AgentEntrySchema`:

```typescript
AgentEntrySchema = {
  id: string,                                    // unique agent identifier
  default?: boolean,                             // marks the default agent (used when none specified)
  name?: string,                                 // human-readable name
  team?: string,                            // team directory for this agent
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
  runtime?: RuntimeSchema,                        // discriminated object: embedded vs acp
}
```

Where `RuntimeSchema` is a discriminated object (not a string union):
```typescript
RuntimeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("embedded") }),
  z.object({
    type: z.literal("acp"),
    acp: z.object({
      mode: z.enum(["run", "session"]).optional(),  // run=oneshot, session=persistent
      label: z.string().optional(),
      cwd: z.string().optional(),
      backend: z.string().optional(),
    }).optional(),
  }),
])
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
  team?: string,
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
    mode?: "persistent"|"oneshot",  // config-level: "persistent" = long-lived, "oneshot" = single exchange
    label?: string,
    cwd?: string,
    backend?: string,
  },
}
```

> ACP binding modes at config level: `"persistent"` (long-lived, maintains state) vs `"oneshot"` (single request/response). At the tool/runtime API level, the equivalent modes are `"run"` (oneshot) and `"session"` (persistent).

> ACP bindings require `match.peer.id` — the binding must target a concrete conversation.

### 1.5 Sandbox Schema

File: `src/config/zod-schema.agent-runtime.ts`

Supports three isolation environments:

```typescript
AgentSandboxSchema = {
  mode?: "off"|"non-main"|"all",
  backend?: string,
  teamAccess?: "none"|"ro"|"rw",
  scope?: "session"|"agent"|"shared",
  teamRoot?: string,
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
  teamRoot?: string,
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
      teamOnly?: boolean,
      allowModels?: string[],
    },
  },
  fs?: { teamOnly?: boolean },
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
    primary: z.string().optional(),        // optional — can omit if only fallbacks used
    fallbacks: z.array(z.string()).optional(),  // optional — can omit if only primary used
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

// EmbeddedPiRunResult — return of runEmbeddedPiAgent(), in src/agents/pi-embedded-runner/types.ts
EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string,
    mediaUrl?: string,
    mediaUrls?: string[],
    replyToId?: string,
    isError?: boolean,
    isReasoning?: boolean,
    audioAsVoice?: boolean,
  }>,
  meta: EmbeddedPiRunMeta,
  didSendViaMessagingTool?: boolean,     // true if a messaging tool sent successfully
  messagingToolSentTexts?: string[],
  messagingToolSentMediaUrls?: string[],
  messagingToolSentTargets?: MessagingToolSend[],
  successfulCronAdds?: number,
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
resolveSessionAgentIds(params)               // picks agent from session key, explicit param, or default
resolveAgentExecutionContract(cfg, agentId) // resolves executionContract: "default" | "strict-agentic"
resolveSessionAgentId(session)               // resolves agent for a given session
```

---

## 3. Runtime Layer
