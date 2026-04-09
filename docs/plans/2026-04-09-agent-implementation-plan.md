# Agent System Implementation Plan

> Status: reviewed (Codex + Gemini pass complete, fixes applied).

This plan covers the implementation of the full agent system: the agentic loop, triggers, scheduling, webhooks, event-driven activation, tool resolution, skills, memory, inter-agent communication, remote workers, async tools, and the marketplace.

It follows the project's planning rules from [implementation-phases.md](../implementation-phases.md):
- Every phase ends in something workable.
- No dead-end prototype layers.
- Each phase is testable by clicking and starting agents.

## Relationship to Existing Phases

The main [implementation-phases.md](../implementation-phases.md) remains the source of truth for platform-core delivery:

- auth and tenancy
- org/project/team/channel model
- policy engine
- shared schemas/config
- deployment/runtime foundations
- non-agent platform administration

This document is the source of truth for agent-specific delivery:

- agent execution and orchestration
- triggers and scheduler behavior
- plans, mailbox, and inter-agent coordination
- tool registry and temporary context as consumed by agents
- skills, workflow templates, generated plugins, and marketplace agent UX
- execution environments, runners, remote workers, and agent builder flows

When the two plans overlap, this document wins for anything agent-, workflow-, trigger-, runner-, or marketplace-related.

| Main Phase | Agent Track Focus |
|---|---|
| Phase 1 | Core agent CRUD, safe tools, sub-agent spawning (DONE) |
| Phase 2 | Multi-user, policy, approvals (in progress) |
| Phase 3+ | All further agent/workflow/runtime execution work is defined here |

### Phase ordering rationale

The canonical order in the-agents.md § 12 is: agentic loop → plans → eval → tool registry → skills → memory → agent builder → enterprise. This plan deviates in two places:

1. **Triggers (Phase 2) before Plans (Phase 3)**: Triggers only depend on agents being able to run (Phase 1). Plans are more complex and have more dependencies. The user explicitly prioritized triggers. Plans move to Phase 3.
2. **Tool Registry + Temp Context combined (Phase 5)**: The capability directory and resolver sub-agent require the tool registry to exist. Rather than two thin phases, they ship together.

All other ordering aligns with the canonical sequence.

## Spec References

- [the-agents.md](../the-agents.md) — canonical agent architecture (§ 17 triggers, § 8 mailbox, § 9 plans, § 10 evaluation, § 12 roadmap, § 15 builder, § 16 ops)
- [external-tool-integration.md](../external-tool-integration.md) — tool execution, temporary context (§ 5), async tools (§ 1.1), remote workers (§ 2), API connectors (§ 3)
- [skills.md](../skills.md) — skill system, security verification pipeline (§ 3), tier model
- [marketplace.md](../marketplace.md) — unified marketplace, library, capability assignments, workflow templates (§ 8)
- [multi-agent-memory-system.md](../multi-agent-memory-system.md) — memory types, recall, self-eval, phases A–F
- [conversation-intelligence-platform.md](../conversation-intelligence-platform.md) — event-driven platform, plugin architecture
- [agent-base-template.md](../agent-base-template.md) — agent contract and field definitions

## Shared Scope Model

The platform needs one canonical placement scope enum for shareable resources:

- `system`
- `organization`
- `project`
- `team`
- `channel`
- `user`

Rules:

- `system` is platform-wide and only mutable by superusers.
- `system` is the only scope that does not require a `scope_id`.
- All other scopes require a concrete `scope_id`.
- `global` is not used. Use `organization`.
- `personal` is not used. Use `user`.
- `agent`, `tool`, `thread`, and `service` are not scopes. They are policy targets, principals, or execution contexts.

This enum applies to placement and sharing for reusable objects:

- agents
- triggers
- skills
- resources / remote workers
- secrets
- library items
- workflow templates

Execution artifacts are still gated, but usually inherit access from parent resources and policy rather than having their own share bindings:

- runs
- evaluations
- approvals
- tool calls
- activity logs
- messages

### Multi-Scope Binding Model

Resources may be visible in more than one scope. Do not model this as a JSON array on the primary record.

- Each shareable resource has one home scope: `scope_type`, `scope_id`
- Additional visibility is represented through scope binding rows
- Effective access is the union of matching bindings, subject to policy

Minimum binding audit fields:

- `id`
- `resource_type`
- `resource_id`
- `scope_type`
- `scope_id`
- `created_at`
- `created_by`
- `updated_at`
- `updated_by`
- `revoked_at`
- `revoked_by`

## Principal Model

Placement scopes and acting principals are different concepts.

Use `principal` for actors or execution targets such as:

- `user`
- `agent`
- `service`
- `tool`
- `thread`
- `role`

Rules:

- placement and sharing use `scope_type` / `scope_id`
- execution and authorization use canonical actor/principal context
- grants/bindings may target principals, but principals are never placement scopes
- later phases should prefer explicit `principal_type` / `principal_id` wording over generic “binding target” unless a spec is intentionally broader

## Access Model

The platform needs a clear distinction between configuration rights, invocation rights, and internal visibility.

### Access levels

- `manage`
  - configure internals, bindings, triggers, policies, scope, approvals, and assignments
- `invoke`
  - start an agent or workflow and always receive final output/result plus final success/failure state
- `inspect`
  - see internal execution details such as step logs, intermediate state, internal tool calls, and hidden dependency wiring
- `none`

`invoke` always includes final output. There is no separate “observe final output” permission.

### Black-box mode

Inherited or delegated capabilities may execute in `black_box` mode:

- caller may invoke the agent or workflow
- caller may receive allowed final output and sanitized terminal state
- caller may not inspect internal steps, logs, triggers, secret bindings, hidden connectors, or protected intermediate data
- caller may not manage internals

This is the default handling for inherited protected dependencies that should be usable without being inspectable.

### Trigger attachment rule

Agent templates do not define `supported_triggers` or `recommended_triggers`.

Rules:

- any trigger type may be attached to any agent if scope/policy allows it
- trigger compatibility is a policy/access problem, not a payload-shape problem
- raw trigger payload may be passed through even if sparse or provider-specific
- optional input mapping/normalization is allowed but not required for trigger attachment

Configuration and runtime permissions are evaluated separately:

- to configure/attach a trigger, the acting user must have permission to use that trigger and to manage the target agent/workflow
- to execute after firing, the target agent/workflow must have permission to run with that trigger
- explicit black-box delegation may allow invoke-only access without exposing hidden trigger internals

---

## Agent Phase 0: Visual Prototype (Design Track)

> **Not an implementation phase.** This is a design track that produces production facades, types, and components. Every facade, type, and component created here survives unchanged into real backend integration. The mock → real swap is a config toggle (`VITE_USE_MOCK`), not a rewrite.

### Goal

Build the complete agent admin experience with fake data. Every page, every panel, every interaction — all wired to mock data providers. This lets the user visually debug the full UX before a single backend line is written.

### Why First

- Catches UX mistakes before they're baked into backend contracts.
- Defines the exact API response shapes the backend must implement.
- User can click through every agent workflow end-to-end.
- All types, facades, and components are production code.

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
   - Activity tab (real-time thought stream, tool execution log, loaded context sections)
   - Evaluations tab (per-run evaluation rows: policy_check, self_eval, critic_llm, human_review)
   - Versions tab (config version history with diff view)
3. **Trigger Management** — dedicated view:
   - Scheduled agents list with next-run countdown timers
   - Webhook registry with URLs, last-used, status
   - Event subscriptions matrix (agent × event type)
   - Trigger history log (fired, skipped, failed) with run links
4. **Resources Page** — remote workers:
   - Worker list with status, scope (`system`/organization/project/team/channel/user), tools, last heartbeat
   - Worker detail with policy viewer (three-layer: local hard × cloud × actor), tool bindings, activity log
   - Register new worker flow (shows CLI command to run on target machine)
5. **Agent Designer** — enhanced version:
   - Trigger configuration step (pick trigger type, configure cron/webhook/event)
   - Tool selection with temporary context preview
   - Skill assignment with dependency check
   - Budget configuration (iterations: 12, tool calls: 20, tokens: 50000, cost: 50 cents — spec defaults)
   - Dry-run test button (simulated)
6. **Workflow Builder** (read-only stub):
   - Render at least 3 example workflows: sequential steps, fork/join parallel, condition branch
   - Show all node types: Trigger, Agent, Tool, Router, Fork, Join, Human Input
   - Trigger config node, condition editor skeleton, step config panel skeleton
   - Validates the visual language — not functional yet

**Permissions UX to model from the start:**

- transparent management view for actors with `manage`
- black-box invocation view for actors with `invoke` but not `inspect`
- internal logs/steps panel visible only with `inspect`
- final output always visible to invokers

**Mock data provider pattern:**

```typescript
// src/facades/agents/mock-data.ts
export const MOCK_AGENTS: AgentRecord[] = [
  {
    id: 'agent_orchestrator_001',
    name: 'Project Orchestrator',
    role: 'orchestrator',
    status: 'idle',
    triggerSummary: { type: 'on-demand' },
    triggers: [],
    // ... full record
  },
  {
    id: 'agent_morning_digest',
    name: 'Morning Digest',
    role: 'researcher',
    status: 'idle',
    triggerSummary: { type: 'scheduled' },
    triggers: [{
      type: 'scheduled',
      config: {
        cron: '0 9 * * 1-5',
        timezone: 'Europe/London',
        input: { prompt: 'Generate the daily standup digest.' }
      }
    }],
    nextRunAt: '2026-04-10T09:00:00Z',
    // ...
  },
  {
    id: 'agent_deploy_watcher',
    name: 'Deploy Watcher',
    role: 'watcher',
    status: 'idle',
    triggerSummary: { type: 'webhook' },
    triggers: [{
      type: 'webhook',
      config: {
        secret: 'whsec_mock_xxx',
        input_mapping: { repo: '$.repository.full_name', branch: '$.ref' },
        allowed_ips: ['140.82.112.0/20']
      }
    }],
    // ...
  },
  {
    id: 'agent_review_reactor',
    name: 'Review Reactor',
    role: 'reviewer',
    status: 'idle',
    triggerSummary: { type: 'event' },
    triggers: [{
      type: 'event',
      config: {
        events: ['task.review_passed'],
        filter: { project_id: 'proj_mock_001' }
      }
    }],
    // ...
  },
  {
    id: 'agent_health_checker',
    name: 'Health Checker',
    role: 'watcher',
    status: 'busy',
    triggerSummary: { type: 'interval' },
    triggers: [{
      type: 'interval',
      config: { interval_minutes: 15, input: { prompt: 'Check all services.' } }
    }],
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
- `src/facades/triggers/hooks.ts` + `mock-data.ts` + `types.ts`
- `src/facades/resources/hooks.ts` + `mock-data.ts`
- `src/facades/runs/mock-data.ts` (extend existing)
- `src/facades/skills/hooks.ts` + `mock-data.ts`
- `src/facades/evaluations/hooks.ts` + `mock-data.ts`

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
3. **Event triggers agent** — Review Reactor shows subscribed events in the event subscription editor, simulate `task.review_passed` event, agent wakes with event payload visible in run history, processes, returns to idle
4. **Agent spawns sub-agent** — Orchestrator delegates to Builder, sub-agent tree updates in real time, parent shows "waiting for child"
5. **Agent uses tools with temporary context** — Agent loads tools into temporary context (visible in activity panel as "Loaded Context" section), executes, calls `drop_context`, context section disappears
6. **Remote worker comes online** — Resources page shows worker transitioning from offline → active, tools become available, three-layer policy viewer shows local + cloud intersection
7. **Trigger paused/resumed** — Toggle trigger on Health Checker, next-run countdown disappears/reappears
8. **Agent designer creates a scheduled agent** — Walk through trigger configuration step: pick "scheduled", enter cron expression, see human-readable preview and next-5-runs, configure budget, save

### Exit criteria

- All 6 pages render with mock data
- All 8 scenarios are click-through-able
- `pnpm --filter @nessie/admin build` passes
- Lint and typecheck pass
- Playwright visual verification of every page
- Mock → real facade swap requires zero component changes (verified by grep: no mock imports outside `**/mock-data.ts`)

---

## Agent Phase 1: Agentic Loop + Cost Ledger

### Goal

Replace single-shot keyword-based tool execution with a real perceive-think-act loop. Add persistent cost tracking from day one.

### Why This Phase

Everything else depends on this. Without the agentic loop, agents can't plan, can't self-correct, can't use tools dynamically, and can't manage temporary context.

### Scope

- **Worker rewrite**: Replace `executeSafeTool()` keyword dispatch with model-driven tool calling
- **Multi-step loop**: Agent can call tools, observe results, call more tools, then respond
- **Budget enforcement**: From the-agents.md § 4 defaults — `maxIterations: 12`, `maxToolCalls: 20`, `maxTokens: 50000`, `maxWallclockMs: 90000`, `maxCostCents: 50`. Defaults come from role policy, overridable per agent/plan.
- **Model usage ledger**: `token_ledger` table/view (see token-ledger-spec.md and the-agents.md § 16) — every LLM call writes token counts and normalized cost. `maxCostCents` enforcement reads from ledger, not in-memory counters.
- **Cost source of truth rule**:
  - model-only work is budgeted from `token_ledger`
  - environment/runtime infrastructure is budgeted from `execution_usage_ledger`
  - mixed run/workflow/plugin totals come from reporting views that join both ledgers
- **Budget/reaper threshold invariant**: Document and enforce `maxWallclockMs (90s) < stale_run_reap (120s) < worker_offline (180s)`. Per-agent budget overrides must not exceed stale_run_reap without adjusting reaper.
- **Streaming**: Tool calls and results stream to the UI via WebSocket in real time
- **Safe tools only**: Same tool set as current implementation (web_search, document_read, web_fetch) — no new tools added until the tool registry is live in Main Phase 3.
- **Tool call auditing**: Every tool call → `ToolCall` record with timing, input, output, cost

### Backend work

1. Worker `executeRunJob` rewritten with agentic loop:
   ```
   while (iterations < budget.maxIterations && toolCalls < budget.maxToolCalls) {
     if (tokensUsed >= budget.maxTokens) break
     if (costCents >= budget.maxCostCents) break   // reads from token_ledger reporting view
     if (elapsed >= budget.maxWallclockMs) break
     response = await llm.chat(messages, { tools })
     writeCostLedgerRow(run, response.usage)        // persist immediately
     if (response.stop_reason === 'end_turn') break
     for (tool_call of response.tool_calls) {
       result = await executeTool(tool_call)
       messages.push(tool_call_result)
       emit('agent.tool.end', { tool: tool_call.name, result })
       toolCalls++
     }
     iterations++
   }
   ```
2. **Prisma migration**: model usage ledger tables/views per token-ledger-spec.md, with run/agent attribution exposed through a reporting view consumed by budgets and admin UI
3. Budget enforcement checks all 5 dimensions before each iteration
4. Tool call records written per call (not per run)
5. WebSocket events: `agent.tool.start`, `agent.tool.end`, `agent.iteration`
6. Cost reporting view: per-agent daily/monthly rollups and mixed-cost totals query

### Admin UI work

- Replace Phase 0 mock data with real API calls (facade swap: `USE_MOCK=false`)
- Tool execution log shows real tool calls streaming in
- Iteration counter visible in agent activity panel
- Budget usage bar showing all 5 dimensions (tokens/cost/iterations/tool calls/wallclock used vs limit)
- Cost summary on run detail page (tokens, cost, breakdown by operation)

### Testable outcome

- Create an agent in the UI
- Ask it a question requiring web search
- Watch it: think → call web_search → observe results → think again → synthesize answer
- See tool calls streaming in the activity panel
- Budget bar shows all 5 dimensions updating in real time
- Model usage row visible in DB/reporting view for the run
- Set `maxIterations: 2` on an agent, ask a complex question → agent terminates at budget with explanation

### Exit criteria

- Agentic loop executes multi-step tool sequences (verified: 3+ iterations in a single run)
- Budget enforcement stops runaway agents on all 5 dimensions
- Token ledger rows written for every LLM call (verified: row count = iteration count)
- Tool calls audited in DB and visible in UI
- WebSocket streams tool activity in real time (verified: `agent.tool.start` and `agent.tool.end` events)
- Budget/reaper invariant documented and enforced
- `worker/` lint, typecheck, build pass
- Playwright verification of tool execution in UI

---

## Agent Phase 2: Trigger System + Scheduler Service

### Goal

Agents activate automatically — on schedule, via webhook, or in response to internal events. Not just when someone sends them a message.

### Scope

- **Scheduler service**: Background process evaluating cron/interval triggers (see the-agents.md § 17)
- **Webhook ingest**: `POST /api/webhooks/{webhook_id}` with HMAC verification, IP allowlisting, rate limiting
- **Event bus**: `pg_notify` based event routing with agent subscription matching
- **Trigger API**: Full CRUD for trigger configuration, pause/resume, history
- **Trigger DB**: `agent_triggers`, `agent_trigger_deliveries`, `agent_webhooks`, `resource_scope_bindings` tables
- **Trigger ownership model**: Triggers are first-class records linked to agents, with one home scope plus optional additional scope bindings
- **Manual run rule**: manual execution is run creation on the executable object, not a trigger mutation

### Backend work

1. **Prisma migration**: Create first-class trigger tables instead of embedding trigger config on `agents`. Create `agent_triggers`, `agent_trigger_deliveries`, `agent_webhooks`, and `resource_scope_bindings`. `agent_triggers` includes `agent_id`, `scope_type`, `scope_id`, `trigger_type`, `enabled`, `config`, `last_fired_at`, `next_run_at`, and audit fields. Trigger payloads and outcomes are recorded in `agent_trigger_deliveries`.
2. **Scheduler service** (`worker/src/scheduler/`):
   - 15-second evaluation loop
   - `pg_advisory_lock` for leader election in multi-instance deployments
   - Cron expression parsing (5-field + timezone, handles DST transitions)
   - Concurrency guard (skip if agent already has active run, log with `status: skipped`)
   - 10-consecutive-failure auto-disable with alert
3. **Webhook handler** (`api/src/routes/webhooks.ts`):
   - HMAC-SHA256 signature verification (constant-time compare)
   - IP allowlist check against CIDR ranges
   - Input mapping via JSONPath expressions
   - Rate limit: 60/min per webhook, 429 with Retry-After
   - Replay protection: `X-Nessie-Delivery` header, 24h dedup window, 409 on duplicate
4. **Event router** (hosted in scheduler service):
   - Dedicated DB connection subscribing to `pg_notify('agent_events')`
   - Reconnection logic on connection drop (pg_notify doesn't survive connection loss)
   - Match incoming events against `agent_triggers WHERE trigger_type = 'event' AND enabled = true`
   - Evaluate filter predicates (project_id, agent_id, etc.)
   - Create runs for matching agents with event payload as input
   - Same concurrency guard as scheduler — skip if agent already running
5. **Trigger API endpoints** (all from the-agents.md § 17):
   - `POST /api/agents/{id}/runs` for manual execution
   - `POST/GET /api/agents/{id}/triggers`
   - `PUT/DELETE /api/triggers/{id}`
   - `POST /api/triggers/{id}/pause`, `POST /api/triggers/{id}/resume`
   - `GET /api/triggers/{id}/history`
   - `POST /api/webhooks` (returns secret ONCE), `GET/DELETE /api/webhooks/{id}`, `POST /api/webhooks/{id}/rotate`
   - `GET /api/triggers/scheduled`, `GET /api/triggers/upcoming`
6. **MCP tools**: `set_trigger`, `pause_trigger`, `resume_trigger`, `trigger_agent`, `list_scheduled`

> **Scope note:** This phase covers the agent-level trigger system. The conversation-intelligence platform's normalized event pipeline (durable `conversation_events`, identity resolution, workflow triggers) is a separate workstream that builds on top of this event bus. It is explicitly out of scope here and will be addressed when the conversation-intelligence platform phases are planned.

### Admin UI work

- Wire Trigger Management page to real API (replace mocks)
- Wire Agent Detail → Trigger tab to real API
- Webhook URL display with copy button and "rotate secret" action
- Cron expression editor with human-readable preview and next-5-runs display
- Event subscription picker (checkboxes from event taxonomy in the-agents.md § 17)
- Trigger history table with status badges (fired/skipped/failed) and run links
- "Trigger Now" button on any agent

### Testable outcome

- Create an agent, then `POST /api/agents/{id}/triggers` with `{ "type": "scheduled", "config": { "cron": "*/2 * * * *" } }`
- Watch it fire automatically, see run in history with `trigger_source: scheduler`
- Create a webhook agent, `curl -X POST /api/webhooks/{id} -H "X-Nessie-Signature: sha256=..." -d '{"ref":"main"}'`
- Watch it create a run from the webhook payload, input_mapping applied
- Create an event agent subscribing to `task.completed`
- Complete a task → `agent_trigger_deliveries` row with `status: fired`, run created
- Pause the scheduled agent → next-run countdown disappears, scheduler skips it
- Resume → countdown reappears, next fire on schedule
- Verify: `SELECT * FROM agent_trigger_deliveries WHERE agent_id = '...' ORDER BY fired_at DESC` shows complete history

### Exit criteria

- Scheduler fires cron/interval agents within 15s of scheduled time
- Webhooks: valid signature → 202, bad signature → 401, duplicate delivery → 409, rate exceeded → 429
- Events trigger subscribed agents (verified: event emitted → `agent_trigger_deliveries` row → run created)
- Pause/resume toggles work and persist across scheduler restarts
- pg_notify subscriber reconnects after connection drop (verified: kill connection, observe reconnect in logs)
- Trigger history visible in admin with all status types
- All endpoints pass lint, typecheck, build
- Playwright verification of trigger management UI

---

## Agent Phase 3: Plans + Inter-Agent Communication + Resource Locks

### Goal

Agents coordinate through structured plans, communicate via a reliable mailbox, and safely share file resources.

### Scope

- **Plan model** (the-agents.md § 9): Structured goal decomposition with the full step taxonomy
- **Agent mailbox** (the-agents.md § 8): DB-backed message bus with at-least-once delivery
- **Resource locks** (the-agents.md § 16): Advisory locks for concurrent multi-agent file access
- **Orchestrator enhancement**: Factor in agent status, cost awareness, skill matching, plan context when routing

### Backend work

1. **Prisma migration**: `plans`, `plan_steps`, `agent_mailbox`, `agent_mailbox_dlq`, `resource_locks` tables
2. **Plan service** (`api/src/services/plans.ts`):
   - Plan CRUD with step dependency resolution
   - **Full step taxonomy**: `tool_call`, `spawn_task`, `code_change`, `message`, `wait`, `approval_required`, `human_input` (from the-agents.md § 9 and agent-base-template.md)
   - Step execution dispatch per type
   - Recovery semantics: retry (with backoff), skip (with justification), abort (with compensation)
   - Artifact tracking per step (file paths, URLs, tool outputs)
   - Plan resume from last incomplete step
   - Status aggregation: plan complete when all required steps complete
   - Parallel step execution (Fork/Join patterns)
3. **Mailbox service** (`api/src/services/mailbox.ts`):
   - At-least-once delivery with idempotency (correlation_id dedup)
   - Visibility timeout: 60s → return to queued for retry
   - Max 3 retries with exponential backoff (10s, 30s, 60s)
   - Dead-letter queue after exhaustion
   - Plan-ordered delivery within plan_id + step_id
   - Broadcast: `to_agent_id = NULL` + `channel_id` → fan-out
   - Transactional coupling: plan step transitions and mailbox writes in same DB transaction
4. **Resource locks** (`api/src/services/resource-locks.ts`):
   - `resource_locks` table: resource_path, agent_id, lock_type (exclusive/shared), acquired_at, expires_at
   - Lock acquisition before file write, release on step completion or 60s timeout
   - Conflict detection: second writer sees lock → escalate to human or wait
   - Plan-level write sets: plans declare expected write targets upfront, orchestrator prevents concurrent plans with overlapping write sets
   - External resource locks (deploys, migrations): same table, longer timeouts
5. **Orchestrator enhancement** (`api/src/services/orchestrator.ts`):
   - Route based on agent status (don't route to busy/error agents)
   - Cost awareness: cheaper model for simple tasks
   - Plan context: if a plan is active, route to plan-assigned agent
   - Skill matching: consider agent's skill set when routing

### Admin UI work

- Agent Detail → Plans tab: active and completed plans with step graph visualization
- Plan step graph: dependency arrows, status colors per step, step type icons
- Plan step detail: artifacts, recovery actions taken, timestamps
- Mailbox viewer: pending/delivered/processed messages per agent
- Cross-agent activity trace: follow a plan across multiple agents with timeline view
- Resource lock indicator on file-related steps

### Testable outcome

- Create an orchestrator with two child agents (builder + reviewer)
- Send "Implement feature X and review it"
- Orchestrator creates a plan with steps: `code_change` (builder) → `message` (handoff) → `tool_call` (reviewer reviews)
- Builder receives delegation via mailbox, does work, artifacts tracked
- Reviewer receives handoff via mailbox, reviews code
- Plan completes, orchestrator synthesizes result
- Force a step failure → retry fires, step recovers
- Two agents attempt same file → resource lock prevents conflict, second agent waits
- Verify: `SELECT * FROM plans WHERE id = '...'` shows full step graph with statuses

### Exit criteria

- Plans decompose goals into steps using all 7 step types
- Step dependencies enforce execution order (verified: step B doesn't start until step A completes)
- Recovery: retry/skip/abort work correctly (verified: inject failure, observe retry)
- Mailbox: at-least-once delivery (verified: kill worker mid-delivery, observe retry)
- Dead-letter queue catches permanently failed messages
- Resource locks prevent concurrent file mutations (verified: two agents, same file, lock holds)
- Cross-agent plan traces visible in UI
- Lint, typecheck, build pass

---

## Agent Phase 4: Evaluation + Reflection

### Goal

Agents evaluate their own work and learn from failures. This is a prerequisite for skills — without evaluation, promoted procedures have no quality signal.

### Scope

- **Evaluation loop** (the-agents.md § 10): Post-run quality checks
- **Unified evaluations table**: All evaluation types write to one table with distinct `kind` values
- **Reflection**: Root cause analysis of failures, stored and linked to procedural memories

### Backend work

1. **Prisma migration**: `evaluations` table with `kind` ENUM (`policy_check`, `self_eval`, `critic_llm`, `human_review`, `reflection`, `unit_test`, `integration_test`)
2. **Evaluation service** (`worker/src/evaluation/`):
   - **Policy check** (`kind: policy_check`): Did the agent violate tool policy, budget constraints, or approval gates? Deterministic, runs on every completed run.
   - **Self-eval** (`kind: self_eval`): Agent rates its own output on a structured rubric (completeness, correctness, relevance). Runs on every completed run. Writes score + reasoning to evaluations table.
   - **Fast critic** (`kind: critic_llm`): Separate cheap LLM evaluates output quality against the original request. Runs on runs with cost > threshold.
   - **Human review** (`kind: human_review`): Approval gate for high-stakes outputs. Status: pending → approved/rejected.
3. **Reflection service**:
   - On failed runs or low self-eval scores: agent performs root cause analysis
   - Produces structured reflection: what went wrong, proposed fix, confidence
   - Stored as `kind: reflection` in evaluations table, linked to run_id
   - Reflections feed into procedural memory (Phase 6)
4. **Evaluation hooks**: After every run completion, evaluation pipeline fires automatically:
   ```
   Run completes → policy_check (always) → self_eval (always) → critic_llm (if cost > threshold) → reflection (if failed or low score)
   ```

### Admin UI work

- Agent Detail → Evaluations tab: per-run evaluation rows showing all kinds
- Run detail page: evaluation section with scores, policy violations, reflections
- Aggregate evaluation dashboard: agent success rate, average self-eval score, policy violation frequency
- Reflection browser: searchable list of reflections with proposed fixes

### Testable outcome

- Agent completes a run → evaluations table has `policy_check` + `self_eval` rows
- Agent fails (budget exceeded) → reflection row with root cause analysis
- Agent violates tool policy (attempts denied tool) → `policy_check` evaluation with violation details
- UI shows all evaluation rows on run detail page
- Verify: `SELECT kind, score, reasoning FROM evaluations WHERE run_id = '...'` shows structured output

### Exit criteria

- Every completed run has at least 2 evaluation rows (policy_check + self_eval)
- Policy violations detected and flagged (verified: agent attempts Bash with Bash:false, evaluation catches it)
- Reflections generated for failures with actionable root cause
- All evaluations write to unified table with correct `kind` values
- Evaluation scores are numeric and comparable across runs
- Lint, typecheck, build pass

---

## Agent Phase 5: Tool Registry + Temporary Context + Companion Skills

### Goal

Dynamic tool loading. Agents discover, load, and unload tools on demand through the capability directory and resolver sub-agent.

### Hard prerequisites (from Main Phase 3)

This phase cannot start until the following are delivered by Main Phase 3:
- `ToolRegistryEntry` CRUD service with search, tags, risk classification, versioning
- `ToolGrant` service with role-based and agent-override grants, effective grant resolution
- `SecretRecord` service with envelope encryption, `SecretBinding` access control
- OpenAPI auto-import: `POST /api/connectors/import-openapi` (probe spec paths, parse, generate endpoints, admin review)

### Scope

- **Capability directory**: Compact index of all registry entries (~50 tokens per 5 capabilities) living in permanent context
- **Resolver sub-agent**: Cheapest LLM selects tools based on user intent
- **Temporary context**: Array of loaded tool schemas on the main agent's context
- **`resolve_capability` / `drop_context` tools**: Agent-controlled lifecycle
- **Companion skills**: Per-capability instructions/tips loaded alongside tool schemas
- **Credential injection**: `{{secret:ref_name}}` placeholders resolved at runtime

### Backend work

1. **Capability directory** (`packages/capabilities/`):
   - Built by indexing all `ToolRegistryEntry` records with their category, description, and required credentials
   - Compact format: `name | description | required_tools` (~50 tokens per entry, per external-tool-integration.md § 5)
   - Lives in permanent context, updated on registry changes
   - Searchable by name, category, or natural language description
2. **Resolver service** (`worker/src/resolver/`):
   - Takes user message + capability directory index
   - Returns selected tool schemas + companion skill (if any)
   - **Constraints**: Cheapest available model (e.g., Haiku), single pass, ≤500 output tokens, 5s timeout, stateless and discarded after each selection
   - **Resolver prompt template**: System prompt instructing selection based on user intent, tool descriptions, and current loaded context
   - **Output schema**: `{ selectedCapabilities: [{ name, toolSchemas, companionSkill? }] }`
   - Deterministic cache: hash of (user_message_intent + loaded_context_ids) → resolution result, 5-minute TTL
3. **Temporary context management**:
   - `resolve_capability` permanent tool on all agents: loads selected tool schemas into temporary context array
   - `drop_context` permanent tool on all agents: agent unloads tools by capability name
   - Context budget: max 10 loaded capability sections per agent
   - Turn preamble injected every turn: "You have N capability sections loaded: [names]. Call drop_context for any you no longer need."
4. **Companion skills** (`packages/capabilities/companion-skills/`):
   - Per MCP server / API connector: instructions on how to use the capability effectively
   - Format: tips, common patterns, gotchas, example sequences
   - Created on connector installation, refined via procedural memory (Phase 6)
   - Loaded into temporary context alongside tool schemas when capability is resolved
5. **Credential injection**:
   - Tool schemas contain `{{secret:ref_name}}` placeholders
   - On `resolve_capability`, required secrets resolved from `SecretRecord` via `SecretBinding`
   - Resolved values injected into tool runtime config (not visible to agent LLM context)
   - Missing credentials → resolve fails with clear error naming the missing secret

### Admin UI work

- Agent Detail → Activity tab shows temporary context loads/drops in real time
- "Loaded Context" panel on agent detail: currently loaded capability sections with tool count
- Capability browser: searchable index of all available capabilities with install status
- Companion skill editor: view/edit tips per capability

### Testable outcome

- Ask an agent "What's the weather in London?"
- Resolver selects weather API capability, returns tool schemas
- Capability loads into temporary context (visible in UI as "Loaded Context: Weather API [3 tools]")
- Agent calls weather tool, credential injected from secret vault, gets result
- Agent calls `drop_context("Weather API")`
- UI shows context section removed
- Next message about code → resolver selects different capability, loads new context
- Verify: temporary context never exceeds 10 sections (send 12 different requests, observe eviction)

### Exit criteria

- Capability directory indexes all registry entries (verified: `ToolRegistryEntry` count = directory entry count)
- Resolver selects appropriate capabilities (verified: 10 diverse requests, correct selection ≥ 80%)
- Temporary context loads within 2s (resolver + schema fetch)
- `drop_context` removes exactly the named section (verified: 3 loaded, drop 1, 2 remain)
- Credential injection works without exposing secrets (verified: agent context dump contains no secret values)
- Companion skills load alongside tool schemas (verified: resolver response includes `companionSkill`)
- Context budget enforced at 10 sections
- Turn hygiene preamble fires every turn (verified: system prompt contains loaded context list)
- Lint, typecheck, build pass

---

## Agent Phase 6: Skills + Security Pipeline + Memory Integration

### Goal

Skills as first-class capabilities with a full security verification pipeline. Procedural memory feeds skill promotion.

### Scope

- **Skill system** (skills.md): Full lifecycle — creation, versioning, security verification, assignment, execution
- **Security verification pipeline** (skills.md § 3): 4-stage scan on every skill
- **Procedural memory capture**: Auto-extract step sequences from successful runs
- **Framing memory capture**: Cold-start elimination
- **Skill promotion**: Procedures → skills with tests
- **Memory schema extensions**: `memory_type` enum extension, `thought_artifacts`, `thought_sources` tables

### Backend work

1. **Prisma migration**:
   - Extend `memory_type` enum with `procedure`, `framing`, `experience`
   - Create `thought_artifacts` table (artifact-linked reasoning)
   - Create `thought_sources` table (memory → source attribution: messages, tool calls, files)
   - Skill tables: `skills`, `skill_versions`, `skill_grants`, `skill_assignments`, `skill_security_scans`
2. **4-stage security verification pipeline** (`worker/src/skills/security/`):
   - **Stage 1 — Static analysis**: Scan skill instructions for injection patterns, exfiltration signals, obfuscation. Deterministic rules.
   - **Stage 2 — LLM analysis**: Holistic risk rating by a security-focused LLM. Prompt + structured output schema: `{ risk_rating, risk_factors[], recommendations[] }`.
   - **Stage 3 — Tool policy verification**: Check that `requiredTools` are within the target agent's grants. Deterministic.
   - **Stage 4 — Behavioral sandbox**: Execute with mock tool implementations (no real side effects). Monitors: tool call adherence (only `requiredTools`?), scope access (within expected scope?), output containing sensitive patterns. Anomalies → `skill_security_scans` finding.
   - **Disposition model**: `auto_approved` (all stages pass), `requires_review` (Stage 2 medium risk or Stage 4 anomaly), `blocked` (Stage 1 or 3 hard failure). Stored in `skill_security_scans`.
3. **Skill lifecycle**:
   - `load_skill` / `unload_skill` tools (parallels `resolve_capability` / `drop_context`)
   - Skill search with Tier 1 (built-in, high trust) / Tier 2 (community, scan required) discovery model
   - Dependency resolution: skill requires other skills or tools → check availability before assignment
   - Scoped sharing: system, organization, project, team, channel, user, plus marketplace/public visibility where applicable
   - Version lifecycle: draft → scanning → active → deprecated → archived
   - Reviews/ratings per skill version
4. **Procedural memory capture** (`worker/src/memory/procedural.ts`):
   - After successful multi-step runs: extract ordered step sequence (tool calls, decisions, outputs)
   - Store as `memory_type: 'procedure'` thought with confidence score
   - Link to `thought_sources` for attribution
5. **Framing memory capture** (`worker/src/memory/framing.ts`):
   - After first successful interaction in a new domain: extract domain framing (key concepts, vocabulary, relationships)
   - Store as `memory_type: 'framing'` thought
   - Used for cold-start elimination when agent encounters the domain again
6. **Skill promotion pipeline**:
   - Trigger: procedure `success_count >= 3` AND `confidence >= 0.7`
   - Convert: `trigger_conditions → inputSchema`, `steps → instructions + planTemplate`, `tools_used → requiredTools`
   - Generate tests from success/failure history
   - Run 4-stage security pipeline
   - If `auto_approved` → skill active. If `requires_review` → queue for human review.
   - Link: `source_thought_id → original procedure`

### Admin UI work

- Skill library browser: search, Tier 1/Tier 2 badges, install/assign actions
- Skill detail page: versions, security scan results, reviews/ratings, dependency graph
- Skill promotion pipeline visualization: procedure → candidate → scanning → tested → active
- Security scan results viewer: 4 stages with pass/fail/findings per stage
- Agent Detail → Skills tab: assigned skills, available skills, promotion candidates
- Agent Detail → Memory tab: thought browser with type filter, source attribution links
- Flagged skills queue (admin): skills awaiting human review after `requires_review` disposition

### Testable outcome

- Agent completes a task type successfully 3 times → procedural memory captured with `thought_sources` links
- Promotion trigger fires → skill candidate created, 4-stage security scan runs
- Stage 1 passes (no injection), Stage 2 passes (low risk), Stage 3 passes (tools available), Stage 4 passes (sandbox clean)
- Skill auto-approved → appears in skill library with `active` status
- Assign skill to another agent → agent can `load_skill` and execute the runbook
- Create a malicious skill with exfiltration pattern → Stage 1 blocks with `disposition: blocked`
- Verify: `SELECT * FROM skill_security_scans WHERE skill_version_id = '...'` shows all 4 stages

### Exit criteria

- Procedural memory captured from successful multi-step runs (verified: 3 runs → procedure thought created)
- Framing memory captured on first domain interaction (verified: new domain → framing thought)
- `thought_artifacts` and `thought_sources` populated (verified: artifact links, source attribution)
- All skills run through 4-stage security pipeline before activation
- `blocked` disposition prevents skill activation (verified: malicious skill → blocked)
- `requires_review` disposition queues for human (verified: medium-risk skill → admin queue)
- Skill assignment with dependency check (verified: missing dependency → assignment rejected)
- `load_skill`/`unload_skill` work (verified: agent loads skill, executes plan template, unloads)
- Lint, typecheck, build pass

---

## Agent Phase 7: Remote Workers + Async Tools

### Goal

Agents execute on remote machines and run long-lived async operations that take hours.

### Scope

- **Remote MCP servers** (external-tool-integration.md § 2): Poll-then-WebSocket protocol, three-layer policy, CLI tool discovery
- **`nessie-agent` CLI**: Register, run, install-service commands
- **Resources admin page**: Worker list with status, scope, tools, policy
- **Async tools** (external-tool-integration.md § 1.1): Long-running operations with progress streaming, provider vetting
- **Custom HTML output**: Allowlisted rendering with sanitization pipeline

### Backend work

**Step 0 — Registration API + CLI bootstrap:**
1. Admin creates remote MCP server record → gets bootstrap token
2. `nessie-agent register --token <bootstrap_token>` → CLI exchanges token for worker-scoped API key
3. `POST /api/remote-workers` (admin creates record), `POST /api/remote-workers/{id}/register` (CLI exchanges token)
4. `nessie-agent.yaml` config: instance URL, worker ID, API key, tool discovery settings

**Step 1 — Heartbeat + WebSocket protocol:**
1. `protocol: "remote"` on `mcp_server_instances`
2. **Idle mode**: `POST /api/remote-workers/{id}/heartbeat` every 60s, response includes `work_pending: boolean`
3. **Active mode**: When `work_pending: true`, CLI opens `GET /api/remote-workers/{id}/ws?ticket=<one-time-ticket>` WebSocket
4. Tool calls dispatched over WebSocket, results returned
5. WebSocket closed when no more pending work → back to HTTP heartbeat
6. Worker marked offline after 180s with no heartbeat (3 missed)
7. Remote worker status ENUM: `active, idle, busy, draining, paused, error, pending_setup, pending_approval, offline, revoked`
8. Lifecycle diagram for remote workers added to external-tool-integration.md (resolves validation issue #1)

**Step 2 — Policy sync + tool discovery:**
1. `GET /api/remote-workers/{id}/policy` — worker fetches effective policy on startup and periodically
2. Three-layer policy intersection: local hard policy (machine owner, immutable) × cloud policy (Nessie admin, can only narrow) × actor context (runtime). Any layer deny = denied.
3. `POST /api/remote-workers/{id}/tools` — worker reports discovered local tools (shell, file, process, SSH, MCP proxy, CLI wrappers)
4. `POST /api/remote-workers/{id}/drain` — graceful shutdown: finish current work, accept no new
5. `POST /api/remote-workers/{id}/revoke` — immediate disable

**Step 3 — `nessie-agent` CLI** (`cli/nessie-agent/`):
1. `nessie-agent register --token <token>` — register with Nessie instance
2. `nessie-agent run` — start worker loop (heartbeat → WebSocket → execute)
3. `nessie-agent install-service` — install as system service (launchd on macOS, systemd on Linux)
4. Local tool discovery: enumerate available tools on the machine
5. `nessie-agent status` — show current status, loaded tools, policy

**Step 4 — Async tool framework:**
1. **Prisma migration**: `async_jobs` table (id, agent_id, run_id, tool_name, status, progress_pct, progress_message, result_summary, result_html, permalink, created_at, updated_at, completed_at)
2. `async_tool_providers` table: provider_name, vetting_status (`pending`, `auto_approved`, `manual_review`, `approved`, `revoked`), allowed_domains, sandbox_level, vetted_by, vetted_at
3. `check_job` + `cancel_job` permanent tools on all agents
4. **Progress streaming**: SSE endpoint `GET /api/jobs/{id}/progress` with events: `{ type: "progress", pct: 45, message: "Analyzing sources..." }`
5. **Summary injection**: On job completion, summary (not full result) injected into agent context
6. **Custom HTML output**: `GET /api/jobs/{id}/html`
   - Allowlisted tags: `div, span, p, h1-h6, ul, ol, li, table, tr, td, th, a, img, code, pre, strong, em`
   - Allowlisted CSS properties: `color, background-color, font-size, font-weight, margin, padding, border, text-align, display, flex, grid`
   - DOMPurify sanitization with allowlist config
   - No JavaScript, no iframes, no external resources except from `allowed_domains` on the provider
7. **Provider vetting process**:
   - Auto checks: static analysis of provider output patterns, domain validation
   - Manual review: required for first-time providers (admin reviews sample outputs)
   - Ongoing monitoring: periodic re-audit per `audit_frequency` on provider record
   - Revocation: admin can revoke at any time → existing jobs continue, new jobs blocked
8. **Async job API**: `GET /api/jobs`, `GET /api/jobs/{id}`, `GET /api/jobs/{id}/html`, `POST /api/jobs/{id}/cancel`

**Step 5 — Resources API:**
1. `GET /api/remote-workers` (list with status, scope, tools)
2. `GET /api/remote-workers/{id}` (detail with policy, bindings, activity)
3. `PATCH /api/remote-workers/{id}` (update scope, bindings)
4. Scope assignment: `system` / organization / project / team / channel / user

### Admin UI work

- Wire Resources page to real API (replace Phase 0 mocks)
- Worker status monitoring with live heartbeat indicator (last heartbeat timestamp, countdown to offline)
- Remote worker registration wizard: create → copy token → show CLI command
- Three-layer policy viewer per worker (local hard, cloud, effective intersection)
- Async job progress cards in chat (progress bar, message, estimated completion)
- Custom HTML result rendering (sanitized, inline in chat)
- Async provider management page (admin): vetting queue, approved providers, revocation

### Testable outcome

- Install `nessie-agent` on a second machine, `nessie-agent register --token xxx`
- Worker appears in Resources page with `pending_setup` → `active` status transition
- Worker reports local tools → visible in worker detail
- Bind a remote tool to an agent, send a message requiring that tool
- Agent uses the remote tool → execution happens on remote machine via WebSocket
- Start an async deep-research job → progress streams to chat as progress cards
- Job completes → rich HTML result rendered inline (sanitized)
- Submit a new async provider → vetting queue shows it as `pending`
- Approve provider → `approved`, jobs from this provider render HTML
- Revoke provider → existing jobs unaffected, new jobs blocked
- Drain a worker → finishes current work, goes to `draining` status, then `offline`

### Exit criteria

- Remote workers register, heartbeat, execute tools over WebSocket (verified: end-to-end remote tool call)
- Poll-then-WebSocket model works (verified: idle = HTTP heartbeat only, active = WebSocket)
- Three-layer policy enforced (verified: local deny + cloud allow = denied)
- Worker offline detection works (verified: stop heartbeat → 180s → `offline`)
- Async jobs stream progress (verified: SSE events received by client)
- Custom HTML renders safely (verified: inject `<script>` tag → DOMPurify strips it)
- Provider vetting prevents unapproved HTML (verified: unapproved provider → HTML not rendered)
- CLI installs as system service on macOS and Linux
- Lint, typecheck, build pass

---

## Agent Phase 8: Marketplace + Agent Builder + Workflow Templates

### Goal

Everything is discoverable, installable, and composable through a unified marketplace. Agents can create other agents.

### Scope

- **Marketplace** (marketplace.md): Unified catalog with tabs for MCP servers, API connectors, skills, workflow templates, and generated plugins
- **Library** (marketplace.md § 5): Installed items management with scope
- **Capability assignments** (marketplace.md § 5): Explicit assignment of capabilities to agents
- **Agent builder** (the-agents.md § 15): Full builder workflow with templates, dry-run, approval
- **Agent versioning**: Immutable config history with rollback
- **Workflow template engine**: Graph execution, trigger binding
- **Execution environments**: Workflow-managed local, container, and cloud coding environments for triage/build/fix jobs
- **Generated plugins**: Agent-authored, reviewed, sandboxed connector/plugin packages with optional UI
- **OpenAPI auto-import**: Probe + parse + generate endpoint definitions for API connectors

### Backend work

**Marketplace:**
1. **MCP server marketplace**: `mcp_catalog` table, browse/search, install flow (MCP server → registry entries → tool discovery → admin approval), update/uninstall
2. **API connector marketplace**: Browse, install, OpenAPI auto-import (`POST /api/connectors/import-openapi` — probe common spec paths, parse, auto-generate endpoint definitions, present for admin review, enable/disable per endpoint, risk classification)
3. **Skill marketplace**: Browse, install with security scan, reviews/ratings per version
4. **Workflow template marketplace**: Browse, install with dependency resolution
5. **Generated plugin marketplace**: Create from template, build/test in coding environment, submit for review, publish to library after approval
6. **Library service** (`api/src/services/library.ts`):
   - `library_items` table: what's installed, home scope (`system` / organization / project / team / channel / user), status, installed_by, installed_at
   - Install-to-library flow: marketplace item → security scan → library item → available for assignment
   - Scope management: home scope + additional scope bindings with audit trail
7. **Capability assignment service**:
   - `capability_assignments` table: library_item_id → agent_id, with `enabled_tools` array
   - Agent capabilities view: all assigned capabilities with enabled/disabled tools
   - Assignment API: `POST /api/agents/{id}/capabilities`, `GET /api/agents/{id}/capabilities`
8. **Generated plugin lifecycle**:
   - `generated_plugins`, `generated_plugin_versions`, `plugin_reviews` tables
   - `plugin_templates` table for platform-owned starter templates
   - lifecycle states: `draft`, `testing`, `private_sandbox`, `shared_unreviewed`, `pending_review`, `changes_requested`, `approved`, `published`, `revoked`
   - review is per version, not per plugin name
   - approval split into distribution approval and runtime approval
   - creator feedback loop uses Nessie channel/DM thread, not external tools
9. **Plugin runtime enforcement**:
   - generated plugins never run in-process with API/worker/realtime
   - separate runner process/container/microVM per execution
   - read-only rootfs + scratch-only write dir + plugin-scoped storage
   - outbound network deny-by-default + domain allowlist
   - brokered runtime API only: no direct DB creds, no direct internal service creds
   - secret refs resolved at execution time with least-privilege bindings only
10. **Execution environment tracking and billing**:
   - `execution_environment_templates`, `execution_environment_instances`, `execution_usage_ledger` tables
   - `execution_runners` and `execution_leases` tables for runner registration, capability matching, artifact retrieval, and short-lived execution authorization
   - every launch records template, provider instance ref, triggering actor, run/workflow/plugin attribution, and lifecycle timestamps
   - ledger records raw usage meters plus normalized cost for per-minute/per-second/provider-specific billing
   - reporting slices by organization/project/team/channel/user/agent/workflow/plugin version
   - template pricing metadata stored centrally, not duplicated in workflow/plugin configs
   - Phase 8 supported providers are `docker` and `gcloud` only; other providers remain future work
11. **Plugin builder system**:
   - platform-owned template catalog: OAuth connector, CLI wrapper, HTML widget, webhook normalizer, custom plugin
   - strict manifest schemas for plugin metadata, config schema, permissions, actions, and UI bridge
   - plugin SDK for brokered actions, OAuth, storage, and iframe bridge messaging
   - deterministic builder tools: `create_from_template`, `validate_manifest`, `run_template_tests`, `package_plugin`, `submit_for_review`
   - reference implementations and golden tests so agents build against known working patterns

**Agent builder:**
1. **Prisma migration**: `agent_templates` table (from the-agents.md § 15), `agent_config_versions` table
2. **Agent builder workflow service** (`api/src/services/agent-builder.ts`):
   - 9-step workflow per the-agents.md § 15:
     1. Input validation against `AgentCreationSchema`
     2. Template selection (optional)
     3. System prompt generation or validation
     4. Role assignment + tool policy resolution
     5. Budget validation against organization limits
     6. Scope validation (`system` / organization / project / team / channel / user placement)
     7. Dry-run test execution (simulated run with mock input)
     8. Approval submission (for agents with privileged tools)
     9. Creation + initial config version
   - **Agent templates** CRUD: pre-built starting points with role, prompt, tools, budget
   - **Meta-tools** for agent-managed creation: `create_agent`, `propose_config_change`, `rollback_agent_config`
3. **Config versioning**:
   - Every config change → immutable `agent_config_versions` row
   - Fields: `system_prompt`, `tool_policy`, `provider`, `model`, `role`, `changed_by` (user or agent), `change_reason`
   - Rollback: update `agents.active_config_version_id` pointer to previous version (metadata operation, no data migration)
   - `GET /api/agents/{id}/versions`, `POST /api/agents/{id}/versions/{versionId}/rollback`

**Workflow templates:**
1. `workflow_templates` table with `graph_json`, `triggers_json`, `variable_schema`, `binding_schema`, `required_environment_templates`
2. `workflow_installations` table holding install-time scope, resolved bindings, activation state, and config
3. `workflow_triggers` table for materialized event/schedule bindings generated from `triggers_json` for each active installation
   - in this plan, `triggers_json` is the authored source-of-truth on the template
   - `workflow_triggers` are runtime rows materialized from that source on install/activation
   - the Phase 2 trigger engine evaluates these rows too; there is not a second independent trigger engine
4. Step types: `skill`, `agent_task`, `action`, `condition`, `wait` (from marketplace.md § 8); these are orchestration-layer step kinds that compile to lower-level run/plan operations
5. Typed variable resolution on install: repos, connectors, channels, environment templates, secret refs selected from already-visible resources, not arbitrary free text
6. Execution environment actions: launch ephemeral VM/container/workspace, attach secret refs, expose terminal/xterm session where allowed, teardown on completion/TTL
7. Dependency resolution on install
8. Compensation steps for failure handling
9. Workflow API: `POST /api/workflows`, `GET /api/workflows`, `POST /api/workflows/{id}/install`, `GET /api/workflow-installations/{id}/runs`, `POST /api/workflow-installations/{id}/run`
10. `invoke_workflow` MCP tool
11. `workflow_runs` table as the canonical workflow execution record
12. `workflow_step_runs` table for per-step execution state, retries, intermediate outputs, and environment/tool references
13. Link `workflow_runs` to workflow installation, trigger source/delivery, and any parent task/plan/run where execution is nested
14. Black-box workflow invocation model:
   - `invoke` returns final output and sanitized terminal state
   - `inspect` gates internal step visibility, logs, and intermediate state
   - `manage` gates bindings, triggers, scope, and activation
15. Installation versioning/materialization rule:
   - installations pin to a workflow template version
   - trigger materialization is regenerated only when the installation is explicitly upgraded or reactivated against a new template version
   - past runs remain linked to the installation version that produced them
16. Step compilation map must be documented and implemented:
   - `skill` -> agent run or skill execution record
   - `agent_task` -> task + agent run
   - `action` -> external action record and optionally environment/tool execution
   - `condition` -> workflow step transition record
   - `wait` -> timer/event wait record

**Execution runtime protocol to implement in this phase:**
17. Execution control-plane service is the owner of:
   - runner selection
   - lease issuance
   - environment/job launch requests
   - retry/reassignment after failure
   - final usage recording orchestration
18. Canonical lease lifecycle:
   - request execution
   - select eligible runner
   - issue short-lived lease
   - fetch artifact/policy/bindings
   - launch instance/job
   - heartbeat
   - complete, terminate, or reassign after expiry/failure
19. Failure/retry rules:
   - lease expiry before start -> control plane may reassign
   - artifact fetch failure -> runner marks lease failed, control plane retries or reassigns
   - runner death mid-run -> control plane marks instance stale, attempts safe retry or surfaces terminal failure depending on idempotency
   - final completion is idempotent on `(lease_id, run_id)`
20. Runners own local launch, heartbeat, log streaming, and final usage reporting
21. Artifact storage abstraction must be uniform across hosted and local installs:
   - hosted may use GCS/object storage
   - local installs may use a local adapter implementing the same contract
22. Secret delivery rule:
   - runners receive broker handles or short-lived derived credentials by default
   - direct plaintext injection is allowed only transiently at the final execution boundary when the target process requires env/file materialization
   - long-lived user tokens must not be mounted directly into arbitrary coding environments
23. Plugin execution authorization rule:
   - leases may be issued only for plugin versions in executable states (`approved`/`published`, or `private_sandbox` for creator-only sandbox runs)
   - `runtime_policy` determines eligible runner classes (`sandbox_only`, `reviewed_sandbox`, `reviewed_hardened`, `trusted_internal`)
   - unapproved versions never receive non-sandbox leases

**Cost model to implement in this phase:**
24. `token_ledger` and `execution_usage_ledger` are the only durable cost ledgers
25. Add reporting views/queries that roll mixed model + environment cost up to run, workflow run, plugin version, agent, user, and scope
26. Budget checks on workflow/plugin execution must consult the mixed-cost reporting view, not one ledger in isolation

**Example template to ship in Phase 8:**
1. **GitHub Issue Triage → PR → Customer Follow-Up**
   - Trigger 1: `github.issue.opened` or `github.issue.updated`
   - Triage agent classifies issue, launches disposable coding environment, attempts repro, comments back, applies labels
   - Trigger 2: issue labeled `do-pr`
   - Fix agent launches coding environment, uses assigned repo binding + secret refs, implements fix, runs checks, opens PR
   - Trigger 3: `github.pull_request.merged`
   - Customer-facing agent sends tailored update through configured email/CRM/helpdesk connector
   - Variables are typed selectors, not text:
     - target repo chosen from GitHub repos visible through the installer's assigned GitHub connector
     - coding environment chosen from visible environment templates
     - customer destination chosen from visible CRM/helpdesk resources
     - secret refs attached explicitly to the environment/job binding
   - Durable record chain for implementation:
     - trigger delivery -> workflow_run -> workflow_step_runs
     - agent-task steps -> task + agent run
     - environment launch steps -> execution_environment_instance + execution lease
     - external actions -> auditable action/tool-call records
     - final workflow status -> rolled up from step state plus child run state

### Admin UI work

- **Marketplace browser**: Tabbed view (MCP Servers | API Connectors | Skills | Workflows | Plugins), search, filters, categories
- **Environment template management**: CRUD for execution environment templates, runner capability visibility, scope, pricing metadata, and allowed secret classes
- **Generated plugin builder**: Create from template, generate icon, review manifest/permissions, launch coding environment, submit for review
- **Plugin template catalog**: curated starter templates with examples, expected files, SDK version, and test harness
- **Install flow**: Permission grant review, security scan summary, scope selection
- **Library page**: Installed items with status, scope, update available indicator
- **Plugin review queue**: DevOps/platform reviewer inbox with code snapshot, manifest, requested permissions, diff, and approve/request-changes actions
- **Execution environment usage page**: active environments, launch history, billable duration, cost breakdown, actor attribution
- **Capability assignment matrix**: Agent × capability grid with enable/disable per tool
- **Agent builder wizard**: Template selection → config form → trigger setup → budget → dry-run → approval → create
- **Agent version history**: Timeline with diff view per version, `changed_by` and `change_reason`, rollback button
- **Workflow builder**: Visual graph editor (upgrade from Phase 0 stub — now functional)
  - Drag-and-drop node palette: Trigger, Agent, Tool, Router, Fork, Join, Human Input
  - Step config panels per type
  - Condition editor for Router nodes
  - Trigger config (cron, webhook, event) on Trigger nodes
  - Save and publish workflow
- **OpenAPI import wizard**: Enter URL → auto-detect spec → review endpoints → enable/disable → set risk levels → import

### Testable outcome

- Browse marketplace, search "Code Review" → find skill and workflow template
- Install skill → security scan runs, skill appears in library
- Install workflow template → dependency check, agents created, triggers bound
- Assign capability to agent → agent can use it
- Run installed workflow → agents coordinate via plan, triggers fire on schedule
- Create agent via builder wizard with template → dry-run passes → agent created
- Roll back agent config → previous system prompt and tool policy restored, `active_config_version_id` updated
- OpenAPI import: enter Stripe API URL → endpoints discovered → admin selects subset → tools created in registry
- Agent uses `create_agent` meta-tool → child agent created through full builder workflow
- User generates plugin from template → private sandbox run succeeds → submit for review
- Reviewer requests changes → creator receives Nessie thread/DM with review notes
- Reviewer approves next version → plugin becomes publishable to assigned scopes
- Launch coding environment from workflow/plugin → instance row created, usage ledger accrues, termination writes final cost
- Agent builds plugin from template → manifest validates → template tests pass → package submitted for review

### Exit criteria

- Marketplace tabs show all 5 capability categories (verified: at least 2 items per tab)
- Install flow runs security scan and adds to library (verified: install → `library_items` row + scan)
- Capability assignment controls tool access per agent (verified: unassigned capability → tool unavailable)
- Agent builder dry-run catches config errors before creation (verified: invalid tool policy → dry-run fails)
- Config versioning creates immutable rows (verified: change prompt → new version row, old unchanged)
- Rollback restores previous config (verified: rollback → `active_config_version_id` points to old version)
- Workflow templates execute end-to-end with trigger binding (verified: scheduled workflow fires)
- OpenAPI auto-import works for at least 2 real APIs (e.g., Stripe, GitHub)
- Generated plugins stay sandboxed before approval (verified: private plugin cannot run outside isolated runner)
- Review workflow gates publication (verified: unapproved version cannot be published org-wide)
- Execution usage ledger attributes cost correctly (verified: environment run linked to actor + run + final billable duration)
- Plugin builder system is deterministic (verified: template-based plugin passes schema validation and harness tests before review)
- Black-box invocation works (verified: invoker receives final output but cannot see hidden logs/steps/bindings)
- Workflow runs are first-class records with step history (verified: run + step rows created and linked to installation + trigger source)
- Lint, typecheck, build pass

---

## Summary: Phase Dependencies

```
Phase 0: Visual Prototype (design track — not an implementation phase)
  │
  ├── Produces: production facades, types, components, mock data
  │
Phase 1: Agentic Loop + Cost Ledger
  │ depends on: Phase 0 (UI ready for real data swap)
  │
  ├── Phase 2: Triggers + Scheduler
  │     depends on: Phase 1 (agents must be able to run)
  │
  ├── Phase 3: Plans + Mailbox + Resource Locks
  │     depends on: Phase 1 (agentic loop)
  │
  └── Phase 4: Evaluation + Reflection
        depends on: Phase 1 (agentic loop)

Phase 5: Tool Registry + Temp Context + Companion Skills
  │ depends on: Phase 1 (agentic loop)
  │             Main Phase 3 (ToolRegistryEntry, ToolGrant, SecretRecord — HARD prerequisite)
  │
Phase 6: Skills + Security Pipeline + Memory Integration
  │ depends on: Phase 4 (evaluation — quality signal for skills)
  │             Phase 5 (tool registry — skills reference tools)
  │             Phase 3 (plans — skills produce plan templates)
  │
Phase 7: Remote Workers + Async Tools
  │ depends on: Phase 5 (temporary context — remote tools load into it)
  │             Phase 2 (triggers — remote workers use event triggers)
  │             Main Phase 4 (remote execution scope)
  │
Phase 8: Marketplace + Agent Builder + Workflow Templates
    depends on: Phase 6 (skills — marketplace lists them)
                Phase 7 (remote tools — marketplace includes them)
                Phase 5 (tool registry — marketplace indexes it)
                Phase 3 (plans — workflows produce plans)
```

**Parallelism:** Phases 2, 3, and 4 can be developed in parallel after Phase 1 completes. Phase 5 blocks on Main Phase 3. Phase 6 requires 3+4+5. Phase 7 requires 2+5. Phase 8 requires everything.

---

## Deferred Items

These are documented in specs but explicitly deferred beyond this plan:

| Item | Spec Source | Rationale |
|---|---|---|
| Conversation intelligence normalized event pipeline | conversation-intelligence-platform.md | Builds on Phase 2 event bus, needs its own plan |
| Memory phases C–F (episodic, lifecycle/GC/conflict, personalization, local-first) | multi-agent-memory-system.md | Phase 6 covers A+B; remaining phases need separate planning |
| Channel orchestrator LLM routing enhancement | the-agents.md § 6 | Improves naturally as capabilities grow; not a discrete phase |
| Full workflow builder visual editor | marketplace.md § 8 | Phase 8 ships functional version; polish is iterative |

---

## Validation Issues to Fix During Implementation

From the Claude validation pass:

1. **Status ENUM lifecycle gap**: `mcp_server_instances` has 10 statuses but the lifecycle diagram only shows transitions for non-remote servers. Add a "Remote protocol lifecycle" subsection during Phase 7.
2. **Budget/reaper threshold ordering**: Document the invariant `maxWallclockMs < stale_run_reap_threshold < worker_offline_threshold` (90s / 120s / 180s) in Phase 1.
