# Agent System Implementation Plan

> Status: draft — pending review.

This plan covers the implementation of the full agent system: triggers, scheduling, webhooks, event-driven activation, the agentic loop, tool execution, skills, memory, and inter-agent communication.

It follows the project's planning rules from [implementation-phases.md](../implementation-phases.md):
- Every phase ends in something workable.
- No dead-end prototype layers.
- Each phase is testable by clicking and starting agents.

## Relationship to Existing Phases

The main [implementation-phases.md](../implementation-phases.md) covers the full platform (auth, org model, channels, policy, tools, secrets, etc.). This plan is a focused **agent-track overlay** that maps to the same phase timeline but zooms in on agent-specific work.

| Main Phase | Agent Track Focus |
|---|---|
| Phase 1 | Core agent CRUD, safe tools, sub-agent spawning (DONE) |
| Phase 2 | Multi-user, policy, approvals (in progress) |
| **This plan** | Agent-specific capabilities that weave through Phases 3–5+ |

## Spec References

- [the-agents.md](../the-agents.md) — canonical agent architecture
- [external-tool-integration.md](../external-tool-integration.md) — tool execution, temporary context, async tools, remote workers
- [skills.md](../skills.md) — skill system
- [marketplace.md](../marketplace.md) — marketplace and capability assignments
- [multi-agent-memory-system.md](../multi-agent-memory-system.md) — memory types, recall, self-eval
- [conversation-intelligence-platform.md](../conversation-intelligence-platform.md) — event-driven platform
- [agent-base-template.md](../agent-base-template.md) — agent contract and field definitions

---

## Agent Phase 0: Visual Prototype (Fake Admin Console)

### Goal

Build the complete agent admin experience with fake data. Every page, every panel, every interaction — all wired to mock data providers. This lets the user visually debug the full UX before a single backend line is written.

### Why First

- Catches UX mistakes before they're baked into backend contracts.
- Defines the exact API shapes the backend must implement (mock → real swap).
- User can click through every agent workflow end-to-end.
- Zero backend dependency — can run in isolation.

### Scope

**Pages to build (all with fake data):**

1. **Agent Dashboard** — overview of all agents with status, trigger type badge, last activity, active runs
2. **Agent Detail** — full agent view:
   - Config tab (name, role, system prompt, model, tool policy)
   - Trigger tab (trigger type, config editor, next run, cron preview, webhook URL, event subscriptions)
   - Runs tab (run history with status, duration, trigger source, cost)
   - Skills tab (assigned skills, available skills, promotion candidates)
   - Memory tab (recent thoughts, recall ledger, framing summary)
   - Children tab (sub-agent tree with live status dots)
   - Activity tab (real-time thought stream, tool execution log)
3. **Trigger Management** — dedicated view:
   - Scheduled agents list with next-run countdown timers
   - Webhook registry with URLs, last-used, status
   - Event subscriptions matrix (agent × event type)
   - Trigger history log (fired, skipped, failed)
4. **Resources Page** — remote workers:
   - Worker list with status, scope (org/project/team/channel/personal), tools, last heartbeat
   - Worker detail with policy viewer, tool bindings, activity log
   - Register new worker flow (shows CLI command to run on target machine)
5. **Agent Designer** — enhanced version:
   - Trigger configuration step (pick trigger type, configure cron/webhook/event)
   - Tool selection with temporary context preview
   - Skill assignment with dependency check
   - Budget configuration
   - Test run button (simulated)
6. **Workflow Builder** (stub) — visual graph editor showing agent + trigger + tool nodes. Read-only in Phase 0 — just renders example workflows to validate the visual language.

**Mock data provider pattern:**

```typescript
// src/facades/agents/mock-data.ts
export const MOCK_AGENTS: AgentRecord[] = [
  {
    id: 'agent_orchestrator_001',
    name: 'Project Orchestrator',
    role: 'orchestrator',
    status: 'idle',
    triggerType: 'on-demand',
    triggerConfig: {},
    // ... full record
  },
  {
    id: 'agent_morning_digest',
    name: 'Morning Digest',
    role: 'researcher',
    status: 'idle',
    triggerType: 'scheduled',
    triggerConfig: {
      cron: '0 9 * * 1-5',
      timezone: 'Europe/London',
      input: { prompt: 'Generate the daily standup digest.' }
    },
    nextRunAt: '2026-04-10T09:00:00Z',
    // ...
  },
  {
    id: 'agent_deploy_watcher',
    name: 'Deploy Watcher',
    role: 'watcher',
    status: 'idle',
    triggerType: 'webhook',
    triggerConfig: {
      secret: 'whsec_mock_xxx',
      input_mapping: { repo: '$.repository.full_name', branch: '$.ref' },
      allowed_ips: ['140.82.112.0/20']
    },
    // ...
  },
  {
    id: 'agent_review_reactor',
    name: 'Review Reactor',
    role: 'reviewer',
    status: 'idle',
    triggerType: 'event',
    triggerConfig: {
      events: ['task.review_passed'],
      filter: { project_id: 'proj_mock_001' }
    },
    // ...
  },
  {
    id: 'agent_health_checker',
    name: 'Health Checker',
    role: 'watcher',
    status: 'busy',
    triggerType: 'interval',
    triggerConfig: { interval_minutes: 15, input: { prompt: 'Check all services.' } },
    lastRunAt: '2026-04-09T14:15:00Z',
    nextRunAt: '2026-04-09T14:30:00Z',
    // ...
  }
]
```

**Facade swap pattern:**
```typescript
// src/facades/agents/hooks.ts
import { MOCK_AGENTS } from './mock-data'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

export const useAgents = () => {
  const apiClient = useApiClient()
  return useQuery<AgentRecord[]>({
    queryKey: ['agents'],
    queryFn: USE_MOCK
      ? () => Promise.resolve(MOCK_AGENTS)
      : () => apiClient.get('/api/agents'),
  })
}
```

**New facade files:**
- `src/facades/triggers/hooks.ts` + `mock-data.ts`
- `src/facades/triggers/types.ts` (trigger config types)
- `src/facades/resources/hooks.ts` + `mock-data.ts`
- `src/facades/runs/mock-data.ts` (extend existing)
- `src/facades/skills/hooks.ts` + `mock-data.ts`

**New routes in `router.tsx`:**
- `/triggers` — Trigger Management page
- `/resources` — Remote Workers / Resources page
- `/agents/:agentId` — Agent Detail page (tabbed)
- `/agents/new` — Enhanced Agent Designer (already exists, extend)

**Rail navigation additions:**
- Clock icon → `/triggers` (Schedules & Triggers)
- Server icon → `/resources` (Resources)

### Mock scenarios to build

Each scenario should be click-through-able:

1. **Scheduled agent fires** — Morning Digest agent shows countdown, timer hits zero, status transitions idle → thinking → executing → idle, run appears in history with trigger_source: scheduler
2. **Webhook arrives** — Deploy Watcher shows "last webhook 2 minutes ago", click "Simulate Webhook" button, status transitions, run appears with trigger_source: webhook, payload visible
3. **Event triggers agent** — Review Reactor shows subscribed events, simulate task.review_passed event, agent wakes, processes, returns to idle
4. **Agent spawns sub-agent** — Orchestrator delegates to Builder, sub-agent tree updates in real time, parent shows "waiting for child"
5. **Agent uses tools** — Agent loads tools into temporary context (visible in activity panel), executes, drops context
6. **Remote worker comes online** — Resources page shows worker transitioning from offline → active, tools become available
7. **Trigger paused/resumed** — Toggle trigger on Health Checker, next-run countdown disappears/reappears

### Exit criteria

- All 6 pages render with mock data
- All 7 scenarios are click-through-able
- `pnpm --filter @nessie/admin build` passes
- Lint and typecheck pass
- Playwright visual verification of every page
- Mock → real facade swap requires zero component changes

---

## Agent Phase 1: Agentic Loop + Native Tool Calling

### Goal

Replace single-shot keyword-based tool execution with a real perceive-think-act loop. The agent calls tools by emitting structured tool calls, observes results, and decides what to do next.

### Why This Phase

Everything else depends on this. Without the agentic loop, agents can't plan, can't self-correct, can't use tools dynamically, and can't manage temporary context.

### Scope

- **Worker rewrite**: Replace `executeSafeTool()` keyword dispatch with model-driven tool calling
- **Multi-step loop**: Agent can call tools, observe results, call more tools, then respond
- **Iteration budget**: `maxIterations` (default: 10), `maxWallclockMs` (default: 90000), `maxCostCents` per run
- **Streaming**: Tool calls and results stream to the UI via WebSocket in real time
- **Safe tools only**: Same tool set as Phase 1 (web_search, document_read, web_fetch) — no new tools yet
- **Tool call auditing**: Every tool call → `ToolCall` record with timing, input, output, cost

### Backend work

1. Worker `executeRunJob` rewritten with agentic loop:
   ```
   while (iterations < budget.maxIterations) {
     response = await llm.chat(messages, { tools })
     if (response.stop_reason === 'end_turn') break
     for (tool_call of response.tool_calls) {
       result = await executeTool(tool_call)
       messages.push(tool_call_result)
       emit('agent.tool.end', { tool: tool_call.name, result })
     }
     iterations++
   }
   ```
2. Budget enforcement checks before each iteration
3. Tool call records written per call (not per run)
4. WebSocket events: `agent.tool.start`, `agent.tool.end`, `agent.iteration`

### Admin UI work

- Replace Phase 0 mock data with real API calls (facade swap: `USE_MOCK=false`)
- Tool execution log shows real tool calls streaming in
- Iteration counter visible in agent activity panel
- Budget usage bar (tokens/cost/iterations used vs limit)

### Testable outcome

- Create an agent in the UI
- Ask it a question requiring web search
- Watch it: think → call web_search → observe results → synthesize answer
- See tool calls streaming in the activity panel
- Budget bar shows usage

### Exit criteria

- Agentic loop executes multi-step tool sequences
- Budget enforcement stops runaway agents
- Tool calls audited in DB and visible in UI
- WebSocket streams tool activity in real time
- `worker/` lint, typecheck, build pass
- Playwright verification of tool execution in UI

---

## Agent Phase 2: Trigger System + Scheduler Service

### Goal

Agents activate automatically — on schedule, via webhook, or in response to internal events. Not just when someone sends them a message.

### Scope

- **Scheduler service**: Background process evaluating cron/interval triggers (see the-agents.md § 17)
- **Webhook ingest**: `POST /api/webhooks/{id}` with HMAC verification, IP allowlisting, rate limiting
- **Event bus**: `pg_notify` based event routing with agent subscription matching
- **Trigger API**: Full CRUD for trigger configuration, pause/resume, history
- **Trigger DB**: `agent_triggers`, `agent_trigger_log`, `agent_webhooks` tables

### Backend work

1. **Prisma migration**: Add `trigger_type`, `trigger_config` to `agents` table. Create `agent_triggers`, `agent_trigger_log`, `agent_webhooks` tables.
2. **Scheduler service** (`worker/src/scheduler/`):
   - 15-second evaluation loop
   - `pg_advisory_lock` for leader election
   - Cron expression parsing (5-field + timezone)
   - Concurrency guard (skip if agent already has active run)
   - 10-consecutive-failure auto-disable with alert
3. **Webhook handler** (`api/src/routes/webhooks.ts`):
   - HMAC-SHA256 signature verification
   - IP allowlist check
   - Input mapping via JSONPath
   - Rate limit: 60/min per webhook
   - Replay protection via `X-Nessie-Delivery` header
4. **Event router** (in scheduler service):
   - Subscribe to `pg_notify('agent_events')`
   - Match events against `agent_triggers` WHERE `trigger_type = 'event'`
   - Evaluate filters (project_id, agent_id, etc.)
   - Create runs for matching agents
5. **Trigger API endpoints** (all from the-agents.md § 17)
6. **MCP tools**: `set_trigger`, `pause_trigger`, `resume_trigger`, `trigger_agent`, `list_scheduled`

### Admin UI work

- Wire Trigger Management page to real API (replace mocks)
- Wire Agent Detail → Trigger tab to real API
- Webhook URL display with copy button
- Cron expression editor with human-readable preview and next-5-runs display
- Event subscription picker (checkboxes from event taxonomy)
- Trigger history with status badges and run links
- "Trigger Now" button on any agent

### Testable outcome

- Create an agent with `triggerType: "scheduled"`, cron: `*/2 * * * *` (every 2 minutes)
- Watch it fire automatically, see run in history
- Create a webhook agent, send a `curl` POST with signature
- Watch it create a run from the webhook payload
- Create an event agent subscribing to `task.completed`
- Complete a task → event agent wakes up and runs

### Exit criteria

- Scheduler fires cron/interval agents on time
- Webhooks verified by signature, rate-limited, logged
- Events trigger subscribed agents
- Pause/resume works
- Trigger history shows all activations
- All endpoints pass lint, typecheck, build
- Playwright verification of trigger management UI

---

## Agent Phase 3: Temporary Context + Tool Resolution

### Goal

Agents dynamically load and unload tool schemas based on what they need. The resolver sub-agent picks tools; the main agent uses them and drops them when done.

### Scope

- **Capability directory**: Registry of all available capabilities with metadata (see external-tool-integration.md § 5)
- **Resolver sub-agent**: Cheapest LLM picks the right tools for a given request
- **Temporary context**: Array of loaded tool schemas on the main agent's context
- **`resolve_capability` tool**: Loads a capability section into temporary context
- **`drop_context` tool**: Agent unloads tools it no longer needs
- **Turn-by-turn hygiene**: System prompt reminds agent to drop unused context each turn

### Backend work

1. **Capability directory** (`packages/capabilities/`):
   - Registry of all MCP servers, API connectors, skills, workflow templates
   - Each entry: name, description, category, tool schemas, required credentials
   - Search by name, category, or natural language description
2. **Resolver service** (`worker/src/resolver/`):
   - Takes user message + capability directory index
   - Returns list of capability sections to load
   - Uses cheapest available model (e.g., Haiku)
   - Deterministic cache: same request pattern → same resolution (short TTL)
3. **Temporary context management**:
   - `resolve_capability` permanent tool on all agents
   - `drop_context` permanent tool on all agents
   - Context budget: max 10 loaded capability sections per agent
   - Turn preamble: "You have N capability sections loaded. Call drop_context for any you no longer need."
4. **Credential injection**: When a capability section loads, required credentials are resolved from the secret vault and injected into the tool's runtime config (not visible to the agent).

### Admin UI work

- Agent Detail → Activity tab shows temporary context loads/drops in real time
- "Loaded Tools" panel on agent detail showing currently loaded capability sections
- Capability browser: searchable index of all available capabilities

### Testable outcome

- Ask an agent "What's the weather in London?"
- Watch resolver pick the weather API capability
- See capability load into temporary context (visible in UI)
- Agent calls weather tool, gets result
- Agent drops the weather context
- Next message about code → different capability loads

### Exit criteria

- Resolver correctly picks capabilities for varied requests
- Temporary context loads/drops visible in UI
- Credential injection works without exposing secrets to agent
- Context budget enforced (max 10 sections)
- Turn hygiene prompt fires and agents actually drop unused context
- Lint, typecheck, build pass

---

## Agent Phase 4: Inter-Agent Communication + Plans

### Goal

Agents can talk to each other, delegate work, and coordinate through structured plans.

### Scope

- **Agent mailbox** (the-agents.md § 8): DB-backed message bus with at-least-once delivery
- **Plan model** (the-agents.md § 9): Structured goal decomposition into ordered, typed steps
- **Orchestrator coordination**: Parent agent creates plans, delegates steps to children, aggregates results
- **Handoff protocol**: Agent-to-agent work transfer with context

### Backend work

1. **Prisma migration**: `agent_mailbox`, `agent_mailbox_dlq`, `plans`, `plan_steps` tables
2. **Mailbox service** (`api/src/services/mailbox.ts`):
   - At-least-once delivery with idempotency (correlation_id)
   - Visibility timeout: 60s → retry
   - Max 3 retries with exponential backoff
   - Dead-letter queue after exhaustion
   - Plan-ordered delivery within plan_id + step_id
3. **Plan service** (`api/src/services/plans.ts`):
   - Plan CRUD
   - Step dependency resolution
   - Step execution dispatch (inline, spawn_task, delegate, tool_call)
   - Status aggregation (plan complete when all steps complete)
4. **Orchestrator enhancements**:
   - Plan-driven agent routing
   - Parallel step execution (Fork/Join)
   - Failure handling (retry step, skip, abort plan)

### Admin UI work

- Agent Detail → Plans tab showing active and completed plans
- Plan visualization: step graph with status colors
- Mailbox viewer: pending/delivered/processed messages
- Cross-agent activity trace: follow a plan across multiple agents

### Testable outcome

- Create an orchestrator with two child agents (builder + reviewer)
- Send "Implement feature X and review it"
- Watch orchestrator create a plan with steps
- Builder agent receives delegation, does work
- Reviewer agent receives handoff, reviews
- Plan completes, orchestrator synthesizes result

### Exit criteria

- Plans decompose goals into steps
- Steps execute in dependency order
- Mailbox delivers messages reliably
- Cross-agent traces visible in UI
- Dead-letter queue catches failures
- Lint, typecheck, build pass

---

## Agent Phase 5: Evaluation + Self-Correction + Skills

### Goal

Agents evaluate their own work, learn from failures, and promote successful patterns into reusable skills.

### Scope

- **Evaluation loop** (the-agents.md § 10): Post-run quality checks
- **Reflection**: Root cause analysis of failures
- **Procedural memory capture**: Auto-capture reusable procedures
- **Skill promotion pipeline** (the-agents.md § 7): Promote procedures to tested skills
- **Skill execution**: Skills as structured runbooks agents can invoke

### Backend work

1. **Evaluation service**:
   - Policy check (did the agent violate any constraints?)
   - Self-eval (agent rates its own output)
   - Critic (separate agent evaluates quality)
   - Human review (approval gate)
2. **Reflection storage**: `reflections` table linked to runs and procedural memories
3. **Procedural memory capture**: Extract step sequences from successful runs
4. **Skill promotion**:
   - Minimum 3 successful uses
   - Confidence ≥ 0.7
   - Auto-generate tests from success/failure history
   - Sandbox test execution
   - Review gate before activation
5. **Skill execution**: `load_skill` / `unload_skill` tools, plan template injection

### Admin UI work

- Agent Detail → Memory tab with thought browser
- Skill promotion pipeline visualization (procedure → candidate → tested → active)
- Skill library with install/assign actions
- Evaluation history on run detail page

### Testable outcome

- Agent completes a task successfully 3 times
- Procedural memory captured automatically
- Promotion trigger fires → skill candidate created
- Tests generated and run in sandbox
- Skill approved → becomes available
- Another agent uses the skill

### Exit criteria

- Self-eval runs after every agent run
- Reflections stored for failures
- Procedures captured from successes
- Skill promotion works end-to-end
- Skills executable by agents
- Lint, typecheck, build pass

---

## Agent Phase 6: Remote Workers + Async Tools

### Goal

Agents can execute on remote machines and run long-lived async operations that take hours.

### Scope

- **Remote MCP servers** (external-tool-integration.md § 2): Poll-then-WebSocket, three-layer policy, CLI tool discovery
- **`nessie-agent` CLI**: Register, run, install-service commands
- **Resources admin page**: Worker list with status, scope, tools, policy
- **Async tools** (external-tool-integration.md § 1.1): Long-running operations with progress streaming
- **Custom HTML output**: Direct DOM injection with sanitization for async tool results

### Backend work

1. **Remote worker protocol**:
   - `protocol: "remote"` on `mcp_server_instances`
   - Poll endpoint: `GET /api/workers/{id}/poll`
   - WebSocket upgrade when work pending
   - Heartbeat: 60s HTTP, 15s WebSocket
   - Three-layer policy intersection
2. **`nessie-agent` CLI** (`cli/nessie-agent/`):
   - `nessie-agent register` — register with Nessie instance
   - `nessie-agent run` — start worker loop
   - `nessie-agent install-service` — install as system service
   - Local tool discovery (shell, file, process, SSH, MCP proxy)
   - `nessie-agent.yaml` config
3. **Async tool framework**:
   - `async_jobs` table
   - `check_job` / `cancel_job` permanent tools
   - Progress streaming via SSE
   - Summary injection on completion
   - Custom HTML output with DOMPurify sanitization
4. **Resources API**:
   - Worker CRUD, status, tools, policy, bindings
   - Scope assignment (org/project/team/channel/personal)

### Admin UI work

- Wire Resources page to real API (replace Phase 0 mocks)
- Worker status monitoring with live heartbeat indicator
- Remote worker registration wizard
- Async job progress cards in chat
- Custom HTML result rendering

### Testable outcome

- Install `nessie-agent` on a second machine
- Register it with Nessie → appears in Resources page
- Bind a remote tool to an agent
- Agent uses the remote tool → execution happens on remote machine
- Start an async deep-research job → progress streams to chat
- Job completes → rich HTML result rendered in chat

### Exit criteria

- Remote workers register, heartbeat, execute tools
- Three-layer policy enforced
- Async jobs stream progress
- Custom HTML renders safely
- CLI installs as system service
- Lint, typecheck, build pass

---

## Agent Phase 7: Marketplace + Agent Builder

### Goal

Agents, skills, tools, and workflow templates are discoverable, installable, and composable through a marketplace.

### Scope

- **Marketplace** (marketplace.md): Unified catalog of capabilities
- **Agent builder** (the-agents.md § 15): Structured agent creation by humans or other agents
- **Workflow templates**: Pre-built multi-agent pipelines
- **Agent versioning**: Immutable config history with rollback

### Backend work

1. Marketplace service with search, categories, reviews, ratings
2. Install/uninstall flow with dependency resolution
3. Agent builder skill: structured intake form → deterministic agent creation
4. Agent config versioning: `agent_config_versions` table, rollback API
5. Workflow template engine: graph execution, trigger binding

### Admin UI work

- Marketplace browser with search, filters, categories
- Install flow with permission grant review
- Agent builder wizard (extended from Phase 0 designer)
- Version history on agent detail with diff view and rollback button
- Workflow builder (visual graph editor — upgrade from Phase 0 stub)

### Testable outcome

- Browse marketplace, find "Code Review Pipeline" template
- Install it → creates agents, binds tools, registers triggers
- Run the pipeline → agents coordinate, review code, produce report
- Roll back an agent config change → previous version restored

### Exit criteria

- Marketplace searchable and installable
- Agent builder creates valid agents
- Workflow templates execute end-to-end
- Config versioning with rollback works
- Lint, typecheck, build pass

---

## Summary: Phase Dependencies

```
Phase 0: Visual Prototype (fake admin)
  │
  ├── No backend dependency
  │
Phase 1: Agentic Loop + Native Tool Calling
  │ depends on: Phase 0 (UI ready for real data swap)
  │
Phase 2: Trigger System + Scheduler
  │ depends on: Phase 1 (agents must be able to run)
  │
Phase 3: Temporary Context + Tool Resolution
  │ depends on: Phase 1 (agentic loop)
  │             Main Phase 3 (tool registry)
  │
Phase 4: Inter-Agent Communication + Plans
  │ depends on: Phase 1 (agentic loop)
  │
Phase 5: Evaluation + Self-Correction + Skills
  │ depends on: Phase 4 (plans)
  │             Phase 3 (tool resolution)
  │             Main Phase 3 (tool registry, secrets)
  │
Phase 6: Remote Workers + Async Tools
  │ depends on: Phase 3 (temporary context)
  │             Phase 2 (triggers — remote workers use event triggers)
  │             Main Phase 4 (remote execution scope)
  │
Phase 7: Marketplace + Agent Builder
    depends on: Phase 5 (skills)
                Phase 6 (remote tools)
                Main Phase 3 (tool registry, knowledge base)
```

**Parallelism:** Phases 2, 3, and 4 can be developed in parallel after Phase 1 completes. Phase 5 requires 3+4. Phase 6 requires 2+3. Phase 7 requires everything.

---

## Validation Issues to Fix During Implementation

From the Claude validation pass:

1. **Status ENUM lifecycle gap**: `mcp_server_instances` has 10 statuses but the lifecycle diagram only shows transitions for non-remote servers. Add a "Remote protocol lifecycle" subsection during Phase 6.
2. **Budget/reaper threshold ordering**: Document the invariant `maxWallclockMs < stale_run_reap_threshold < worker_offline_threshold` (90s / 120s / 180s) in the Budget Controls section during Phase 1.
