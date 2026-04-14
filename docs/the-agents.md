# The Agents

How Nessie agents work today, how they should work, and what needs to change. This is the canonical reference for agent architecture, creation, execution, skills, and the path from single-shot assistant to autonomous planner-executor-critic.

Related documents:
- [agent-base-template.md](agent-base-template.md) — universal agent contract and field definitions
- [multi-agent-memory-system.md](done/multi-agent-memory-system.md) — memory types, retrieval, self-eval
- [agent-communication-spec.md](agent-communication-spec.md) — routing, threads, status model
- [research/evolving-agent-runtime-enterprise-grade.md](research/evolving-agent-runtime-enterprise-grade.md) — enterprise evolution research
- [research/agent-identity-and-channels.md](research/agent-identity-and-channels.md) — external identity, VOIP, email, WhatsApp
- [conversation-intelligence-platform.md § 10](conversation-intelligence-platform.md#10-reference-plugin-implementation--twilio-voice) — Twilio voice connector
- [conversation-intelligence-platform.md](conversation-intelligence-platform.md) — event-driven platform, plugin architecture, trigger system
- [external-tool-integration.md](external-tool-integration.md) — MCP servers, API connectors, remote workers, temporary context, async tools
- [skills.md](skills.md) — skills marketplace, security verification, community catalog
- [marketplace.md](marketplace.md) — unified marketplace, library, agent editor integration

---

## 1. What an Agent Is

An agent is a persistent entity that can perceive its environment, reason about it, take actions through tools, remember what worked, and improve over time. It is not a chatbot. It exists to achieve goals.

Every agent has six properties:

| Property | What It Means | Nessie Implementation |
|---|---|---|
| **Goal** | Why this agent exists | `role` + `systemPrompt` |
| **Perception** | What the agent can see | Messages, conversation history, recalled memories, tool results |
| **Brain** | How it reasons | LLM via `provider` + `model` |
| **Memory** | What it remembers across runs | `thoughts` table (semantic, procedural, framing, reasoning, episodic) |
| **Tools** | What it can do | Role-scoped tools + per-agent `toolPolicy` + skills |
| **Loop** | How it iterates | Run execution cycle (currently single-shot; target: multi-step agentic loop) |

---

## 2. The Agent Object

### Database Record

Every agent is a row in the `agents` table:

```
agents
  id               UUID PK (auto-generated)
  name             TEXT NOT NULL — display name, must be unique within context
  role             TEXT NOT NULL DEFAULT 'assistant' — agent type
  status           ENUM (idle, thinking, executing, waiting_approval, error, offline)
  system_prompt    TEXT — behavioral instructions, personality, constraints
  tool_policy      JSONB — per-tool allow/deny overrides: { "Bash": true, "FileWrite": false }
  provider         TEXT — LLM provider: "openai", "anthropic", etc.
  model            TEXT — LLM model: "gpt-4o", "claude-sonnet-4-5-20250514", etc.
  parent_agent_id  UUID FK → agents — parent in hierarchy (null = root agent)
  active_config_version_id UUID FK → agent_config_versions (nullable) — null until first version is created
  organization_id  UUID — hard org boundary
  project_id       UUID — project scope
  team_id          UUID — team scope
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

**Relations:**
- `parentAgent` / `childAgents[]` — agent hierarchy tree
- `bindings[]` → `agent_bindings` — which channels this agent is bound to
- `categoryLinks[]` → `agent_category_agents` — categorization
- `messages[]` — messages authored by this agent
- `runs[]` — execution records
- `tasks[]` — task assignments
- `approvalRequests[]` — approval requests created by this agent

### Creating an Agent

**Endpoint:** `POST /api/agents`

**Required:** `name`, `role`

**Optional:** `systemPrompt`, `parentAgentId`, `toolPolicy`, `provider`, `model`

Automatic activation is configured through first-class trigger records in § 17, not embedded on the `agents` row.

> While `systemPrompt` is optional, agents without one default to generic assistant behavior. For production agents, `role` + `systemPrompt` define the agent's goal and are strongly recommended.

```json
{
  "name": "Code Reviewer",
  "role": "reviewer",
  "systemPrompt": "You review code changes for correctness, security, and style. Flag issues with severity levels. Never approve code with security vulnerabilities.",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250514",
  "toolPolicy": {
    "FileRead": true,
    "Glob": true,
    "Grep": true,
    "Bash": false
  }
}
```

The service creates the agent record and returns it with a generated UUID. The agent starts in `idle` status. Agents without automatic trigger records remain on-demand until bound to a channel and triggered by a message. Automatic activation is configured separately through `agent_triggers` (see § 17).

### Agent Status Lifecycle

```
idle ──→ thinking ──→ executing ──→ idle (success)
  │         │            │
  │         ├──→ waiting_approval ──→ thinking (approved) / cancelled (rejected)
  │         │
  │         └──→ error (failure)
  │
  └──→ offline (remote worker unreachable)
```

Status transitions are server-authoritative. Every transition emits a WebSocket `agent.status` event within 500ms so the admin UI reflects live state.

### Status and Concurrent Runs

Agent status represents the agent's **most recent activity**, not a global lock. An agent bound to multiple channels may have multiple runs queued or executing simultaneously. Concurrency rules:

- Runs are serialized per-agent by default (one active run at a time, others queued)
- Per-agent concurrency can be configured: `max_concurrent_runs` (default: 1, max: 5)
- When multiple runs are active, agent status reflects the highest-priority activity: `executing` > `thinking` > `waiting_approval` > `idle`
- Each Run has its own independent status lifecycle. Agent status is derived, not authoritative for individual runs.

### Worker Health and Offline Detection

The `offline` status requires active health monitoring:
- Workers send heartbeats every 60 seconds to a `worker_heartbeats` table
- If no heartbeat received for 180 seconds (3 missed heartbeats), the worker is marked `offline`
- All runs assigned to an offline worker are re-queued or marked `failed` based on idempotency
- On reconnect, the worker re-registers and transitions to `idle`
- Stale runs (status = `running` with no heartbeat for 2 minutes) are reaped by a background job
- Remote workers (protocol: "remote" on `mcp_server_instances`) extend the base status set with: idle, busy, draining, offline, revoked. See external-tool-integration.md section 2 for the full `mcp_server_instances` status enum.

### Agent Hierarchy

Agents form trees via `parentAgentId`:

```
Orchestrator (root)
  ├── Builder (child — can mutate files, needs review)
  ├── Researcher (child — web search, read-only)
  └── Reviewer (child — evaluates builder output)
       └── (no children — reviewers don't spawn)
```

Current constraints:
- Max spawn depth: 3 levels
- Max children per parent: 5
- Max concurrent spawns: 3
- Timeout per child: 1–3600 seconds

---

## 3. How an Agent Runs Today (Current State)

A **Run** is one complete execution cycle. It is triggered when a message is routed to an agent.

### The Run Record

```
runs
  id          UUID PK
  agent_id    UUID FK → agents
  thread_id   UUID FK → threads
  status      ENUM (pending, queued, running, completed, failed, cancelled, timed_out)
  started_at  TIMESTAMPTZ
  finished_at TIMESTAMPTZ
  created_at  TIMESTAMPTZ
```

Lifecycle: `pending` (created) → `queued` (enqueued to worker) → `running` (worker processing) → `completed`/`failed`/`cancelled`/`timed_out`

Every run creates a `Task` record (for lifecycle tracking) and zero or more `ToolCall` records (for auditing).

### Current Execution Flow

This is what `worker/src/run/execute.ts` actually does:

```
1. GUARD — Idempotency check: skip if run already completed/failed/cancelled

2. LOAD CONTEXT
   ├── Agent record (id, name, parentAgentId, systemPrompt)
   ├── Channel (id, organizationId)
   ├── Run (id, threadId)
   └── Task (id)

3. LOAD TRIGGER MESSAGE
   └── Use promptOverride if provided, otherwise message.content

4. UPDATE STATUSES
   ├── Run → running
   ├── Task → in_progress
   └── Agent → thinking
   (+ WebSocket events: run.updated, task.updated, agent.status)

5. PRE-EXECUTE TOOLS (keyword detection — not model-driven)
   ├── If prompt matches doc keywords → run document_read
   ├── If prompt contains URL → run web_fetch
   └── If prompt mentions search → run web_search
   (Each tool: set agent→executing, emit tool.start, execute, emit tool.end, set agent→thinking)

6. MAYBE SPAWN CHILD
   └── If prompt contains "spawn"/"delegate"/"sub-agent" AND agent has no parent:
       Create child agent + run + task, enqueue child execution

7. LOAD CONVERSATION
   └── Last 20 messages from thread (ordered by createdAt desc, reversed)

8. RETRIEVE MEMORIES
   └── Hybrid search (semantic + lexical + RRF) scoped to org/channel
       Up to 5 results, each truncated to 220 chars

9. BUILD PROMPT
   ├── System message:
   │   "You are {name}."
   │   + agent.systemPrompt
   │   + "The required safe tools have already been executed."
   │   + "Do not emit tool-call markup or request more tool execution."
   │   + "Return plain text only."
   │   + "Keep the answer concise and concrete."
   ├── Tool results (if any, truncated to 400 chars each)
   ├── Memory context ("Relevant long-term memories: 1. ... 2. ...")
   ├── Conversation history (up to 20 messages)
   └── User message

10. STREAM LLM RESPONSE
    └── modelClient.stream(messages) → SSE deltas to client

11. POST-PROCESS
    ├── Detect which memories were referenced in the response
    ├── Mark recall signals (injected / referenced)
    ├── Save assistant message to database
    └── Emit stream.done + message.new events

12. UPDATE STATUSES
    ├── Run → completed
    ├── Task → done
    └── Agent → idle
    (On error: Run → failed, Task → failed, Agent → error, save error message, emit task event)
```

### What This Gets Right

- **Full auditing**: Every tool call recorded with input/output/duration/success (for the 3 safe tools that actually execute; role-defined tools like Bash/FileWrite are not yet active)
- **Real-time status**: WebSocket events at every state transition
- **Idempotency**: Duplicate run executions are safely skipped
- **Memory integration**: Hybrid search with recall signal tracking
- **Error handling**: Graceful degradation with error messages saved to thread

### What This Gets Wrong

- **Tools are keyword-triggered, not model-driven.** The system decides which tools to run based on string matching. The agent never requests a tool. It can't decide "I need to read a file" mid-reasoning.
- **Single-shot execution.** One pass of tools, one LLM call, done. The agent can't iterate: observe result → reason → call another tool → observe → respond.
- **System prompt forbids tool calling.** The prompt literally says "Do not emit tool-call markup or request more tool execution." This hard-bakes the single-shot pattern.
- **Three hardcoded tools.** `document_read`, `web_fetch`, `web_search`. The role registry defines six tool sets (Bash, FileRead, FileWrite, Glob, Grep, WebSearch) but the worker only executes three safe tools.
- **Spawn is keyword-based.** If the prompt contains "spawn" or "delegate", a child is created. No intent analysis, no task decomposition, no plan.
- **No self-correction.** If the response is wrong, a new human message is needed.
- **No planning.** Complex tasks get single-shot responses instead of decomposed steps.
- **No evaluation.** The agent doesn't know if it succeeded.
- **Memory recall is truncated aggressively.** 5 results at 220 chars each = 1100 chars of memory context. Useful memories get cut to fragments.
- **Agent cannot act on memory.** The system prompt says "Do not emit tool-call markup." This means recalled memories inform the response text but cannot trigger new tool calls. The agent summarizes memories; it does not act on them. This is the single biggest architectural limitation — memory-informed action requires the agentic loop (Phase 1).

---

## 4. How an Agent Should Run (Target State)

### The Agentic Loop

Replace the single-shot flow with an iterative loop where the model drives tool use:

```
Message arrives
  │
  ├── 1. ROUTE — Channel orchestrator picks the agent (LLM-based, not keyword)
  │
  ├── 2. PLAN (optional, for complex tasks)
  │     └── Agent generates Plan + PlanSteps as structured output
  │         Steps may include: tool_call, spawn_task, code_change, wait, approval_required
  │
  ├── 3. EXECUTE (agentic loop — the core change)
  │     ┌─────────────────────────────────────────────┐
  │     │  for i in 0..MAX_ITERATIONS:                │
  │     │    response = model.chat(messages, tools)    │
  │     │                                              │
  │     │    if response.type == 'final':              │
  │     │      break  // agent is done                 │
  │     │                                              │
  │     │    if response.type == 'tool_call':          │
  │     │      enforce policy (role + toolPolicy)      │
  │     │      execute tool (native or sandboxed)      │
  │     │      record ToolCall                         │
  │     │      push tool result into messages          │
  │     │      continue                                │
  │     │                                              │
  │     │    if budget exhausted (iterations/time/cost):│
  │     │      break with partial result               │
  │     └─────────────────────────────────────────────┘
  │
  ├── 4. EVALUATE (critic)
  │     ├── Fast critic: run tests, check policy, validate output
  │     └── Semantic critic (optional): LLM review of response quality
  │
  ├── 5. REFLECT (on failure)
  │     ├── Generate root cause analysis
  │     ├── Propose fix
  │     └── Retry within budget OR escalate to approval gate
  │
  └── 6. CONSOLIDATE
        ├── Self-eval: what helped, what didn't, what's missing
        ├── Capture procedural memory (if multi-step task succeeded)
        ├── Update framing memory (if domain exploration occurred)
        └── Update recall signals
```

### What Changes in the Worker

**Remove:**
- Keyword-based tool detection (`shouldUseDocumentRead`, `shouldUseWebFetch`, `shouldUseWebSearch`)
- The "tools have already been executed" system prompt instruction
- The "do not emit tool-call markup" instruction

**Add:**
- Tool schema injection into model requests (native function/tool calling)
- Iterative loop with budget caps (max iterations, max wallclock, max cost)
- Policy enforcement before each tool execution
- Tool result persistence and message threading
- Budget tracking (iterations used, tokens consumed, wallclock elapsed)

**Keep:**
- Tool call auditing (ToolCall records with input/output/duration)
- WebSocket events (agent.tool.start, agent.tool.end)
- Status transitions (thinking ↔ executing)
- Memory retrieval and recall signal tracking
- Idempotency guard

### Budget Controls

Every run has hard limits:

```json
{
  "maxIterations": 12,
  "maxWallclockMs": 90000,
  "maxToolCalls": 20,
  "maxTokens": 50000,
  "maxCostCents": 50
}
```

Defaults come from role policy. Overridable per agent, per plan, per task.

---

## 5. Roles

Roles define what an agent can do. Every agent has a role that maps to a policy.

### Current Roles

| Role | Tools | Can Spawn | Mutate Files | Needs Review |
|------|-------|-----------|--------------|--------------|
| `orchestrator` | Glob, Grep, FileRead | Yes | No | No |
| `builder` | Bash, FileRead, FileWrite, Glob, Grep, WebSearch | No | Yes | Yes |
| `reviewer` | FileRead, Glob, Grep | No | No | No |
| `researcher` | WebSearch, FileRead, Glob, Grep | No | No | No |
| `debugger` | Bash, FileRead, Glob, Grep | No | No | Yes |
| `watcher` | FileRead, Glob, Grep | No | No | No |

### Role Policy Structure

```typescript
interface RolePolicy {
  role: TaskRole
  allowedTools: string[]
  canSpawn: boolean
  canMutateFiles: boolean
  requiresReview: boolean
}
```

The role determines the baseline. The agent's `toolPolicy` JSON overrides specific tools:

```json
// Agent record: a researcher that can also run bash
{
  "role": "researcher",
  "toolPolicy": { "Bash": true }
}
```

Policy enforcement happens at the tool gateway — before every tool execution, the system checks:
1. Is this tool in the role's `allowedTools`?
2. Does the agent's `toolPolicy` override it?
3. Is the tool's risk level acceptable for this context?

### Tool Policy Override Semantics

`toolPolicy` entries have three possible states:
- `true` — explicitly allowed (overrides role denial)
- `false` — explicitly denied (overrides role allowance)
- absent — inherits from role policy

Override rules:
1. Role `allowedTools` establishes the baseline
2. `toolPolicy` entries override the baseline per tool
3. `toolPolicy` CANNOT override risk gates — a tool classified as `critical` still requires approval regardless of policy
4. Only humans or agents with `agent-builder` access can set `toolPolicy` overrides
5. Every override is logged in the audit trail with `set_by`, `reason`, and `expires_at`

Future: Replace boolean map with structured policy entries: `{ tool: string, state: 'allowed' | 'denied' | 'inherit', risk_cap: string, set_by: UUID, reason: string, expires_at?: DateTime }`

### Future Roles

As the skill system grows, roles become less about hardcoded tool lists and more about capability profiles. A role is a default policy; skills and tool registry entries extend capabilities dynamically.

---

## 6. Orchestration

### Channel Orchestrator

When a message arrives in a channel, the channel orchestrator decides which agent (if any) responds.

**Current implementation** (`api/src/services/orchestrator.ts`):

1. **Fast path**: Explicit `@AgentName` mention → route directly to that agent
2. **Silent path**: `@mention` exists but matches no agent → nobody responds
3. **LLM decision**: Invisible orchestrator (cheap model, temperature 0.1, max 128 tokens) evaluates the message against all bound agents and returns one of:
   - `{ action: "reply", agentId }` — agent should respond
   - `{ action: "acknowledge", agentId, emoji }` — agent reacts with emoji
   - `{ action: "none" }` — no agent engages (default when in doubt)

**What needs to change**: The channel orchestrator works. It should also factor in:
- Agent current status (don't route to a busy agent if another can handle it)
- Budget/cost awareness (route to cheaper model agents for simple tasks)
- Skill matching (which agent has the right skills for this request)
- Plan context (if there's an active plan, route to the assigned agent)

### Task Orchestrator

The task system manages work allocation and lifecycle:

```
tasks
  id              UUID PK
  run_id          UUID FK → runs (nullable)
  agent_id        UUID FK → agents
  parent_task_id  UUID FK → tasks (self-referential, for hierarchical spawning)
  status          ENUM (inbox, assigned, in_progress, review, done, failed, cancelled, awaiting_approval)
  purpose         TEXT
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
```

**Task status transitions:**
```
inbox → assigned → in_progress → review → done
                       │            │
                       ├→ failed    ├→ in_progress (repair)
                       ├→ cancelled │
                       └→ awaiting_approval → in_progress (approved) / cancelled (rejected)
```

### Review and Approval Gates

Agents with `requiresReview: true` must pass review:

1. Agent completes work → task enters `review` status
2. Reviewer evaluates → verdict: `pass` or `fail`
3. Pass → `done`
4. Fail → back to `in_progress` with repair instructions
5. Max 3 repair iterations before escalation to human approval

Approval gate:
1. Task enters `awaiting_approval`
2. Human approves → resumes as `in_progress`
3. Human rejects → `cancelled`

---

## 7. Skills

Skills are reusable capabilities that extend what an agent can do. They are separate from tools — a tool is a single action (read file, run bash), while a skill is a packaged behaviour (deploy to staging, review PR, analyze performance).

### What a Skill Is

A skill combines:
- **Instructions** — how to use the skill (like a runbook)
- **Required tools** — which tools the skill needs
- **Input schema** — what parameters the skill accepts
- **Plan template** (optional) — a predefined sequence of steps
- **Tests** — how to validate the skill worked
- **Success metrics** — historical performance data

### Skill Structure

```json
{
  "id": "uuid",
  "name": "deploy-to-staging",
  "description": "Deploy the current branch to the staging environment",
  "version": 1,
  "status": "approved",

  "instructions": "1. Run tests. 2. Build docker image. 3. Push to registry. 4. Update Cloud Run service. 5. Verify health endpoint.",

  "requiredTools": ["Bash", "WebFetch"],
  "inputSchema": {
    "type": "object",
    "properties": {
      "branch": { "type": "string", "default": "main" },
      "environment": { "type": "string", "enum": ["staging", "preview"] }
    }
  },

  "planTemplate": [
    { "order": 1, "type": "tool_call", "tool": "Bash", "description": "Run test suite" },
    { "order": 2, "type": "tool_call", "tool": "Bash", "description": "Build and push Docker image" },
    { "order": 3, "type": "tool_call", "tool": "Bash", "description": "Deploy to Cloud Run" },
    { "order": 4, "type": "tool_call", "tool": "WebFetch", "description": "Verify health endpoint" }
  ],

  "tests": [
    { "type": "health_check", "url": "{environment}.example.com/health" }
  ],

  "visibility": "private",
  "authorId": "user-uuid",
  "organizationId": "org-uuid",

  "stats": {
    "successCount": 12,
    "failureCount": 1,
    "averageDurationSeconds": 180,
    "lastUsedAt": "2026-04-09T..."
  }
}
```

### Skill Visibility

Two types of skills: **private** and **public**.

#### Private Skills

- Created by a user or agent
- Owned by the author
- Only the author can use them directly
- **Partial sharing**: The author can include a private skill in any channel, project, or team they belong to. Once included, the skill becomes available to all agents and users within that scope — but only within that scope.

```
Author creates private skill "deploy-to-staging"
  │
  ├── Author uses it directly in any channel they're in → works
  │
  ├── Author includes it in #engineering channel
  │   └── All agents/users in #engineering can use it
  │
  ├── Author includes it in "Backend" project
  │   └── All agents/users in the Backend project can use it
  │
  └── Someone outside those scopes tries to use it → denied
```

The key rule: **including a private skill in a scope makes it visible to that scope, but it never leaks beyond it.** A skill included in the `#engineering` channel is not visible in `#marketing`. A skill included in the "Backend" project is not visible in the "Frontend" project.

This mirrors the memory scoping model: audience compatibility, not container inheritance.

#### Public Skills

- Available to everyone in the organization
- Published through a promotion pipeline: draft → tested → approved → public
- Must pass quality gates before promotion (tests, review, security scan)
- Can be deprecated but not deleted (existing references need graceful handling)
- Organization-scoped — "public" means within the org, not globally

#### Skill Scoping Rules

| Skill Visibility | Who Can Use It | How It Spreads |
|---|---|---|
| Private (unshared) | Author only | Doesn't spread |
| Private (shared to channel) | Author + all channel members | Bound to specific channel(s) |
| Private (shared to project) | Author + all project members | Bound to specific project(s) |
| Private (shared to team) | Author + all team members | Bound to specific team(s) |
| Public | Everyone in the organization | Org-wide |

#### Skill Inclusion Model

```
skill_grants
  id          UUID PK
  skill_id    UUID FK → skills
  scope_type  ENUM (system, channel, project, team, organization, user)
  scope_id    UUID — null only for system-scoped grants
  granted_by  UUID FK → users — who included it
  created_at  TIMESTAMPTZ
```

`skill_grants` is the skill-specific compatibility view over the shared `resource_scope_bindings` model: it makes a skill visible within system, organization, project, team, channel, or user scopes. A skill's private ownership is represented by its home scope; grants add additional visibility. `capability_assignments` is the canonical assignment table for agent/role assignment, and any `skill_assignments` table is skill-specific extension data rather than a separate source of truth.

When an agent searches for available skills, the query checks:
1. Skills owned by the requesting user/agent (private, always visible)
2. Skills granted to the current channel
3. Skills granted to the current project
4. Skills granted to the current team
5. Public skills in the organization

This is a union, not a hierarchy. A skill granted to a channel doesn't automatically appear in the channel's project.

### How Skills Connect to the Agent Loop

Skills are injected into the agent's context the same way OpenClaw injects skills — as a compact index:

```
Available skills:
- deploy-to-staging: Deploy current branch to staging (requires: Bash, WebFetch)
- review-pr: Review a GitHub PR for issues (requires: FileRead, Grep, WebSearch)
- analyze-perf: Profile and analyze performance regressions (requires: Bash, FileRead, Grep)
```

The agent sees the list. When it decides to use a skill, it loads the full skill definition (instructions + plan template + input schema) and follows it. This keeps the base prompt small — skill metadata is always present, full skill content is loaded on demand.

### Skills vs Procedural Memory

These are related but distinct:

| | Procedural Memory | Skill |
|---|---|---|
| **Origin** | Auto-captured from successful runs via self-eval | Authored by a user/agent, or promoted from procedural memory |
| **Quality** | Unreviewed, confidence-scored | Tested, reviewed, approved |
| **Structure** | Loose steps in JSONB metadata | Full definition: schema, instructions, plan template, tests |
| **Lifecycle** | Confidence decays/grows with use | Versioned, promoted, deprecated |
| **Visibility** | Scoped like any thought (org/project/channel) | Explicit grant model (private + shared + public) |
| **Retrieval** | Trigger condition matching via embedding | Indexed by name/tags + embedding similarity |

The pipeline: **successful run → self-eval captures procedural memory → human/agent promotes to candidate skill → tests pass → skill approved → available to agents.**

Procedural memory is the raw material. Skills are the refined product.

### Skill Schema (Database)

```
skills
  id               UUID PK
  name             TEXT UNIQUE (within org)
  description      TEXT
  version          INT
  status           ENUM (draft, testing, pending_review, approved, deprecated, archived)
  visibility       ENUM (private, shared, public)
  active_version_id UUID FK → skill_versions

  instructions     TEXT — how to use it
  input_schema     JSONB — JSON Schema for parameters
  plan_template    JSONB — optional ordered steps
  required_tools   TEXT[] — tools needed
  tests            JSONB — validation definitions
  tags             TEXT[] — for search/categorization

  author_id        UUID FK → users
  organization_id  UUID FK → organizations
  project_id       UUID FK → projects (optional)

  success_count    INT DEFAULT 0
  failure_count    INT DEFAULT 0
  avg_duration_s   FLOAT
  last_used_at     TIMESTAMPTZ

  source_thought_id UUID FK → thoughts (optional — if promoted from procedural memory)

  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

```
skill_versions
  id               UUID PK
  skill_id         UUID FK → skills
  version          INT
  instructions     TEXT
  input_schema     JSONB
  plan_template    JSONB
  required_tools   TEXT[]
  tests            JSONB
  status           ENUM (draft, pending_review, approved, rejected, deprecated)
  checksum         TEXT — integrity hash
  approved_by      UUID FK → users
  approved_at      TIMESTAMPTZ
  created_at       TIMESTAMPTZ

  @@unique([skill_id, version])
```

```
skill_grants
  id               UUID PK
  skill_id         UUID FK → skills
  scope_type       ENUM (system, channel, project, team, organization, user)
  scope_id         UUID — null only for system-scoped grants
  granted_by       UUID FK → users
  created_at       TIMESTAMPTZ

  @@unique([skill_id, scope_type, scope_id])
```

### Skill Lifecycle State Machine

```
draft → testing → pending_review → approved → deprecated → archived
                       │                          │
                       └→ rejected → draft         └→ archived
```

- `draft`: Initial creation, editable, not executable by others
- `testing`: Author or system running validation tests
- `pending_review`: Tests passed, awaiting human/agent review
- `approved`: Active and available per visibility rules
- `rejected`: Review failed, returns to draft for revision
- `deprecated`: Superseded, still executable but not recommended
- `archived`: Removed from all queries, retained for audit

Visibility is separate from status:
- `visibility`: `private | shared | public`
- A skill can be `approved` + `private` (only author uses it)
- A skill can be `approved` + `shared` (scoped via `skill_grants`)
- A skill can be `approved` + `public` (org-wide)

Active version tracking:
- `skills.active_version_id` → points to the current `skill_versions` row
- Old versions are immutable and retained
- Rollback = change `active_version_id` to a previous version

### Skill Deletion

Skills are never physically deleted. Lifecycle:
- **Private unused**: Can be `archived` immediately
- **Shared/public**: Must be `deprecated` first, then `archived` after a grace period
- **Referenced by plans/runs**: Cannot be archived until all references are to `skill_versions` (immutable), not the live skill
- Tombstoning: Archived skills return a clear "skill archived" message if referenced, not a 404

### Skill Promotion Pipeline

The path from procedural memory to approved skill:

```
Successful run
  │
  ├── 1. Self-eval identifies reusable procedure
  │     Output: procedural memory candidate
  │
  ├── 2. Store as thought (memory_type = 'procedure', review_status = 'unreviewed')
  │
  ├── 3. Promotion trigger (manual or automatic when procedure.success_count >= threshold)
  │     Creates: SkillCandidate record
  │
  ├── 4. Convert procedure to skill draft
  │     Map: trigger_conditions → inputSchema
  │     Map: steps → instructions + planTemplate
  │     Map: tools_used → requiredTools
  │     Generate: tests from success/failure history
  │
  ├── 5. Run generated tests in sandbox
  │     If fail → return to draft with failure notes
  │
  ├── 6. Submit for review (status: pending_review)
  │     Reviewer checks: correctness, safety, scope, tool requirements
  │
  ├── 7. Approve → skill becomes active
  │     Set: active_version_id, visibility based on scope
  │     Link: source_thought_id → original procedure
  │
  └── 8. Ongoing: If source procedure later fails, flag linked skill for re-review
```

The self-evaluation loop that captures procedural memory is specified in multi-agent-memory-system.md section Self-Evaluation Loop.

Required for promotion:
- Minimum 3 successful uses of the source procedure
- Procedure confidence ≥ 0.7
- All required tools available in the target scope
- No critical-risk tools unless explicitly approved
- Security scan passes (no raw credentials, no unbounded external calls)

---

## 8. Inter-Agent Communication

Currently agents can't talk to each other directly. Communication is mediated through the channel/thread system — agents post messages that other agents might see.

### What's Needed: Agent Mailbox

A DB-backed message bus with delivery guarantees:

```
agent_mailbox
  id               UUID PK
  from_agent_id    UUID FK → agents (nullable — system messages have no sender)
  to_agent_id      UUID FK → agents
  thread_id        UUID FK → threads (optional)
  plan_id          UUID (optional — for plan-driven coordination)
  step_id          UUID (optional)
  correlation_id   UUID (for request/response pairing)
  channel_id       UUID FK → channels (nullable — set for broadcast, null for direct)

  kind             TEXT — "request", "result", "event", "handoff"
  content          TEXT
  metadata         JSONB

  status           ENUM (queued, delivered, processed, failed)
  created_at       TIMESTAMPTZ
  delivered_at     TIMESTAMPTZ
  processed_at     TIMESTAMPTZ
```

### Delivery Guarantees

The mailbox provides **at-least-once delivery** with idempotency:

- **Idempotency**: Every message has a `correlation_id`. Duplicate sends with the same correlation ID are silently dropped.
- **Visibility timeout**: A message transitions from `queued` → `delivered` when the recipient agent starts processing. If not `processed` within 60 seconds, it returns to `queued` for retry.
- **Retry policy**: Max 3 retries with exponential backoff (10s, 30s, 60s). After 3 failures → `failed` status.
- **Dead-letter queue**: Failed messages after all retries are moved to `agent_mailbox_dlq` for manual inspection.
- **Ordering**: Messages within a single `plan_id` + `step_id` are ordered. Cross-plan messages are unordered.
- **Offline recipients**: Messages queue indefinitely. When the agent comes online, it drains its mailbox in order.
- **Broadcast**: `to_agent_id = NULL` + `channel_id` set → fan-out to all agents bound to that channel. Each gets their own mailbox entry.
- **Transactional coupling**: Plan step transitions and mailbox writes happen in the same DB transaction.

### Communication Patterns

**Parent → Child (delegation):**
```
Parent creates PlanStep with type: spawn_task
  → SpawnManager creates child agent + task
  → Child executes independently
  → Child sends result via mailbox (kind: "result")
  → Parent's plan step updates with output
```

**Agent → Agent (handoff):**
```
Builder finishes code → sends to Reviewer (kind: "handoff")
  → Reviewer evaluates → sends verdict back (kind: "result")
  → Builder receives repair instructions or completion signal
```

**Orchestrator → Agent (assignment):**
```
Orchestrator receives complex request
  → Creates plan with steps assigned to different agents
  → Sends assignment messages (kind: "request") to each
  → Agents execute and report back
```

**Broadcast (status):**
```
Agent completes significant milestone
  → Sends event message to all agents in the channel (kind: "event")
  → Other agents update their context
```

### Scope Enforcement

Mailbox messages respect the same boundaries as everything else:
- Agents can only message agents in the same organization
- Channel-scoped messages check channel membership
- Tool policy enforces who can message whom

---

## 9. Plans

Plans make complex tasks inspectable and executable. Instead of hoping the agent handles a multi-step task in one shot, the system decomposes goals into explicit steps.

### Plan Structure

```
plans
  id               UUID PK
  organization_id  UUID
  project_id       UUID
  owner_agent_id   UUID FK → agents
  thread_id        UUID FK → threads
  goal             TEXT
  status           ENUM (draft, active, blocked, completed, failed, cancelled)
  budget           JSONB — { maxTokens, maxCostCents, maxWallclockMs, maxToolCalls }
  current_step_id  UUID
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

```
plan_steps
  id               UUID PK
  plan_id          UUID FK → plans
  order            INT
  type             ENUM (tool_call, spawn_task, code_change, message, wait, approval_required, human_input)
  description      TEXT
  status           ENUM (pending, running, done, failed, skipped, blocked, awaiting_approval, cancelled, timed_out)

  assigned_agent_id UUID FK → agents
  run_id           UUID FK → runs (populated when step executes)
  task_id          UUID FK → tasks (populated when step spawns)

  tool_name        TEXT (if type = tool_call)
  tool_args        JSONB
  depends_on       UUID[] — step IDs that must complete first

  acceptance       JSONB — criteria for "done"
  input            JSONB
  output           JSONB

  started_at       TIMESTAMPTZ
  completed_at     TIMESTAMPTZ

  @@unique([plan_id, order])
```

### How Plans Execute

1. Agent receives a complex task
2. Planner (could be the agent itself or a dedicated planning agent) generates a plan with ordered steps
3. Orchestrator walks the plan:
   - Execute steps in order (respecting dependencies)
   - For `spawn_task` steps: use the existing spawn system
   - For `tool_call` steps: execute within the agentic loop
   - For `approval_required` steps: pause and create an approval request
4. After all steps: run critic/evaluation
5. On failure: generate reflection, retry within budget, or escalate

Plans connect to skills: if a skill has a `planTemplate`, it becomes the starting point for the plan. The agent can modify the template based on context.

### Plan Failure Recovery

Plans are not transactions — they can partially complete. Recovery semantics:

**Step classification by side effects:**
- `pure`: No external effects (analysis, search). Safe to retry or skip.
- `idempotent`: External effects but repeatable (deploy with same config). Safe to retry.
- `mutating`: Non-repeatable external effects (send email, delete resource). Requires compensation step.

**Recovery rules:**
1. Step fails → check retry policy (default: 2 retries for `pure`/`idempotent`, 0 for `mutating`)
2. Retries exhausted → check if step has a `compensation_step_id`
3. If compensation exists → execute it (rollback partial work)
4. If no compensation → mark step `failed`, check plan policy:
   - `fail_fast`: Cancel all remaining steps, mark plan `failed`
   - `continue_on_failure`: Skip dependent steps, continue independent ones
   - `pause_for_human`: Mark plan `blocked`, create approval request
5. On worker crash (step `running` with no heartbeat for 2 minutes):
   - Reaper marks step `failed`
   - Plan applies recovery rules above

**Artifact tracking:**
- Each step that produces artifacts (files created/modified, resources provisioned) records them in `step.output.artifacts[]`
- Compensation steps use the artifact list to know what to undo
- Format: `{ type: "file_created" | "file_modified" | "resource_created", ref: string, rollback_data?: string }`

**Plan resume:**
- A `failed` or `blocked` plan can be resumed: skips completed steps, retries or replaces failed steps
- Resume creates a new plan version linked to the original

---

## 10. Evaluation and Self-Correction

### Critic Loop

After execution, every significant run goes through evaluation:

```
evaluations
  id               UUID PK
  kind             ENUM (policy_check, unit_test, integration_test, critic_llm, human_review, self_eval, reflection)
  passed           BOOLEAN
  score            FLOAT (0.0–1.0)
  feedback         TEXT
  metrics          JSONB

  plan_id          UUID (if plan-driven)
  step_id          UUID
  run_id           UUID
  task_id          UUID
  evaluator_agent_id UUID

  created_at       TIMESTAMPTZ
```

### Two Critics

1. **Fast policy critic** (deterministic): Run tests, check output format, validate against acceptance criteria, enforce policies. No LLM call needed.

2. **Semantic critic** (LLM-based): Does the output actually solve the problem? Is the reasoning sound? Are there edge cases missed? Uses a cheap model.

### Self-Correction Flow

```
Execution completes
  │
  ├── Fast critic runs
  │   ├── Pass → proceed to consolidation
  │   └── Fail → generate repair directive
  │
  ├── Semantic critic runs (optional, for complex tasks)
  │   ├── Pass → proceed to consolidation
  │   └── Fail → generate repair directive
  │
  └── On failure:
      ├── If retries remaining within budget:
      │   └── Feed repair directive back into agentic loop
      └── If budget exhausted:
          └── Escalate to approval gate or report partial result
```

### Reflection (stored self-analysis)

```json
{
  "run_id": "...",
  "root_cause": "Connection pool query returned incorrect count because the WHERE clause didn't filter by status",
  "proposed_fix": "Add WHERE state = 'active' to the pg_stat_activity query",
  "applied": true,
  "confidence": 0.85,
  "impact": "Fixed incorrect diagnostic output that was misleading the debugging procedure"
}
```

Reflections are stored and linked to procedural memories — when the same type of failure recurs, the agent retrieves the reflection and avoids the mistake.

### Unified Run Evaluation

The critic loop, self-eval, and reflection produce different outputs that must flow into a single evaluation record. After every significant run:

```
Run completes
  │
  ├── 1. Fast critic → evaluations row (kind: policy_check)
  │     Output: passed, score, feedback
  │
  ├── 2. Semantic critic → evaluations row (kind: critic_llm)
  │     Output: passed, score, feedback, metrics
  │
  ├── 3. Self-eval (memory) → evaluations row (kind: self_eval)
  │     Output: used_memories, missing_memories, new_procedural, framing_update
  │     Stored in: evaluations.metrics JSONB
  │
  └── 4. Reflection (on failure) → evaluations row (kind: reflection)
        Output: root_cause, proposed_fix, applied, confidence
        Stored in: evaluations.metrics JSONB
```

All four evaluation types share the `evaluations` table. The `kind` field discriminates. The `metrics` JSONB holds type-specific structured data. This means:
- `task_success` comes from the critic (deterministic), not self-eval (model opinion)
- Self-eval `used_memories[].thought_id` must reference actual `thought_recalls` rows
- Reflection only runs if a critic failed
- Missing memories from self-eval are stored as `evaluations.metrics.missing_memories` and processed by the capture pipeline

---

## 11. Security Invariants

Hard rules that apply to all agents regardless of role, scope, or capabilities.

### System Prompt Immutability

**An agent CANNOT modify its own system prompt.** This is a non-negotiable invariant.

The `system_prompt` field defines who an agent is — its purpose, personality, constraints, and behavioral boundaries. Allowing self-modification of this field would let an agent rewrite its own constraints, remove safety guardrails, or drift from its intended purpose. This is the AI equivalent of letting a process overwrite its own access control list.

**Rules:**
1. No agent may read or write its own `system_prompt` field through any tool or API call
2. No agent may instruct another agent to modify the first agent's `system_prompt`
3. The `system_prompt` column must be excluded from all agent-accessible write operations at the API level — this is enforced in code, not by policy

**Exception — Agent Builder Role:**
Agents with the explicit `builder` role and `agent-builder` tool access may modify **other** agents' system prompts — never their own. Even then:
- Changes go through a **change request** (not direct writes)
- Change requests require approval from a human or a designated reviewer agent
- The change request captures: what changed, why, who requested it, who approved it
- A full diff of the old vs new prompt is stored in the audit log
- Rollback is always possible (prompt versioning)

```
agent_prompt_changes
  id               UUID PK
  agent_id         UUID FK → agents — the agent being modified
  requested_by     UUID FK → agents — the builder agent
  approved_by      UUID — agent or user who approved
  old_prompt       TEXT
  new_prompt       TEXT
  reason           TEXT
  status           ENUM (pending, approved, rejected, applied, rolled_back)
  created_at       TIMESTAMPTZ
  applied_at       TIMESTAMPTZ
```

### Tool Access Scoping

- Agents can only use tools granted by their role + `toolPolicy` overrides
- No agent can grant itself additional tool access
- Tool access changes require the same change-request flow as prompt changes
- The `agent-builder` tool is never auto-granted — it requires explicit human assignment

### Org Boundary Enforcement

- All queries are scoped by `organization_id` — no exceptions, no admin bypass
- An agent cannot access data, memories, threads, or other agents outside its org
- Cross-org communication requires an explicit bridge mechanism (not yet designed)

---

## 12. What We Have vs What We Need

### Have (Working)

| Component | Location | Runtime | Notes |
|---|---|---|---|
| Agent CRUD + hierarchy | `api/src/services/agents.ts` | API/Worker | Full lifecycle |
| Agent status model | Prisma schema + WebSocket events | API/Worker | 6 states, real-time push |
| Run execution | `worker/src/run/execute.ts` | API/Worker | Single-shot, keyword tools |
| 3 safe tools | `worker/src/run/tools.ts` | API/Worker | document_read, web_fetch, web_search |
| Role registry | `src/orchestration/role-registry.ts` | Legacy (src/) | 6 roles with tool policies |
| Spawn system | `src/orchestration/spawn-manager.ts` | Legacy (src/) | Depth/children/concurrency limits |
| Review gates | `src/orchestration/verification.ts` | Legacy (src/) | Pass/fail with repair iterations |
| Approval gates | `src/orchestration/approvals.ts` | Legacy (src/) | Human approve/reject |
| Channel orchestrator | `api/src/services/orchestrator.ts` | API/Worker | LLM-based agent routing |
| Task ledger | `src/orchestration/task-ledger.ts` | Legacy (src/) | 8-state lifecycle |
| Memory retrieval | `packages/memory/` | API/Worker | Hybrid search, recall ledger |
| Tool call auditing | ToolCall table + WebSocket events | API/Worker | Full audit trail |
| Watcher/monitoring | `src/orchestration/watcher.ts` | Legacy (src/) | Stale task, loop, runaway detection |

Components marked `Legacy (src/)` exist in the local orchestrator but are NOT active in the deployed API/worker architecture. They must be re-implemented in `api/` or `worker/` before they are considered production-ready.

### Need (Not Started)

| Component | Priority | Depends On | Notes |
|---|---|---|---|
| **Native tool calling + agentic loop** | Critical | — | Replace keyword tools with model-driven loop |
| **Plan model** (Plan + PlanStep) | Critical | Agentic loop | Structured task decomposition |
| **Schema-validated router** | High | — | Replace keyword action routing |
| **Skill system** (Skill + SkillVersion + SkillGrant) | High | Agentic loop | Private/public skills with scoped grants |
| **Inter-agent mailbox** | High | Plans | Agent-to-agent communication |
| **Evaluation/Critic loop** | High | Agentic loop | Post-execution quality checks |
| **Reflection storage** | Medium | Evaluation | Stored self-analysis for learning |
| **Tool Registry** (ToolDefinition + ToolVersion) | Medium | Agentic loop | Versioned, approved, risk-classified tools |
| **Self-eval step** | Medium | Evaluation | Active feedback for memory improvement |
| **Procedural memory capture** | Medium | Self-eval | Auto-capture reusable procedures |
| **Framing memory capture** | Medium | Self-eval | Cold-start elimination |
| **Sandboxed execution** | Medium | Tool Registry | Isolation for generated/third-party code |
| **Budget enforcement** | Medium | Agentic loop | Token/cost/time/iteration caps |
| **Skill promotion pipeline** | Low | Skills + procedural memory | Promote memories to tested skills |
| **Agent versioning (AgentConfigVersion)** | Medium | Agent builder | Immutable config history, rollback |
| **Agent builder skill/workflow** | High | Skills + Tool Registry | Structured intake → deterministic agent creation |
| **Agent discovery registry** | Medium | Skills | Capability index, cross-channel/project search |
| **Cost ledger** | High | Agentic loop | Per-agent/run/plan/step token and dollar accounting |
| **Rate limiting + backpressure** | High | Agentic loop | Queue, worker leases, provider rate adaptation |
| **Worker heartbeat + health** | High | — | Stale run detection, offline transitions |
| **Trigger scheduler service** | High | Agentic loop | Cron, interval, webhook, event-driven agent activation (§ 17) |
| **Webhook ingest endpoint** | High | Trigger scheduler | External systems fire agents via signed HTTP |
| **Event bus + subscriptions** | High | Trigger scheduler | Internal events trigger agents reactively |
| **Concurrent resource locks** | Medium | Plans | File/workspace locks, conflict detection |
| **Personalization memory** | Future | — | User communication model |
| **Local-first filtering** | Future | — | On-device memory extraction |

### Implementation Order

```
Phase 1: Native tool calling + agentic loop
  └── This unblocks everything. Without it, nothing else works.

Phase 2: Plans + schema-validated router + budget enforcement
  └── Structured decomposition, typed routing decisions, cost tracking.

Phase 3: Evaluation + critic + reflection
  └── Quality gates, self-correction, learning. Must exist before skills.

Phase 4: Tool Registry + sandbox + security gates
  └── Versioned tools, safe execution. MUST precede agent-authored skills.

Phase 5: Skills + inter-agent mailbox
  └── Reusable capabilities, agent coordination. Built on safe execution substrate.

Phase 6: Memory integration (procedural, framing, self-eval)
  └── System improves itself over time.

Phase 7: Agent builder + self-modification
  └── Agents creating agents, change requests, versioned configs.

Phase 8: Enterprise hardening
  └── SOC2/GDPR controls, secrets, retention, audit.
```

Each phase produces something usable. No phase is pure infrastructure.

---

## 13. OpenClaw Alignment

Nessie integrates with OpenClaw at the gateway level. The agent model maps cleanly:

| OpenClaw | Nessie | Notes |
|---|---|---|
| SOUL.md | `agent.systemPrompt` | Behavioral definition |
| AGENTS.md | Role registry + tool policy | Capability constraints |
| Skills (SKILL.md) | `skills` table | Both use compact index + on-demand load |
| Tools (typed functions) | Tool Registry (target) | OpenClaw: model sees tool schemas; we need the same |
| Agent loop | Run execution (target: agentic loop) | OpenClaw: interleaved model+tool; we need the same |
| Gateway routing | Channel orchestrator | Both use per-agent routing decisions |
| Session keys | `agent:<id>:<channel>:group:<id>` | Via `src/openclaw/session-mapper.ts` |
| Workspace memory | `thoughts` table with pgvector | We have richer memory; OpenClaw uses Markdown+SQLite |
| Per-agent sandbox/tool policy | Role registry + toolPolicy | Both scope tools per agent |

**Where to adopt OpenClaw patterns:**
- Tools as typed, schematized functions that the model calls natively
- Skills as compact metadata lists with on-demand full load
- Serialized agent loop with lifecycle events

**Where to diverge:**
- Our memory system is far richer (pgvector, reasoning, supersession chains, recall ledger)
- Our skill model has explicit grants and scoping (OpenClaw skills are workspace-global)
- Our review/approval gates don't exist in OpenClaw
- We need change-request-driven self-modification (OpenClaw allows direct file overwrites)

---

## 14. Vocabulary

Precise definitions. All documents must use these terms consistently.

| Term | Definition | NOT the same as |
|---|---|---|
| **Tool** | A single executable action with typed input/output schema. Examples: `Bash`, `FileRead`, `WebSearch`. Tools are registered, versioned, and risk-classified. | Skill |
| **Skill** | A reviewed, reusable runbook: instructions + input schema + plan template + tests. A skill may use multiple tools. Skills are authored, versioned, scoped, and promoted through a lifecycle. | Tool, Procedural memory |
| **Procedural memory** | An unreviewed, auto-captured sequence of steps that worked for a task. Raw material for skills. Stored as a thought with `memory_type = 'procedure'`. Confidence-scored, not tested. | Skill |
| **Role policy** | The baseline capability profile for an agent: which tools are allowed, spawn/mutate/review permissions. Set by the role registry. | Tool policy |
| **Tool policy** | Per-agent overrides to role policy: allow or deny specific tools. Stored on the agent record as JSONB. | Role policy |
| **Plan** | A structured decomposition of a goal into ordered, typed steps with dependencies and acceptance criteria. | Task |
| **Task** | A lifecycle wrapper around work: inbox → assigned → in_progress → done. Tasks track status; plans track structure. | Plan |
| **Run** | One complete execution cycle: perceive → think → act → evaluate. Creates tool calls, messages, and evaluations. | Task |
| **Evaluation** | A post-run quality assessment. Types: policy_check, unit_test, critic_llm, self_eval, reflection, human_review. | Reflection |
| **Reflection** | A specific evaluation type: root cause analysis of a failure with proposed fix. Stored and linked to procedural memories. | Evaluation |
| **Capability** | Umbrella term for anything an agent can directly load or invoke: MCP servers, API connectors, skills, explicit workflow-invocation tools, and eligible generated plugins. See marketplace.md for the unified model. | Tool, Skill |
| **ToolRegistryEntry** | A registered tool with typed schema, risk classification, and versioning. All MCP tools and API connector endpoints produce registry entries. See tool-registry-spec.md. | Tool |
| **Temporary context** | Agent context section loaded on demand with external tool schemas. Agent controls lifecycle via `resolve_capability` (load) and `drop_context` (drop). See external-tool-integration.md section 5. | Memory |
| **Resolver sub-agent** | Cheap disposable LLM that selects the right tools for the main agent's temporary context. See external-tool-integration.md section 5. | Orchestrator |
| **Trigger** | A first-class activation record linked to an agent. Types include manual, scheduled, webhook, event, and interval. See § 17. | Run |
| **Scheduler service** | Background process that evaluates cron/interval triggers and creates runs. Uses `pg_advisory_lock` for leader election. See § 17. | Worker |

---

## 15. Agent Builder

How agents are created — by humans through the API, or by other agents through the builder skill.

### Agent Creation Contract

Minimum valid agent:
- `name` (required) — unique within org
- `role` (required) — from role registry or 'assistant'

Recommended for production agents:
- `systemPrompt` — without this, the agent has no specific goal
- `provider` + `model` — without these, the system assigns defaults
- `toolPolicy` — without this, role defaults apply

### Agent Templates

Templates are reusable starting points for agent creation:

```
agent_templates
  id               UUID PK
  name             TEXT UNIQUE (within org)
  description      TEXT
  role             TEXT
  system_prompt    TEXT
  tool_policy      JSONB
  provider         TEXT
  model            TEXT
  memory_policy    JSONB — { read: string[], write: string[], visibility: string }
  budget           JSONB — default budget for agents created from this template
  required_tools   TEXT[]
  tags             TEXT[]
  organization_id  UUID FK → organizations
  created_by       UUID
  version          INT DEFAULT 1
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

System ships with built-in templates: `builder`, `reviewer`, `researcher`, `debugger`, `watcher`.

### Agent Config Versioning

Every agent has an immutable config history:

```
agent_config_versions
  id               UUID PK
  agent_id         UUID FK → agents
  version          INT
  system_prompt    TEXT
  tool_policy      JSONB
  provider         TEXT
  model            TEXT
  role             TEXT
  changed_by       UUID — user or agent who made the change
  change_reason    TEXT
  created_at       TIMESTAMPTZ

  @@unique([agent_id, version])
```

- `agents.active_config_version_id` → current version
- Every change to prompt, policy, provider, model, or role creates a new version
- Rollback = set `active_config_version_id` to a previous version
- Versions are immutable — no edits, only new versions

### Agent Builder Workflow (Agent-Creates-Agent)

When a builder agent creates another agent:

```
Builder agent receives request (via skill or direct instruction)
  │
  ├── 1. Validate inputs against AgentCreationSchema
  │     Required: name, role, goal (natural language)
  │     Optional: domain, allowedTools, forbiddenTools, scope, budget, successCriteria
  │
  ├── 2. Select template (if applicable)
  │     Match role to agent_templates, use as base
  │
  ├── 3. Generate system prompt
  │     Deterministic sections (identity, role, scope) + goal-specific instructions
  │     Builder agent drafts, does NOT inject arbitrary text
  │
  ├── 4. Validate policy
  │     Tool policy must be subset of builder's own permissions
  │     Scope must be within builder's scope (no privilege escalation)
  │     Budget must be within builder's budget allocation
  │
  ├── 5. Create agent in draft state (status: offline)
  │     Insert agents row + first agent_config_versions row
  │     No channel bindings yet
  │
  ├── 6. Bind to channels (after validation)
  │     Only channels the builder has access to
  │
  ├── 7. Dry-run test
  │     Send a test message, verify the agent responds coherently
  │     Record evaluation (kind: dry_run)
  │
  ├── 8. Submit for approval
  │     If builder.requiresReview: create approval request
  │     If approved: activate agent (status: idle)
  │     If rejected: remain in draft with feedback
  │
  └── 9. Audit trail
        agent_config_versions records: who created, from what template, why
        Links to plan step if created as part of a plan
```

### Structured Agent Creation Schema

```json
{
  "name": "string (required)",
  "role": "string (required) — builder | researcher | reviewer | debugger | watcher | assistant | custom",
  "goal": "string (required) — natural language description of purpose",
  "domain": "string (optional) — area of expertise",
  "templateId": "uuid (optional) — start from a template",
  "allowedTools": ["FileRead", "Grep"],
  "forbiddenTools": ["Bash"],
  "scope": {
    "organizationId": "uuid (required)",
    "projectId": "uuid (optional)",
    "teamId": "uuid (optional)",
    "channelIds": ["uuid"]
  },
  "memoryPolicy": {
    "read": ["semantic", "framing", "procedure"],
    "write": ["semantic"],
    "visibility": "project"
  },
  "budget": {
    "maxTokensPerRun": 50000,
    "maxCostCentsPerRun": 50,
    "maxConcurrentRuns": 1
  },
  "successCriteria": ["string"],
  "requiresReview": true
}
```

### Meta-Tools for Agent Management

Tools available to agents with `builder` role and `agent-builder` tool access:

| Tool | Description | Risk |
|---|---|---|
| `create_agent` | Create a new agent from structured input | High |
| `propose_config_change` | Submit a change request for an existing agent's config | High |
| `rollback_agent_config` | Revert an agent to a previous config version | High |
| `create_skill_candidate` | Create a skill from a procedural memory | Medium |
| `promote_skill_version` | Submit a skill version for review | Medium |
| `request_approval` | Create an approval request for any pending action | Low |

These tools are never auto-granted. They require explicit human assignment via `toolPolicy`.

---

## 16. Operational Infrastructure

### Usage Ledgers

Usage is tracked through two durable ledgers:

- `token_ledger` for model calls and translation/model-derived cost
- `execution_usage_ledger` for billable execution environments and runner-backed jobs

`cost_ledger` is a legacy name and should not be used for new implementation. Budget enforcement and reporting roll up from these durable ledgers into reporting views rather than introducing a third source of truth.

### Rate Limiting and Backpressure

```
Run submission
  │
  ├── Per-org concurrency cap (default: 10 concurrent runs)
  ├── Per-agent concurrency cap (default: 1, configurable to 5)
  ├── Per-provider rate limit adaptation (respect 429 responses, back off)
  ├── Queue depth limit (default: 100 per org, reject after)
  └── Priority classes: critical > normal > background
      Critical: approval-gated tasks, human-initiated
      Normal: agent-initiated, plan-driven
      Background: self-eval, memory capture, maintenance
```

When capacity is exhausted:
- Background tasks are shed first
- Normal tasks queue with visible position
- Critical tasks preempt background tasks
- Users see: "Agent is busy, your request is queued (position N)"

### Concurrent Resource Access

When multiple agents work in the same project:

- **File locks**: Advisory locks via `resource_locks` table. Agent acquires lock before file write, releases on step completion or timeout (60s).
- **Conflict detection**: If two agents modify the same file in overlapping runs, the second write detects the conflict and either merges (if possible) or escalates to human.
- **Plan-level write sets**: Plans declare expected write targets upfront. The orchestrator prevents concurrent plans with overlapping write sets.
- **External resource locks**: For deploys, migrations, and shared environments — same lock table, longer timeouts.

---

## 17. Agent Triggers & Scheduling

Agents need to activate on more than just messages. A monitoring agent should wake at 9am daily. A deploy agent should fire when GitHub sends a webhook. An audit agent should react when a task transitions to `review_passed`.

### Trigger Types

Triggers are first-class records. An agent may have zero, one, or many triggers. `on-demand` is not stored as a trigger row unless the platform needs explicit metadata for it; it is the default behavior when no automatic triggers are configured.

| Type | Activation | `config` shape |
|------|-----------|----------------------|
| `manual` | Explicit API call or UI "Run" button | `{}` |
| `scheduled` | Cron expression evaluated by the scheduler service | `{ "cron": "0 9 * * 1-5", "timezone": "Europe/London", "input": { ... } }` |
| `webhook` | Inbound HTTP: `POST /api/webhooks/{webhook_id}` | `{ "secret": "auto-generated", "input_mapping": { ... }, "allowed_ips": [] }` |
| `event` | Internal event bus subscription | `{ "events": ["task.review_passed", "agent.run.failed"], "filter": { "project_id": "..." } }` |
| `interval` | Fixed-interval timer | `{ "interval_minutes": 30, "input": { ... } }` |

> An agent with one or more automatic triggers can still be triggered manually. Trigger rows control automatic activation, not exclusive activation.

### Trigger Config Examples

**Scheduled — daily standup digest at 9am London time:**
```json
{
  "type": "scheduled",
  "config": {
    "cron": "0 9 * * 1-5",
    "timezone": "Europe/London",
    "input": {
      "prompt": "Generate the daily standup digest for all active projects."
    }
  }
}
```

**Webhook — GitHub push events:**
```json
{
  "type": "webhook",
  "config": {
    "secret": "whsec_auto_generated_on_create",
    "input_mapping": {
      "repo": "$.repository.full_name",
      "branch": "$.ref",
      "commits": "$.commits[*].message",
      "pusher": "$.pusher.name"
    },
    "allowed_ips": ["140.82.112.0/20"]
  }
}
```

**Event — react to task review passing:**
```json
{
  "type": "event",
  "config": {
    "events": ["task.review_passed"],
    "filter": {
      "project_id": "proj_abc123"
    }
  }
}
```

**Interval — health check every 15 minutes:**
```json
{
  "type": "interval",
  "config": {
    "interval_minutes": 15,
    "input": {
      "prompt": "Check all monitored services and report any that are degraded."
    }
  }
}
```

### Database Tables

```
agent_triggers
  id               UUID PK
  agent_id         UUID FK → agents
  scope_type       ENUM (system, organization, project, team, channel, user)
  scope_id         UUID — null only for system-scoped triggers
  trigger_type     TEXT NOT NULL
  config           JSONB NOT NULL
  enabled          BOOLEAN DEFAULT true — pause without deleting
  next_run_at      TIMESTAMPTZ — next scheduled activation (null for webhook/event/on-demand)
  last_run_at      TIMESTAMPTZ — last successful activation
  last_error       TEXT — last trigger-level error (not run-level)
  run_count        INT DEFAULT 0 — total activations
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

```
agent_trigger_deliveries
  id               UUID PK
  trigger_id       UUID FK → agent_triggers
  agent_id         UUID FK → agents
  trigger_type     TEXT
  trigger_source   TEXT — "scheduler", "webhook", "event_bus", "manual", "api"
  run_id           UUID FK → runs (nullable — null if trigger fired but run creation failed)
  webhook_id       UUID (nullable — set for webhook triggers)
  event_name       TEXT (nullable — set for event triggers)
  payload          JSONB — the input that was passed to the agent
  status           ENUM (fired, run_created, failed, skipped)
  error            TEXT (nullable)
  fired_at         TIMESTAMPTZ
  created_at       TIMESTAMPTZ
```

```
agent_webhooks
  id               UUID PK
  agent_id         UUID FK → agents
  secret_hash      TEXT NOT NULL — bcrypt hash of the webhook secret
  allowed_ips      TEXT[] — CIDR ranges, empty = allow all
  enabled          BOOLEAN DEFAULT true
  last_used_at     TIMESTAMPTZ
  created_at       TIMESTAMPTZ
  expires_at       TIMESTAMPTZ (nullable — null = never expires)
```

### Scheduler Service

A background service that manages all time-based triggers (scheduled + interval).

```
Scheduler loop (runs every 15 seconds):
  │
  ├── 1. SELECT * FROM agent_triggers
  │      WHERE enabled = true
  │        AND trigger_type IN ('scheduled', 'interval')
  │        AND next_run_at <= NOW()
  │        AND agent_id NOT IN (SELECT agent_id FROM runs WHERE status IN ('running', 'queued'))
  │      FOR UPDATE SKIP LOCKED
  │      LIMIT 50
  │
  ├── 2. For each trigger:
  │     ├── Create Run record (trigger_source: 'scheduler')
  │     ├── Inject config.input as the run input
  │     ├── Enqueue to worker queue
  │     ├── Update next_run_at:
  │     │     scheduled → compute from cron expression
  │     │     interval  → NOW() + interval_minutes
  │     ├── Update last_run_at, increment run_count
  │     └── Write agent_trigger_deliveries entry (status: run_created)
  │
  └── 3. On failure:
        ├── Write agent_trigger_deliveries entry (status: failed, error: ...)
        ├── Update agent_triggers.last_error
        └── Do NOT disable — transient failures should not stop the schedule
            (after 10 consecutive failures, set enabled = false and alert)
```

**Concurrency guard:** The scheduler skips agents that already have a running or queued run. This prevents pile-up if a scheduled agent takes longer than its interval. The skipped activation is logged with `status: skipped`.

**Leader election:** In multi-instance deployments, only one scheduler instance should be active. Use `pg_advisory_lock` on a well-known lock ID. If the lock holder dies, another instance acquires it automatically.

**Cron parsing:** Standard 5-field cron syntax (`minute hour day-of-month month day-of-week`). Extended with optional 6th field for seconds if sub-minute scheduling is ever needed. Timezone stored per-trigger, evaluated at fire time (handles DST transitions).

### Webhook Ingest

```
POST /api/webhooks/{webhook_id}
  │
  ├── 1. Look up agent_webhooks record by webhook_id
  │     ├── Not found → 404
  │     ├── Disabled → 403
  │     ├── Expired → 410
  │     └── IP check against allowed_ips (if set)
  │
  ├── 2. Verify signature
  │     ├── Header: X-Nessie-Signature: sha256=<HMAC of body using secret>
  │     ├── Compute HMAC, constant-time compare
  │     └── Mismatch → 401
  │
  ├── 3. Apply input_mapping (JSONPath expressions against request body)
  │     └── Produces the structured input for the agent run
  │
  ├── 4. Create Run record (trigger_source: 'webhook')
  │     ├── Enqueue to worker queue
  │     └── Write agent_trigger_deliveries entry
  │
  └── 5. Return 202 Accepted { "run_id": "...", "status": "queued" }
```

**Rate limiting:** Per-webhook rate limit of 60 requests/minute. Excess requests return 429 with `Retry-After` header.

**Replay protection:** Each webhook request must include `X-Nessie-Delivery: <unique-id>`. Duplicate delivery IDs within a 24-hour window are rejected (409 Conflict).

### Event Bus Integration

Internal events are emitted by the system during normal operation. Agents can subscribe to these events.

**Event taxonomy:**

| Category | Events |
|----------|--------|
| **Task** | `task.created`, `task.transitioned`, `task.review_passed`, `task.review_failed`, `task.completed`, `task.failed` |
| **Agent** | `agent.run.completed`, `agent.run.failed`, `agent.status_changed`, `agent.spawned` |
| **Channel** | `channel.message_received`, `channel.member_joined`, `channel.member_left` |
| **System** | `system.deploy_completed`, `system.error_rate_spike`, `system.budget_exceeded` |
| **Workflow** | `workflow.completed`, `workflow.failed`, `workflow.step_completed` |

**Subscription model:**

```
Event occurs (e.g., task.review_passed)
  │
  ├── 1. Event bus publishes to pg_notify channel 'agent_events'
  │
  ├── 2. Event router (in scheduler service) receives notification
  │     ├── SELECT * FROM agent_triggers
  │     │   WHERE trigger_type = 'event'
  │     │     AND enabled = true
  │     │     AND config->'events' ? 'task.review_passed'
  │     └── For each matching trigger:
  │           ├── Evaluate filter (e.g., project_id matches)
  │           ├── Create Run with event payload as input
  │           └── Write agent_trigger_deliveries entry
  │
  └── 3. Same concurrency guard as scheduler — skip if agent already running
```

**Event payload:** Every event carries a standard envelope:
```json
{
  "event": "task.review_passed",
  "timestamp": "2026-04-09T14:30:00Z",
  "actor": { "type": "agent", "id": "agent_xyz" },
  "subject": { "type": "task", "id": "task_abc" },
  "data": { "review_score": 0.95, "reviewer_id": "agent_reviewer" },
  "organization_id": "org_123",
  "project_id": "proj_456"
}
```

### Trigger API Endpoints

```
POST   /api/agents/{id}/runs              — manually trigger any agent (creates a run)
GET    /api/agents/{id}/triggers          — list trigger records for the agent
POST   /api/agents/{id}/triggers          — create trigger record
PUT    /api/triggers/{triggerId}          — update trigger `type` + `config`
DELETE /api/triggers/{triggerId}          — remove trigger
POST   /api/triggers/{triggerId}/pause    — disable without deleting
POST   /api/triggers/{triggerId}/resume   — re-enable
GET    /api/triggers/{triggerId}/history  — paginated trigger delivery history

POST   /api/webhooks                       — create webhook for an agent (returns secret ONCE)
GET    /api/webhooks/{id}                   — webhook metadata (no secret)
DELETE /api/webhooks/{id}                   — revoke webhook
POST   /api/webhooks/{id}/rotate           — rotate secret (returns new secret ONCE)

GET    /api/triggers/scheduled              — list all scheduled agents (admin view)
GET    /api/triggers/upcoming               — next N scheduled activations across all agents
```

### MCP Tools

The trigger system is also available as MCP tools for agent self-management:

| Tool | Purpose |
|------|---------|
| `set_trigger` | Configure an agent's trigger (requires agent ownership or admin) |
| `pause_trigger` | Pause an agent's automatic trigger |
| `resume_trigger` | Resume a paused trigger |
| `list_scheduled` | List upcoming scheduled activations |
| `trigger_agent` | Manually fire another agent (subject to permissions) |

### Admin UI

The agent detail page in admin shows:

- **Trigger badge** next to agent name: icon indicating trigger type (clock for scheduled, webhook icon, lightning bolt for event, play button for manual/on-demand)
- **Trigger config panel**: edit cron expression with human-readable preview ("Every weekday at 9:00 AM London time"), manage webhook URLs, select events
- **Next activation**: countdown to next scheduled run
- **Trigger history**: table of recent activations with status, duration, and link to run details
- **Quick actions**: Pause/Resume trigger, Trigger Now button

### Security

- **Webhook secrets** are generated server-side (32 bytes, base64url), returned once on creation, stored as bcrypt hash. Cannot be retrieved — only rotated.
- **Event subscriptions** respect org/project boundaries. An agent in project A cannot subscribe to events from project B.
- **Scheduled agents** inherit all existing permission constraints: tool policy, budget limits, approval gates.
- **Manual trigger** via API requires the caller to have `agent:trigger` permission on the target agent.
- **Webhook IP allowlisting** is optional but recommended for known sources (GitHub, Stripe, etc.).
- **Rate limits** prevent webhook flood attacks from creating unbounded runs.
