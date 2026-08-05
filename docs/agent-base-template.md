# Agent Base Template

Defines the universal agent contract in Nessie — what every agent is, what it can do, and how it operates. All agent types (built-in, user-created, spawned children) conform to this template.

This document serves as the foundation for the agent system. Any new agent type must satisfy this contract.

Related documents:
- [the-agents.md](the-agents.md) — canonical reference for agent architecture, execution, skills, and roadmap
- [multi-agent-memory-system.md](done/multi-agent-memory-system.md) — memory types, retrieval, self-eval
- [research/agent-identity-and-channels.md](research/agent-identity-and-channels.md) — external identity (email, VOIP, WhatsApp, SMS)

---

## 1. The Six Fundamentals

Every agent in Nessie must have these six properties. No exceptions.

### Goal

An agent exists to achieve something. Without a goal, it's a text generator.

In Nessie, the goal is expressed through:
- **`role`** — what kind of agent this is (e.g., `assistant`, `builder`, `researcher`, `debugger`)
- **`systemPrompt`** — behavioral instructions that define the agent's purpose, constraints, and personality

An agent with no goal should not exist. The system should reject agent creation without at least a role.

### Perception (Input)

The agent must receive input from its environment:
- **User messages** — direct text from humans in channels/threads
- **Channel context** — recent conversation history (last 20 messages loaded per run)
- **Memory context** — recalled memories injected into the prompt (semantic, procedural, framing)
- **Tool results** — output from tools executed during the run
- **System events** — task assignments, approval requests, spawn notifications

### Brain (Reasoning Engine)

The LLM that powers decision-making:
- **`provider`** — which LLM provider (e.g., `openai`, `anthropic`)
- **`model`** — which model (e.g., `gpt-4o`, `claude-sonnet-4-5-20250514`)
- Configurable per agent — different agents can use different models
- The orchestrator can override the model for cost optimization (cheap model for classification, expensive for complex reasoning)

### Memory

Persistent context across runs (see [multi-agent-memory-system.md](done/multi-agent-memory-system.md)):
- **Working memory** — current context window (implicit, not stored)
- **Semantic memory** — facts, decisions, knowledge (pgvector embeddings)
- **Reasoning memory** — why decisions were made (structured records)
- **Procedural memory** — how to do things (structured steps)
- **Framing memory** — where to start in a domain (entry points, patterns)
- **Episodic memory** — past experiences (situation-action-outcome)
- **Personalization** — user communication preferences (future)

### Tools (Actions)

What makes an agent an agent instead of a chatbot. Tools are the agent's hands:
- **Current built-in tools**: `document_read`, `web_fetch`, `web_search`
- **Role-scoped tools**: Bash, FileRead, FileWrite, Glob, Grep, WebSearch (assigned per role)
- **Tool policy**: Per-agent allow/deny map stored as JSON on the agent record
- Tools are what let agents act on the world — read files, run commands, search the web, write code

### Loop (Continuous Operation)

The agent operates in a cycle, not a single request-response:

```
Perceive → Think → Act → Update → Repeat
```

In Nessie's current implementation, one iteration of this loop is a **Run**:
1. **Perceive**: Load message + conversation history + memories + tool context
2. **Think**: LLM processes everything, decides response
3. **Act**: Execute tools (currently pre-run), generate response
4. **Update**: Save messages, update recall signals, capture memories
5. **Repeat**: Next message triggers a new run

---

## 2. Current Agent Object

### Database Record (Prisma)

Every agent is persisted with these fields:

| Field | Type | Required | Default | Purpose |
|-------|------|----------|---------|---------|
| `id` | UUID | Auto | Generated | Unique identifier |
| `name` | String | Yes | — | Display name |
| `role` | String | Yes | `"assistant"` | Agent type / purpose |
| `status` | Enum | Yes | `idle` | Current operational state |
| `systemPrompt` | String | No | null | Behavioral instructions |
| `toolPolicy` | JSON | No | null | Per-tool allow/deny map |
| `provider` | String | No | null | LLM provider |
| `model` | String | No | null | LLM model identifier |
| `parentAgentId` | UUID | No | null | Parent agent (for hierarchy) |
| `organizationId` | UUID | No | null | Org scope |
| `projectId` | UUID | No | null | Project scope |
| `teamId` | UUID | No | null | Team scope |
| `createdAt` | DateTime | Auto | now() | Creation time |
| `updatedAt` | DateTime | Auto | now() | Last modification |

**Relations**: `parentAgent`, `childAgents[]`, `bindings[]` (channels), `categoryLinks[]`, `messages[]`, `runs[]`, `tasks[]`, `approvalRequests[]`

### Status Lifecycle

```
idle ──→ thinking ──→ executing ──→ idle
  │         │            │
  │         └───→ waiting_approval ──→ idle
  │         │
  │         └───→ error
  │
  └───→ offline (remote worker down)
```

| Status | Meaning |
|--------|---------|
| `idle` | No active work |
| `thinking` | LLM call in flight |
| `executing` | Running a tool |
| `waiting_approval` | Blocked on approval gate |
| `error` | Last run failed |
| `offline` | Registered but unreachable |

Status transitions are server-authoritative, pushed via WebSocket within 500ms.

### API Contract (Create)

```typescript
// Required
name: string          // Agent display name
role: string          // Agent type (default: "assistant" if omitted)

// Recommended
systemPrompt: string  // Without this, agent has no specific goal

// Optional
parentAgentId: string // Parent for hierarchy
toolPolicy: Record<string, boolean>  // { "Bash": true, "FileWrite": false }
provider: string      // LLM provider
model: string         // LLM model
```

While only `name` + `role` are strictly required, agents without a `systemPrompt` default to generic assistant behavior. For production agents, `role` + `systemPrompt` define the goal and are strongly recommended.

### In-Memory Types (Legacy Orchestrator — `src/` only)

> **Warning**: This type exists only in the legacy local orchestrator (`src/agent/`). It is NOT active in the deployed API/worker architecture. The API-layer `agents` table is the source of truth. Scheduling fields (`trigger_type`, `trigger_config`) have been added to the API model — see the-agents.md § 17 for the full trigger system. This legacy type should be removed once migration is complete.

```typescript
type ManagedAgent = {
  id: string
  name: string
  type: 'orchestrator' | 'coder' | 'weather' | 'custom'
  responsibility: string
  trigger: 'main' | 'on-demand' | 'hourly'
  tools: string[]
  intervalMinutes?: number
  lastRunAt?: number
  nextRunAt?: number
}
```

The `ManagedAgent.type` values (`coder`, `weather`, `custom`) do NOT correspond to the API-layer roles (`orchestrator`, `builder`, `reviewer`, `researcher`, `debugger`, `watcher`). These are two separate systems. Migration path: the API `agents` table now has `trigger_type` and `trigger_config` columns (see the-agents.md § 17). Remove `ManagedAgent` once all legacy orchestrator code is migrated.

---

## 3. How an Agent Runs

### Run Execution Flow

A **Run** is one complete perceive-think-act cycle. Every agent interaction creates a Run record.

```
Message arrives
  │
  ├── 1. Create Run record (status: pending → queued when enqueued to worker)
  │
  ├── 2. Load context
  │     ├── Agent record (name, role, systemPrompt, toolPolicy)
  │     ├── Thread / channel
  │     ├── Task (if task-driven)
  │     └── Actor context (who triggered this)
  │
  ├── 3. Update statuses
  │     ├── Run → running
  │     ├── Task → in_progress
  │     └── Agent → thinking
  │
  ├── 4. Execute tools (pre-run, based on prompt analysis)
  │     ├── document_read (if prompt mentions docs/specs)
  │     ├── web_fetch (if prompt contains URL)
  │     └── web_search (if prompt mentions search/lookup)
  │
  ├── 5. Maybe spawn child agent
  │     └── If prompt contains "spawn" / "delegate" keywords
  │
  ├── 6. Load conversation history (last 20 messages in thread)
  │
  ├── 7. Retrieve memories from vector store
  │     └── Hybrid search scoped to org/project/channel
  │
  ├── 8. Build prompt
  │     ├── System: agent identity + systemPrompt + instructions
  │     ├── History: conversation messages
  │     ├── Context: memory context (if retrieved)
  │     └── User: current message + tool outputs
  │
  ├── 9. Stream LLM response
  │     └── SSE deltas pushed to client
  │
  ├── 10. Save assistant message
  │
  ├── 11. Update recall signals (mark memories as injected/referenced)
  │
  └── 12. Update statuses
        ├── Run → completed (or failed)
        ├── Task → done (or failed)
        └── Agent → idle (or error)
```

### System Prompt Construction

The system prompt is built dynamically from the stored `systemPrompt` field plus runtime context:

```
"You are {agent.name}."
+ agent.systemPrompt (from agent record)
+ "Respond directly to the request using the available tool results when they are relevant."
+ "Use relevant memory context when it helps, but prefer the latest explicit user instructions on conflict."
+ "The required safe tools have already been executed."
+ "Do not emit tool-call markup or request more tool execution."
+ "Return plain text only."
+ "Keep the answer concise and concrete."
```

The stored `systemPrompt` defines WHO the agent is. The runtime additions define HOW it should behave in this specific run.

> **Known limitation**: The "Do not emit tool-call markup" instruction hard-bakes single-shot execution. The agent cannot act on recalled memories or decide mid-response that it needs more information. This instruction will be removed when the agentic loop (Phase 1) replaces keyword-based tool execution.

---

## 4. How an Agent Calls Tools

### Current Model: Pre-Run Tool Execution

Tools are currently executed **before** the LLM call, not during it. The system analyzes the user's prompt and decides which tools to run:

```typescript
// Keyword detection triggers tool execution
shouldUseDocumentRead(prompt)  // "doc", "read", "spec", "phase", "architecture"
shouldUseWebFetch(prompt)      // URL pattern (http:// or https://)
shouldUseWebSearch(prompt)     // "search", "latest", "look up", "web"
```

Tool results are fed into the LLM as context alongside the user message. The agent does NOT use the LLM's native tool-calling/function-calling protocol.

### Built-In Safe Tools

| Tool | Trigger | Capability | Limit |
|------|---------|------------|-------|
| `document_read` | Prompt mentions docs | Read `.md` files from project | 4000 chars output |
| `web_fetch` | Prompt contains URL | Fetch and strip HTML from URL | Blocks private IPs |
| `web_search` | Prompt mentions search | DuckDuckGo search | Top 3 results |

### Role-Based Tool Access

The role registry defines which tools each role can use:

| Role | Tools | Can Spawn | Mutate Files | Needs Review |
|------|-------|-----------|--------------|--------------|
| `orchestrator` | Glob, Grep, FileRead | Yes | No | No |
| `builder` | Bash, FileRead, FileWrite, Glob, Grep, WebSearch | No | Yes | Yes |
| `reviewer` | FileRead, Glob, Grep | No | No | No |
| `researcher` | WebSearch, FileRead, Glob, Grep | No | No | No |
| `debugger` | Bash, FileRead, Glob, Grep | No | No | Yes |
| `watcher` | FileRead, Glob, Grep | No | No | No |

### Tool Policy (Per-Agent Override)

The `toolPolicy` field on the agent record is a `Record<string, boolean>` that overrides role defaults:

```json
{
  "Bash": true,
  "FileWrite": false,
  "WebSearch": true
}
```

This allows fine-grained control: a builder agent that can't write files, or a researcher that can run bash commands.

### Tool Execution Recording

Every tool call is recorded:
- `ToolCall` database record with: tool name, input summary, output preview, duration, success/failure
- WebSocket events: `agent.tool.start` and `agent.tool.end` pushed to clients
- Visible in admin UI agent activity panel

---

## 5. How Agents Are Orchestrated

### Two Orchestration Layers

**Layer 1: Channel Orchestrator** (API service)

When a message arrives in a channel with multiple bound agents, the channel orchestrator decides who responds:

1. **Fast path**: Explicit `@agent_name` mention routes directly to that agent
2. **Silent path**: If an `@mention` exists but matches no agent, nobody responds
3. **LLM decision**: An invisible orchestrator (cheap LLM call, temperature 0.1, max 128 tokens) analyzes the message against all bound agents and returns:
   - `{ action: "reply", agentId: "..." }` — agent should respond
   - `{ action: "acknowledge", agentId: "...", emoji: "..." }` — agent reacts with emoji
   - `{ action: "none" }` — no agent should respond (default when in doubt)

**Layer 2: Task Orchestrator** (in-memory)

The `Orchestrator` class in `src/agent/Orchestrator.ts` manages the local agent runtime:
- Routes messages to agents based on content analysis
- Manages sub-agent spawning via SpawnManager
- Handles task lifecycle (create, transition, review, approve)
- Decides action type: voice response, keyboard inject, or sub-agent delegation

### Spawn System

Agents can spawn child agents for delegated work:

**Request:**
```typescript
{
  parentTaskId: string | null  // Parent task
  role: TaskRole               // Child's role
  label: string                // Task description
  toolScope: string[]          // Allowed tools for child
  timeoutSeconds: number       // 1-3600
  modelOverride?: string       // Optional model override
}
```

**Constraints:**
- Max spawn depth: 3 levels (no infinite recursion)
- Max children per parent: 5
- Max concurrent spawns: 3
- Timeout: clamped to 1-3600 seconds
- On server restart: orphaned in-progress tasks marked as failed

**Lifecycle:**
```
Parent spawns child → child runs independently → child completes/fails/times out → parent notified via announce callback
```

### Review and Approval Gates

Agents with `requiresReview: true` (builder, debugger) must pass review before their work is accepted:

**Review flow:**
1. Agent completes work → task enters `review` status
2. Reviewer agent evaluates → verdict: `pass` or `fail`
3. Pass → task transitions to `done`
4. Fail → task transitions back to `in_progress` with repair instructions
5. Max 3 repair iterations before escalation to human approval

**Approval flow:**
1. Task enters `awaiting_approval` status
2. Approval request created with reason
3. Human approves → task resumes as `in_progress`
4. Human rejects → task transitions to `cancelled`

---

## 6. What Agents Know About Each Other

### Hierarchy

- Agents have `parentAgentId` — a tree structure
- Child agents can be queried via `loadAgentChildren()`
- The admin UI shows agent trees at any depth
- Spawn depth is enforced (max 3 levels)

### Channel Bindings

- Agents are bound to channels via `AgentBinding` records
- An agent can be bound to multiple channels
- Multiple agents can be bound to one channel (the orchestrator decides who responds)
- Bindings determine which agents are candidates for channel messages

### Visibility Between Agents

- Agents in the same channel can see each other's messages
- The orchestrator knows about all agents in a channel (for routing decisions)
- Sub-agents can see their parent's thread context
- Memory scoping prevents agents from accessing memories they shouldn't see (org/channel/team boundaries)

---

## 7. OpenClaw Mapping

Nessie's agent model maps to OpenClaw's architecture:

| OpenClaw Concept | Nessie Equivalent | Notes |
|---|---|---|
| SOUL.md / instructions | `agent.systemPrompt` | Behavioral definition |
| LLM config | `agent.provider` + `agent.model` | Per-agent model selection |
| Skills directory | Role registry + tool policy | Tools available to agent |
| Memory (Markdown + SQLite) | `thoughts` table with pgvector | Structured memory with embeddings |
| Runtime loop | Run execution pipeline | One run = one loop iteration |
| Gateway routing | Channel orchestrator | LLM-based message routing |
| Session keys | `agent:<agentId>:<channel>:group:<id>` | Via session mapper |
| Webhooks | Task events / approval events | Event-driven lifecycle |
| Cron/scheduling | `ManagedAgent.trigger: 'hourly'` + `intervalMinutes` | Scheduled execution |

The OpenClaw interop layer in `src/openclaw/session-mapper.ts` provides bidirectional mapping between Nessie's task/thread model and OpenClaw's session key format.

---

## 8. Gaps and Limitations (Current State)

### Tool Calling

- **No native tool-calling protocol.** Tools are pre-executed based on keyword detection, not LLM-driven function calls. The agent can't decide to call a tool mid-response or chain tool calls.
- **No tool call arguments from the LLM.** The system extracts tool inputs from the prompt text, not from structured function call parameters.
- **No iterative tool use.** The agent gets one shot — tools run before the LLM call, results are injected, done. No multi-turn tool interaction.

### Agent Autonomy

- **No agentic loop within a run.** The agent can't decide "I need more information" and go get it. It processes what it has and responds.
- **No plan-execute-observe cycle.** The agent doesn't break tasks into steps, execute them, observe results, and adjust. That's delegated to the spawn system (parent spawns children for sub-tasks).
- **No self-correction.** If the agent's response is wrong, a new message from the user is needed. The agent doesn't evaluate its own output.

### Memory Integration

- **Memory retrieval is passive.** Memories are searched and injected before the LLM call. The agent can't actively request memory searches during reasoning.
- **No procedural memory.** Agents don't have access to "how to do this" knowledge.
- **No framing memory.** Agents don't have "where to start" knowledge for domains.
- **No self-eval.** After a run, the agent doesn't evaluate what worked and what didn't.

### Orchestration

- **Keyword-based action routing.** The orchestrator uses string matching ("search", "type this", "spawn") instead of LLM-based intent classification for action decisions.
- **No task decomposition.** The agent doesn't break complex requests into sub-tasks automatically. Spawning is triggered by keywords, not by complexity analysis.
- **No inter-agent communication.** Agents can't message each other directly. Communication is mediated through the channel/thread system.

---

## 9. What the Base Template Must Define

For the omnipotent agent template, every agent — regardless of type — must declare:

### Identity
- `name` — unique, human-readable
- `role` — from the role registry (or custom)
- `systemPrompt` — behavioral instructions, personality, constraints, goal

### Capabilities
- `provider` + `model` — which LLM powers this agent
- `toolPolicy` — which tools it can use (overrides role defaults)
- `canSpawn` — whether it can create child agents
- `canMutateFiles` — whether it can write/delete files
- `requiresReview` — whether its output needs review before acceptance

### Scope
- `organizationId` — hard boundary for all operations
- `projectId` — project-level scope (optional)
- `teamId` — team-level scope (optional)
- Channel bindings — which channels this agent participates in
- `parentAgentId` — position in agent hierarchy

### Memory Access
- Which memory types it can read (semantic, procedural, framing, episodic)
- Which memory types it can write (capture thoughts, create procedures)
- Memory visibility scope (matching its org/project/team/channel access)

### Execution Constraints
- Timeout (max seconds per run)
- Spawn limits (max children, max depth)
- Token budget (max tokens per run — ties into token ledger)
- Trigger type (`main`, `on-demand`, `hourly`)
- Schedule (if trigger = `hourly`, when and how often)

### Security Invariants
- **System prompt immutability** — an agent CANNOT modify its own `systemPrompt`. This field is read-only to the agent that owns it. Only agents with `builder` role and `agent-builder` tool access may modify other agents' prompts, and only via change requests requiring approval. See `the-agents.md` § 11 for the full policy.
- **Tool access is externally granted** — an agent cannot grant itself additional tools or escalate its own permissions
- **Org boundary is absolute** — all operations are scoped by `organizationId` with no bypass mechanism

### Lifecycle Hooks
- On run start: load framing memory, search procedures, load personalization
- On run complete: self-eval, capture memories, update signals
- On run failure: error handling, retry policy
- On spawn: what context to pass to child agents
