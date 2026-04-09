# The Agents

How Nessie agents work today, how they should work, and what needs to change. This is the canonical reference for agent architecture, creation, execution, skills, and the path from single-shot assistant to autonomous planner-executor-critic.

Related documents:
- [agent-base-template.md](agent-base-template.md) — universal agent contract and field definitions
- [multi-agent-memory-system.md](multi-agent-memory-system.md) — memory types, retrieval, self-eval
- [agent-communication-spec.md](agent-communication-spec.md) — routing, threads, status model
- [research/evolving-agent-runtime-enterprise-grade.md](research/evolving-agent-runtime-enterprise-grade.md) — enterprise evolution research

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

**Required:** `name`

**Optional:** `role` (default: "assistant"), `systemPrompt`, `parentAgentId`, `toolPolicy`, `provider`, `model`

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

The service creates the agent record and returns it with a generated UUID. The agent starts in `idle` status and does nothing until bound to a channel and triggered by a message.

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
  status      ENUM (pending, running, completed, failed, cancelled)
  started_at  TIMESTAMPTZ
  finished_at TIMESTAMPTZ
  created_at  TIMESTAMPTZ
```

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

- **Full auditing**: Every tool call recorded with input/output/duration/success
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
  scope_type  ENUM (channel, project, team, organization)
  scope_id    UUID — the channel/project/team/org ID
  granted_by  UUID FK → users — who included it
  created_at  TIMESTAMPTZ
```

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
  status           ENUM (draft, testing, approved, deprecated)
  visibility       ENUM (private, public)

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
  scope_type       ENUM (channel, project, team, organization)
  scope_id         UUID
  granted_by       UUID FK → users
  created_at       TIMESTAMPTZ

  @@unique([skill_id, scope_type, scope_id])
```

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

  kind             TEXT — "request", "result", "event", "handoff"
  content          TEXT
  metadata         JSONB

  status           ENUM (queued, delivered, processed, failed)
  created_at       TIMESTAMPTZ
  delivered_at     TIMESTAMPTZ
  processed_at     TIMESTAMPTZ
```

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
  status           ENUM (pending, running, done, failed, skipped)

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

---

## 10. Evaluation and Self-Correction

### Critic Loop

After execution, every significant run goes through evaluation:

```
evaluations
  id               UUID PK
  kind             ENUM (policy_check, unit_test, integration_test, critic_llm, human_review)
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

| Component | Location | Notes |
|---|---|---|
| Agent CRUD + hierarchy | `api/src/services/agents.ts` | Full lifecycle |
| Agent status model | Prisma schema + WebSocket events | 6 states, real-time push |
| Run execution | `worker/src/run/execute.ts` | Single-shot, keyword tools |
| 3 safe tools | `worker/src/run/tools.ts` | document_read, web_fetch, web_search |
| Role registry | `src/orchestration/role-registry.ts` | 6 roles with tool policies |
| Spawn system | `src/orchestration/spawn-manager.ts` | Depth/children/concurrency limits |
| Review gates | `src/orchestration/verification.ts` | Pass/fail with repair iterations |
| Approval gates | `src/orchestration/approvals.ts` | Human approve/reject |
| Channel orchestrator | `api/src/services/orchestrator.ts` | LLM-based agent routing |
| Task ledger | `src/orchestration/task-ledger.ts` | 8-state lifecycle |
| Memory retrieval | `packages/memory/` | Hybrid search, recall ledger |
| Tool call auditing | ToolCall table + WebSocket events | Full audit trail |
| Watcher/monitoring | `src/orchestration/watcher.ts` | Stale task, loop, runaway detection |

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
| **Personalization memory** | Future | — | User communication model |
| **Local-first filtering** | Future | — | On-device memory extraction |

### Implementation Order

```
Phase 1: Native tool calling + agentic loop
  └── This unblocks everything. Without it, nothing else works.

Phase 2: Plans + schema-validated router
  └── Structured decomposition, typed routing decisions.

Phase 3: Skills + inter-agent mailbox
  └── Reusable capabilities, agent coordination.

Phase 4: Evaluation + critic + reflection
  └── Quality gates, self-correction, learning.

Phase 5: Tool Registry + sandbox
  └── Versioned tools, safe execution of generated code.

Phase 6: Memory integration (procedural, framing, self-eval)
  └── System improves itself over time.

Phase 7: Enterprise hardening
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
