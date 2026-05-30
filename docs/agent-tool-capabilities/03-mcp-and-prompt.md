# MCP Control Plane and Prompt Layers

## 9) MCP-driven capability control plane

Target model is a unified registry that includes both:
- executable tools (`allTools`) used by `invoke_tool` and sub-agent execution, and
- control-plane MCP tools exposed by `src/mcp/server.ts`.

### 9.1 Registry shape

```ts
type ToolCatalogEntry = {
  id: string                      // stable slug, e.g. "bash_v1"
  toolName: string                // runtime name, e.g. "Bash"
  label: string                   // short user-facing label
  overview: string                // deterministic summary used by search index
  instructions: string             // instructions surfaced for manual review
  source: 'builtin' | 'custom' | 'mcp-remote' | 'interactive-session'
  transport: 'direct' | 'mcp' | 'stdio' | 'http' | 'pty'
  transportConfig: Record<string, unknown> // e.g. base command, endpoint, env policy, working directory
  inputSchema: z.ZodTypeAny        // JSON schema / zod-backed input contract
  outputShape?: z.ZodTypeAny
  tags: string[]                  // searchable tags, e.g. ['filesystem', 'search', 'session']
  baseSearchTerms: string[]       // aliases/legacy search terms
  allowSearchTerms: string[]      // optional schema-derived terms
  basePrompt: {
    content: string                // appended/prepended/replaced whenever tool runs
    mergeMode: 'append' | 'prepend' | 'replace'
  }
  commonPrompt: {
    enabledPrompt: string      // appended whenever tool is used and permitted
    overviewPrompt?: string    // shown in list/search rendering
    blockedPrompt?: string     // emitted when deny/abort happens
    overrideMode: 'append' | 'replace'
  }
  // Effective runtime grant resolved from the canonical ToolGrant model
  // in 01-foundations.md.
  grant: {
    state: 'inherit' | 'allowed' | 'denied'
    config: Record<string, unknown> // arbitrary JSON config payload
    source: 'inherited' | 'agent-override'
  }
  createdBy: 'system' | 'role' | 'agent'
  owner: string
  audit?: Record<string, unknown>
}
```

Tool categories this model supports:
- CLI tool (`transport: 'direct'`) with command + args.
- PTY/interactive tool (`transport: 'pty'`) for long-lived sessions.
- MCP bridge tool (`transport: 'mcp'`) to another model context protocol server.
- HTTP tool (`transport: 'http'`) for API-driven integrations (Ollama, GitHub, etc.).
- File/IO tool (`transport: 'direct'`) with explicit path and sandbox policy.
- DB/tooling tool using custom runtime adapters in `transportConfig`.
- Any custom tool whose `transportConfig` and schema are represented as arbitrary JSON.

### 9.2 Runtime lookup and execution boundary

1. Resolve effective `ToolCatalogEntry`:
   - user request context (agent/task/session)  
   - inherited + override grant policy
   - optional tool-level and sandbox constraints
   - if `transport === 'mcp'`, resolve against the registered MCP server allowlist for the agent
2. Evaluate policy deny/allow.
3. Materialize invocation context with merged config.
4. Dispatch according to `transport`.
5. Validate output if schema exists.
6. Emit audit event.

### 9.3 MCP registry sync

- Keep MCP tool list as a projection of the registry.
- MCP tool definition should be auto-generated from catalog entries when `transport` is `mcp` or when custom wrappers are exposed.
- Agent-level MCP access must be explicit through `mcpPolicy.allowedServers`; the registry must not expose unapproved servers to agents even if the broader org can see them.
- Keep static built-ins as first-class entries in the catalog.
- Add a versioned cache + `list`/`search` response metadata:
  - `total`
  - `filtered`
  - `cursor`
  - `etag` (for client cache invalidation).

## 10) Prompt inheritance and override model for tools + agents

Tool and agent prompts are separate from schemas and can be managed independently.

```ts
type PromptLayer = {
  id: string
  type: 'global' | 'role' | 'agent' | 'task' | 'tool-call'
  content: string
  priority: number
  mergeMode: 'append' | 'prepend' | 'replace'
  locked?: boolean
}

type PromptProfile = {
  commonPrompt: string
  deniedPrompt?: string
  allowedPrompt?: string
  inherit?: string[]         // parent profile ids
  layers?: PromptLayer[]
  defaults: Record<string, unknown> // structured or arbitrary JSON
}

type ManagedAgentProfile = {
  systemPrompt: string
  userPrompt: string
  toolPrompt: PromptProfile
  rolePrompt?: PromptProfile
  subAgentPrompt?: PromptProfile
  toolOverrides?: Record<string, PromptProfile> // per-tool override
  subAgents?: AgentId[]
}
```

- Resolve prompt for a given execution as:
  1. global role/default prompt
  2. agent prompt (including `subagent`/on-demand variants)
  3. task-specific prompt
  4. tool prompt layer
  5. per-tool override
  6. call-level override from explicit user input (if approved by approval gate in UI context)

- Tool-level override can replace or append to inherited prompt.
- Agent-level override can add prompts for all child sub-agents unless the child sets `inheritPrompt = false`.
- UI should expose this as a matrix:
  - base prompt (read-only)
  - override editor per row
  - inheritance chain toggle.
