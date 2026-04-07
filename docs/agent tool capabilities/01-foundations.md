# Agent Tool Capability Model (Checkbox + Inheritance)

## 1) Goal

This document is the target model, not the current runtime implementation.

Provide a single capability system where:
- every available tool is registered in a central registry,
- roles define inherited tool defaults,
- each managed agent can override inherited tool permissions and runtime config,
- UI renders this as checkboxes (allow/deny) plus optional per-tool config overrides.

## 2) Current gap in the codebase

Current behavior is static:
- tool list lives as hardcoded `allTools`,
- role permissions are hardcoded in `ROLE_POLICIES`,
- managed agents only store `tools: string[]`,
- no per-agent tool override or tool registration API,
- no persisted tool config per agent/tool.

## 3) Data model

### 3.1 Tool registry

This schema is target-state only.

```ts
type ToolCapabilitySchema = {
  id: string           // stable unique key, e.g. "bash"
  name: string         // runtime tool name, e.g. "Bash"
  label: string        // short user-facing name, e.g. "Bash"
  overview: string     // concise summary of what the tool does
  instructions: string // concise usage guidance and guard rails
  source: 'builtin' | 'custom'
  enabled: boolean
  tags: string[]       // indexed tags for discoverability
  mcpServers?: string[] // optional MCP registry targets this tool may use
  baseSearchTerms: string[] // aliases, deprecated names, synonyms
  allowSearchTerms: string[] // additional search hits from schema/instruction payloads
  basePrompt: {
    content: string
    mergeMode: 'append' | 'prepend' | 'replace'
  }
  inputSchema: z.ZodTypeAny
  // Full JSON object to support arbitrary custom tool configuration
  defaultConfig: Record<string, unknown>
}
```

### 3.2 Tool runtime config

```ts
type ToolRuntimeConfig = {
  // Structured base config for built-in tooling (non-blocking, optional).
  // Custom tools may use any other keys.
  timeoutMs?: number
  maxOutputBytes?: number
  workingDirectory?: string
  retries?: number
  requireApproval?: boolean
  allowDestructive?: boolean
  [key: string]: unknown
}
```

### 3.3 Permission + override model

```ts
type ToolGrant = {
  toolId: string
  state: 'inherit' | 'allowed' | 'denied'
  // Arbitrary JSON config payload, merged with tool defaults.
  config?: Record<string, unknown>
  source: 'inherited' | 'agent-override'
}

type RoleToolPolicy = {
  roleId: string
  grants: Record<string, ToolGrant> // key = toolId
}

type AgentToolOverrides = {
  mode: 'inherit' | 'custom'
  grants: Record<string, Omit<ToolGrant, 'source'>>
}

type ManagedAgent = {
  id: string
  name: string
  roleId?: string
  provider?: 'openai' | 'anthropic' | 'minimax' | 'ollama' | 'custom'
  model?: string
  tools: string[]            // for migration/backward compatibility
  toolPolicy?: AgentToolOverrides
  mcpPolicy?: {
    allowedServers: string[]
    deniedServers?: string[]
  }
  executionPolicy?: {
    orchestrator?: {
      mode: 'same-agent' | 'fixed-agent' | 'channel-organizer'
      // Required when mode is fixed-agent
      agentId?: string
      // Keep the same orchestrator across all aggregation passes
      // so selection style and audit behavior stay consistent.
      sticky?: boolean
      // When true, the orchestrator receives every candidate output
      // and its scoring metadata for synthesis/selection.
      collectAllFindings?: boolean
    }
    stages?: Array<{
      stageId: string
      kind: 'generate' | 'critique' | 'refine' | 'reevaluate'
      parallelism?: {
        runCount?: number
      }
      aggregation?: {
        enabled: boolean
        mode: 'score' | 'rank' | 'vote'
        passCount?: number
        executor?: 'same-agent' | 'orchestrator' | 'custom-agent'
        customAgentId?: string
      }
      // When true, this stage consumes the previously selected output
      // instead of the original task input.
      usesPreviousBest?: boolean
    }>
    // Stop runaway cost/latency loops.
    maxTotalRuns?: number
    // Optional reviewer model/provider overrides for evaluation passes.
    evaluatorProvider?: 'openai' | 'anthropic' | 'minimax' | 'ollama' | 'custom'
    evaluatorModel?: string
  }
  subAgents?: string[]       // optional additional sub-agents this agent can spawn/coord
  // existing fields: type, trigger, responsibility, intervalMinutes...
}
```

### 3.4 Effective policy resolution

```ts
effectiveToolPolicy(agent, rolePolicy) =
  merge(rolePolicy.grants, agent.toolPolicy?.grants, source='agent-override')
```

- inherited values apply first,
- agent overrides replace inherited state/config when present,
- explicit `state: 'denied'` blocks a role default,
- explicit `state: 'inherit'` keeps the parent decision without creating a deny.

### 3.4a Agent execution loop policy

Provider/model choice and loop strategy must be part of agent configuration, not hidden prompt behavior.

The goal is to support low-cost or unreliable providers with deterministic extra passes.

Example:

```ts
const minimaxWorker = {
  provider: 'minimax',
  model: 'MiniMax-M2.5',
  executionPolicy: {
    orchestrator: {
      mode: 'fixed-agent',
      agentId: 'quality-orchestrator',
      sticky: true,
      collectAllFindings: true
    },
    stages: [
      {
        stageId: 'draft',
        kind: 'generate',
        parallelism: { runCount: 3 },
        aggregation: { enabled: true, mode: 'score', passCount: 1, executor: 'same-agent' },
        usesPreviousBest: false
      },
      {
        stageId: 'refine',
        kind: 'refine',
        parallelism: { runCount: 2 },
        aggregation: { enabled: true, mode: 'score', passCount: 1, executor: 'same-agent' },
        usesPreviousBest: true
      },
      {
        stageId: 'reevaluate',
        kind: 'reevaluate',
        parallelism: { runCount: 3 },
        aggregation: { enabled: true, mode: 'rank', passCount: 1, executor: 'orchestrator' },
        usesPreviousBest: true
      }
    ],
    maxTotalRuns: 12,
    evaluatorProvider: 'openai',
    evaluatorModel: 'gpt-5'
  }
}
```

Required behavior:
- each stage can fan out into multiple parallel candidates,
- each stage can aggregate those candidates and select one best result,
- aggregation can be executed by the same agent, by a dedicated orchestrator pass, or by a custom agent,
- when `executionPolicy.orchestrator` is configured, the same orchestrator instance should be reused across aggregation passes unless a stage explicitly overrides it,
- the orchestrator should receive all candidate outputs, scores, and provenance for the stage when `collectAllFindings` is enabled,
- later stages can consume the previous selected output (`usesPreviousBest: true`),
- this allows “parallelism inside loops” and “loops after parallel drafts” in the same config,
- all stage counts are configurable per agent,
- the runtime must enforce a hard cap (`maxTotalRuns`) to control cost and runaway loops,
- evaluation/refinement metadata should be auditable as part of the task ledger.

Terminology:
- `parallelism`: multiple independent candidates inside one stage.
- `loop`: a later stage that consumes the previous stage's selected best output.
- `orchestrator aggregation`: a pass that receives all candidate findings and emits the selected best result for the next stage.
- `stable orchestrator`: the same configured agent or hidden organizer reused to aggregate findings across multiple stages in one execution pipeline.
- `execution pipeline`: the full ordered list of stages, each with its own parallelism and aggregation.

### 3.5 Search index contract for tools

Every tool entry must provide deterministic metadata so agents can retrieve only what they need.

```ts
type ToolSearchDocument = {
  id: string
  label: string
  overview: string
  instructions: string
  tags: string[]
  basePrompt: {
    content: string
    mergeMode: 'append' | 'prepend' | 'replace'
  }
  source: 'builtin' | 'custom' | 'mcp-remote' | 'interactive-session'
  transport: 'direct' | 'mcp' | 'stdio' | 'http' | 'pty'
  allowed: boolean
  owner: string
  createdBy: 'system' | 'role' | 'agent'
  version: string
  updatedAt: string // RFC3339
  searchableText: string // derived from overview + instructions + basePrompt + tags + alias terms
}

type ToolSearchResult = {
  items: ToolSearchDocument[]
  total: number
  filtered: number
  page: number
  pageSize: number
  cursor?: string
  etag: string
}
```

Search behavior must be deterministic:
- sort order uses `updatedAt DESC, source ASC, label ASC, id ASC` unless caller provides an explicit `sort`
- pagination uses opaque `cursor` where `cursor` maps to a stable `(updatedAt, id)` boundary
- ties always use lexical `id` so identical filter/sort inputs are replayable.

Discovery payload must include:
- `q` (full-text)
- `tags` filter (multi-value)
- `scope` (`agent`, `task`, `global`, `mcp`, `custom`, `builtin`, `interactive`)
- `state` (`enabled`/`disabled`)
- `source` and `transport` filters
- optional `limit` (<=100, default 25)

### 3.6 Why this contract exists

- `overview` and `instructions` keep the tool's usage model in one place so runtime calls stay deterministic and avoid hidden behavior drift.
- `basePrompt` and prompt override fields separate tool call policy from tool input schema, enabling consistent injection across agents.
- `tags`, `baseSearchTerms`, and `allowSearchTerms` are required for low-cardinality pre-filters, reducing agent context size at startup.
- deterministic sort plus cursor pagination allows long-lived agents to request more tools as needed without reprocessing entire inventories.
- one-file manifests make onboarding and marketplace ingestion testable and auditable before enablement.
