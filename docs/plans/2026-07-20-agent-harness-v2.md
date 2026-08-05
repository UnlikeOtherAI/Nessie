# Agent Harness v2 — Goals, Unbounded Runs, Model Tiers

**Status:** Draft spec — approved direction, not yet scheduled
**Date:** 2026-07-20
**Companion:** [2026-07-20-chief-of-staff.md](2026-07-20-chief-of-staff.md)
(the CoS depends on this harness for long-running analysis work)

## 1. Problem

Nessie's agentic loop hard-caps every run at 12 iterations / 20 tool calls /
90 s / 50 000 tokens / 50 ¢ (`worker/src/run/agentic-loop.ts:33-40`). When any
cap fires mid-run the loop returns `finalText: ''` and the run **completes
"successfully" with an empty message** — the only handler is a `console.warn`
(`worker/src/run/execute/agent-loop.ts:276`). The user believes the work is
being done; the work was silently truncated. This is the single worst UX
failure mode the platform has, and it makes any long-horizon work (deep
analysis, document writing, CoS runs, multi-document research) impossible.

Finite structural caps are the wrong governance model. Agents must be able to
work for as long as the task genuinely requires; what must be governed is
**cost and context**, and the governance must be **visible**, never silent.

## 2. What Codex does (reference: `/Volumes/External/Projects/codex`)

The open-source Codex CLI harness sustains hours-long tasks. Findings from
`codex-rs/core/src/`:

1. **No hard caps whatsoever.** The task loop (`codex.rs` `run_task`, ~:2278)
   has no iteration, tool-call, or wallclock counter. A turn ends when the
   model's streamed response completes; the loop continues while the model
   emits tool calls and stops when it emits only a message. Termination is
   **model-driven**.
2. **Token budget is the only governor, enforced by auto-compaction.** At 90%
   of the model context window (`models_manager/model_family.rs:157`) the
   harness summarizes the conversation (`compact.rs`), rebuilds history as
   *initial context (durable instructions) + recent user messages (≤20 k
   tokens) + summary*, and **continues the same loop**. No restart, no
   truncation. Repeated compaction warns about degraded accuracy.
3. **Durable steering lives outside the transcript.** AGENTS.md / user
   instructions are re-injected via `build_initial_context` and survive every
   compaction. Codex's `update_plan` tool is display-only and compacts away —
   it is *not* a durable goals store.
4. **Resilience:** every model call sits in a retry wrapper
   (`codex.rs:2456`) — transient stream errors retry with server
   `Retry-After` or exponential backoff, surfaced as "Reconnecting… n/max";
   only genuinely terminal errors (interrupt, quota, invalid request) stop
   the task.
5. **Mid-task steering without restart:** user input during a running task is
   queued (`inject_input`) and folded into the next loop iteration
   (`get_pending_input`), so the user redirects work in flight.
6. **Per-task-kind routing exists in embryo:** compaction is pinned to low
   reasoning effort; review mode runs a nested conversation on a dedicated
   `review_model`. Routing is by task *kind*, not difficulty.

## 3. Design — Nessie harness v2

### 3.1 Remove work caps; keep safety backstops

- Delete `maxIterations` / `maxToolCalls` / `maxWallclockMs` as work
  limiters. Termination becomes model-driven, exactly like Codex.
- Keep **loop detection** (repeated identical tool-call signature — already
  in `agentic-loop.ts`) as a real safety net, and a generous watchdog
  wallclock (hours, config `NESSIE_RUN_WATCHDOG_MS`) that catches hangs, not
  work.
- **Every stop, without exception, posts a visible message** stating why the
  run ended and what state it left behind. An empty-text completion is a bug
  by definition.

### 3.2 Economic governance with checkpoints (replaces caps)

- **Fix mid-run cost accounting.** Today the in-loop cost cap only counts
  `providerReportedCost` in USD (`agentic-loop.ts` `sumCostCents`) — if the
  provider reports nothing, cost governance is dead. The loop must price
  every invocation through Nessie's own `ModelPricingProfile` math
  (`packages/runtime/src/ledger.ts` `calculateEstimatedCost`), the same
  source the post-hoc ledger and `Budget` gate already use.
- **Graduated response, not a kill switch.** Runs carry a *soft* cost
  threshold derived from the governing scope `Budget` (team → project → org,
  `packages/runtime/src/budget.ts`). Crossing it triggers, in order:
  1. **Checkpoint** — persist a progress summary + open goals (see §3.4).
  2. **Continue** if the scope budget still has headroom (normal case — the
     run just keeps working).
  3. **Pause visibly** when scope budget is genuinely exhausted: the run
     moves to a `waiting_budget` state, posts "paused after ~$X — approve to
     continue", and resumption reuses the existing `ApprovalRequest`
     machinery (`api/src/services/approvals.ts`) with the checkpoint as the
     continuation payload. Human interactive turns keep their existing
     `blockHumansWhenOver` exemption.
- The `Budget.mode = degrade` hook stays, but degrades to a **tier** (§3.5),
  not a single hard-coded model.

### 3.3 Auto-compaction in the worker loop

- Replace today's trim-oldest-messages behaviour (`CONTEXT_BUDGET_TOKENS =
  100_000 × 0.85`) with Codex-style compaction at ~90% of the *model's*
  context window: cheap-tier summarization of the transcript, history rebuilt
  as *system/agent prompt + goals (§3.4) + recent user messages + summary*,
  same run continues.
- Compaction runs on the **swift tier** (mirrors Codex pinning compaction to
  low effort).
- Emit a `run.compacted` realtime event; repeated compaction in one run
  raises a quality warning on the run record.

### 3.4 Goals — the durable concept Codex lacks

Codex's plan tool is UI sugar that compacts away. Nessie makes goals
first-class and durable:

- New `RunGoal` rows (org/project/team-scoped like everything else) attached
  to the run's *task*, not the transcript: `{ id, taskId, runId, title,
  status: pending | in_progress | completed | abandoned, ordinal, note,
  updatedAt }`.
- Agent-facing `goals_update` builtin (same contract shape as Codex
  `update_plan`: full-list upsert, at most one `in_progress`). Every write
  persists; the current goal list is **re-injected into context after every
  compaction and at the start of every continuation run**, so long work
  survives context pressure, budget pauses, worker restarts, and multi-run
  chains without losing the thread.
- Goals are visible live in the admin UI (run/task detail + agent activity
  timeline) — the user watches progress tick instead of wondering whether
  the agent is still alive. On any pause/stop, the posted status message
  includes the goal list state.
- Goals are the natural handoff unit: a paused run's goals tell the resuming
  run (or a human taking over) exactly where things stand. The CoS reads
  goal-completion patterns as telemetry (abandoned goals = friction signal).

### 3.5 Model tiers — cost-aware routing per task class

Nessie already has the scaffolding, all inert at runtime: per-org
`InferenceProvider`/`InferenceModel` catalog, time-versioned
`ModelPricingProfile` price tables, and a `Budget.degrade` hook. The worker
ignores all of it and reads `Agent.model` or the env default. Wire it up:

- **Three named tiers** per organization: `swift`, `standard`, `deep`
  (think Haiku / Sonnet / Opus). A tier maps to an ordered list of
  `InferenceModel` refs (first healthy wins — fallback comes free).
  Configured in the admin inference control plane; sensible defaults seeded
  from the provider catalog + pricing profiles so orgs see cost-per-million
  next to each choice.
- **Task-class → tier defaults** (org-overridable), replacing today's
  hard-coded scatter:

  | Task class | Today | Tier |
  |---|---|---|
  | Orchestrator engagement decisions | env default (`orchestrator.ts`) | swift |
  | Compaction / summarization | n/a (new) | swift |
  | Thread titling, digest copy, memory extraction | env default | swift |
  | CoS observation extraction (batched) | n/a (planned) | swift |
  | Agent Designer | hard-coded `gpt-5-mini` (`designer.ts:31`) | swift |
  | Interactive chat + tool-calling loops | `Agent.model` | standard |
  | Sub-agent `delegate` / subtask workers | inherits parent | standard |
  | Prose / document / KB-draft writing | `Agent.model` | deep |
  | Deep analysis, rehearsal judgment, code | `Agent.model` | deep |
  | CoS clustering & briefing synthesis | n/a (planned) | standard / deep |
  | Probe scoring / LLM-judge verdicts | n/a (planned) | standard |
  | Embeddings | hard-coded `text-embedding-3-small` | own embedding slot |

- `Agent.model` becomes an *override*; the normal case is `Agent.tier`.
  Budget `degrade` maps deep→standard→swift instead of naming one model.
- Everything still routes through the Ledger inference chokepoint with full
  attribution — tiers change *which* model is asked, never how calls are
  signed, metered, or billed.
- Difficulty-based auto-escalation (start swift, escalate on failure) is
  explicitly **deferred** — task-kind routing first, evidence later.

### 3.5.1 Effort levels (implemented — budget scaling SUPERSEDED 2026-08-05)

> **Superseded in part:** effort-scaled run budgets (`EFFORT_BUDGETS` /
> `budgetForEffort`) were retired by
> `docs/plans/2026-08-05-run-budgets-context-and-research-routing.md`. `effort`
> now maps only to provider `reasoning_effort`; run caps are
> `Agent.runLimits ?? NESSIE_RUN_BACKSTOP_*`, with checkpointed graceful stops
> and continuation. The text below is historical.

Shipped ahead of the tier work: a per-agent **effort** setting, modeled on
OpenAI Codex's reasoning-effort levels, with four levels — `low | medium |
high | xhigh` (default `medium`). It is an ordinary `Agent` column
(`AgentEffort` Prisma enum, `Agent.effort @default(medium)`), **not** entangled
with the DeepWater protected-toolPolicy machinery. The shared enum + mappings
live in `@nessie/schemas` (`AgentEffortSchema`, `reasoningEffortForAgentEffort`);
the budget table lives in `worker/src/run/agentic-loop.ts` (`EFFORT_BUDGETS` /
`budgetForEffort`). Effort controls two things per run:

1. **Run budget scaling** — replaces the single `DEFAULT_BUDGET` constant with an
   effort-keyed table selected in `worker/src/run/execute/agent-loop.ts`:

   | Level | Iterations | Tool calls | Wallclock | Tokens | Cost | Tool timeout |
   |---|---|---|---|---|---|---|
   | low | 8 | 12 | 60 s | 30 000 | 25¢ | 75 s |
   | medium (default) | 12 | 20 | 90 s | 50 000 | 50¢ | 75 s |
   | high | 36 | 60 | 600 s | 200 000 | 500¢ | 75 s |
   | xhigh | 10 000 | 20 000 | 4 h | MAX_SAFE_INTEGER | MAX_SAFE_INTEGER | 75 s |

   `xhigh` is effectively unbounded: the org/team `Budget` gate
   (`packages/runtime/src/budget.ts`) and the loop's existing repeated-tool-call
   detection remain the only governors. `toolTimeoutMs` is 75 s for every level.

2. **Provider `reasoning_effort`** — plumbed end-to-end through the inference
   path (`inference.ts` → `inference-stage.ts` → runtime `service.ts` →
   `openai-chat-protocol`/`openai.ts`). The value is added to OpenAI-compatible
   chat request bodies only when set; other providers ignore it. Mapping clamps
   `low→low, medium→medium, high→high, xhigh→high` (providers reject unknown
   values). Embeddings are untouched.

**Inheritance:** `cloneAgentRecord` and `spawn_subtask` children copy the
parent's effort. The ephemeral `delegate` sub-agent keeps its own tight
`SUB_AGENT_BUDGET` (unchanged), but its inference inherits the agent's
reasoning effort. Surfaced in the admin Agent Designer as an "Effort" selector
(Ultra = `xhigh`).

### 3.6 Steering and resilience

- **Pending-input queue:** a user message arriving while that thread's run
  is active is folded into the run's next iteration (Codex `inject_input`
  pattern) instead of spawning a competing run or being ignored. Explicit
  "stop" remains a hard interrupt.
- **Transient-error retries inside the loop:** stream/rate-limit errors
  retry with `Retry-After`/exponential backoff and surface a visible
  "reconnecting n/max" state on the run; only terminal errors (auth, quota,
  invalid request, interrupt) end the task, always with the §3.1 visible
  stop message.

## 4. What changes where (anchors)

- `worker/src/run/agentic-loop.ts` — cap removal, real cost accounting,
  compaction trigger, pending-input drain, retry wrapper.
- `worker/src/run/execute/agent-loop.ts` + `worker/src/run/inference.ts` —
  tier resolution replaces direct `Agent.model` read; per-task-class routing
  for system call sites (orchestrator, designer, embeddings, compaction).
- `packages/runtime/src/budget.ts` — checkpoint thresholds, tier-aware
  degrade, `waiting_budget` verdict.
- `api/prisma/schema.prisma` — `RunGoal`; tier tables (or JSON on the
  existing inference control plane); run states `waiting_budget`,
  `compacted` metadata.
- `api/src/services/approvals.ts` — budget-continuation approvals.
- Admin — tier configuration UI in the inference control plane, goals on
  run/task detail, paused-run resume affordance.
- Docs/standards — `CLAUDE.md`/`AGENTS.md` "Agentic loop: max 12
  iterations…" line updates when the code lands.

## 5. Phasing

1. **Visibility first (small, urgent):** every cap/stop posts a visible
   message with reason + partial state. Kills the silent-truncation bug
   before any redesign lands.
   - **✅ Landed (budget caps).** A budget-cap stop is now classified
     (`iteration_limit | tool_call_limit | time_limit | token_limit |
     cost_limit | repeated_tool_calls`) and always user-visible:
     `worker/src/run/execute/budget-stop.ts` builds the notice + records a
     `run.budget_exhausted` `TaskEvent`, and `run-job.ts` either appends the
     notice to partial assistant text (run `completed`) or, when the loop
     produced nothing, posts the notice as the terminal message and fails the
     run. The loop (`agentic-loop.ts`) now carries the last assistant text out
     of a cap stop instead of returning empty. Still future for this phase:
     `RunGoal`/steering context, the `waiting_budget` pause state, and
     approval-driven resume (Phase 4). DeepWater handoff runs keep their exact
     existing completion path and are unaffected.
   - **✅ Landed (per-run stage latency).** Every run records a wall-clock-only
     latency breakdown at its terminal state — on **both** the completion and
     failure paths — so a slow run is diagnosable without re-instrumenting the
     pipeline (motivated by the block/buzz per-turn stage-latency work, PR
     #2460; see `docs/reviews/2026-07-23-buzz-comparison.md`).
     `worker/src/run/execute/run-timing.ts` builds the summary and writes a
     **`run.timing` `TaskEvent`** whose payload is
     `{ outcome, runId, queueWaitMs, totalMs, inferenceMs, inferenceCount,
     toolMs, toolCount }`. Timestamps are reused from data the run already
     produces — `Run.createdAt` (≈ enqueue, since run + queue-job creation share
     one transaction) → the claim instant → terminal for `queueWaitMs`/`totalMs`,
     per-`InvocationRecord.latencyMs` (main loop + delegated sub-agents) for
     `inferenceMs`, and the agentic loop's newly-summed tool spans (`LoopResult.
     toolMs`) for `toolMs`. `toolMs` sums concurrent per-tool spans, so it can
     exceed `totalMs` — it measures tool work, not a wall-clock span. NO cost
     data (raw usage/cost is Ledger's, commercial rating is UOA's). Emission is
     gated so non-runs stay silent: a pre-claim early return or a retry-throw
     that leaves the run `running` records nothing. Owners read recent
     summaries at **`GET /api/ledger/runs/timing?limit=N`** (owner-only,
     `limit` default 50 / max 200), scoped to the org via the Task relation.
2. **Goals:** `RunGoal` + `goals_update` + UI. Independent of cap removal
   and immediately useful for today's short runs.
3. **Cost accounting + tiers:** mid-run `ModelPricingProfile` pricing;
   tier tables + task-class routing; wire the dormant control plane into
   the worker.
4. **Cap removal + compaction + checkpoints:** model-driven termination,
   auto-compaction, `waiting_budget` pause/resume via approvals.
5. **Steering + retries:** pending-input queue, in-loop transient retries.

## 6. Open questions

- Default watchdog wallclock (proposal: 4 h) and default soft-checkpoint
  interval (proposal: every ~$1 of estimated spend).
- Tier membership defaults per provider (which concrete models seed
  swift/standard/deep for OpenAI, Anthropic, Kimi, MiniMax).
- Whether compaction summaries are persisted as run artifacts (leaning yes —
  they are the audit trail of what the agent "forgot").
- Rate-limit-aware pacing (Codex surfaces provider rate-limit snapshots;
  Nessie could pace concurrent runs org-wide) — v2 of this spec.
