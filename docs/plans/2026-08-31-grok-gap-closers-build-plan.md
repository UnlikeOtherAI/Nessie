# Closing the Grok-Bot gaps — combined build plan

> Status: in delivery. **Shipped to `main` 2026-08-31:** P0 honesty fix,
> Gap 1 P1 (approval suspend/resume + hardened proof), Gap 3 P1 (demonstration
> capture) — each code-verified against a throwaway pgvector DB (typecheck,
> lint, migrations, DB-backed + unit suites). Remaining: Gap 2 actuation
> (`command.run` → `browser.act`, needs a real executor host), Gap 1 P2/P3
> (auto-review), Gap 3 P2 (generalise a demonstration into a Workflow), the
> in-thread approval/RunStop admin doorways, and P6 (persistent/headless
> executor). Decisions resolved on the best-experience lens (§7).
> Derived from the code-grounded audit
> [2026-08-31-grok-bot-vs-nessie-capability-audit.md](./2026-08-31-grok-bot-vs-nessie-capability-audit.md)
> (the three dimensions where Nessie is genuinely behind).
> Per-feature deep-dives (companion docs, same folder):
> `2026-08-31-approvals-suspend-resume-and-auto-review.md`,
> `2026-08-31-executor-full-actuation.md`,
> `2026-08-31-learn-by-demonstration.md`.
> This document is the **sequenced roadmap + resolved decisions**; the companions
> carry the fine-grained per-file design. Every §7 call is settled by one test —
> the best experience for the person using it — so the build has no ambiguity to
> stall on.

## 0. One-paragraph version

The audit found Nessie behind Grok Bot in exactly three places: it cannot pause a
run for a human decision and resume it (approvals block and force a re-run), it
cannot actually drive a browser or a shell (the verbs are declared but unshipped),
and it cannot learn a routine by watching one be done. All three are reachable
from primitives Nessie already has — the `RunCheckpoint`/continuation machinery,
the Apple-Virtualization executor micro-VM, and the guarded-sequence Workflow
engine — so this is **wiring and hardening, not green-field platform work**. The
right order is dictated by safety, not by size: **true suspend/resume + a
model-based auto-review layer (Gap 1) is the control substrate that makes real
actuation (Gap 2) safe to ship, and Gap 2's structured action stream plus Gap 1's
approval gates are the raw material a demonstration recorder (Gap 3) generalises.**
So: **1 → 2 → 3**, with parallelisable slices inside each. One thing ships
immediately and independently of all of it — the honesty fix that stops the
UI/catalog implying `browser.act`/`command.run` work.

## 1. Why this order

- **Gap 1 before Gap 2.** Real computer-use (typing into web apps, running a
  shell) is exactly the class of action that must be able to stop and ask a human
  mid-run. Today an approval-gated tool call cannot suspend — the run ends and a
  human must re-trigger. Shipping actuation on top of that means either
  no-human-in-the-loop actuation (unsafe) or lose-all-progress-on-every-gate
  (unusable). Gap 1 is the substrate.
- **Gap 2 before/with Gap 3.** The cleanest thing to "record and replay" is a
  **structured action stream** — tool calls with typed arguments — which is what
  the executor and the builtin toolset already emit as `ToolCall` rows. Gap 2
  widens that stream to include browser/terminal actions; Gap 3 generalises a
  recorded stream into a reusable Workflow. Gap 3 can *start* against today's
  tool stream and gain actuation coverage as Gap 2 lands.
- **The honesty fix is unordered.** It is a doorway/catalog change with no
  dependency on any of the above and should ship in the first week regardless of
  how far the rest gets (see §5, Phase 0).

---

## Gap 1 — Model-based auto-review + true approval suspend/resume

### 1a. Current state (code-cited)

- **Approvals block and force a re-run — they do not suspend.** A policy verdict
  of `approval_required` returns `{ type: 'tool_denied', reason: 'approval_required' }`
  to the model and the loop continues / the run ends
  (`worker/src/run/execute/tool-authorization.ts:151-177`,
  `worker/src/run/execute/policy.ts:95-141`). The only way a gated tool ever runs
  is to **re-issue the run with an `approvalProof` already attached**
  (`policy.ts:119`, `packages/workspace-admin/src/policy-check.ts:46-54`).
- **The suspend/resume scaffolding exists but is dead.** `waiting_approval` is a
  real run/agent status in the enums and in `ACTIVE_RUN_STATUSES`
  (`packages/schemas/src/lifecycle.ts:15,110`, `api/src/services/run-access.ts:6`),
  and `thread-serialization.ts:54-56` even carries the comment *"`waiting_approval`
  is in-flight: the run resumes after the approval"* — but **nothing ever writes a
  run into `waiting_approval`** (only the expiry cleanup at
  `api/src/services/approvals.ts:317-327` reads it, to fail such a run). And
  `ApprovalRequest.continuationToken` is generated and returned
  (`approvals.ts:24,41,378`) with **zero consumers** anywhere in the tree.
- **`ApprovalRequest` is a deferred-effect ticket, not a run gate.** Resolve runs
  a fixed effect server-side (`api/src/services/approval-effects.ts:121`); only two
  effects exist — KB page publish and to-do-template publish — everything else is
  a no-op.
- **There is no model-based auto-review** anywhere. The pre-dispatch gate is
  purely deterministic (`PolicyRule`/`PolicyBinding`, `checkPolicy`,
  deny-overrides).
- **Real suspend/resume already works in one place** — the Workflow engine
  (`worker/src/control/workflows.ts`, `worker/src/control/workflow-step-reaper.ts`)
  suspends and resumes steps via the mailbox choreography and a reaper. That is the
  proof the pattern is viable; Gap 1 brings it to the agentic run loop.

### 1b. Target

1. A run hits an approval/tool gate, **persists resumable state, transitions to
   `waiting_approval`, and stops cleanly**. On human approval it **resumes and
   re-attempts the approved tool with the proof**, rather than re-running from
   scratch. `continuationToken` and `waiting_approval` become real.
2. A **model-based Auto-review layer** judges a proposed tool call / computer
   action *before* execution and returns **allow / require-approval / deny**. It is
   **rule-configurable**, **"Require-Approval wins"** on conflict, and
   **supplements — never replaces — deterministic least-privilege** (a
   deterministic deny is still a deny; auto-review can only add friction, never
   remove it).
3. Both reconcile with **approvals-in-chat** (the existing approval cards +
   `approval.needed`/`approval.resolved` realtime events) and the **org-hierarchy
   approval routing** (role-gated approvers, `ROLE_REQUIRED` at
   `api/src/services/approvals.ts:84`, `PolicyBinding` scope chain).

### 1c. Design

- **Reuse `RunCheckpoint`, do not invent a second pause.** At the gate, write a
  checkpoint (the existing work-state note + verbatim sources machinery —
  `worker/src/run/execute/checkpoint.ts`, `budget-stop.ts`), stamp the pending
  `ApprovalRequest.id` + the tool-call intent (tool name + validated args) onto it,
  transition the run to `waiting_approval`, and exit through the same classified-stop
  path budget/cancel already use.
- **Make `continuationToken` the resume key.** On `POST /api/approvals/:id/resolve`
  (`api/src/routes/approvals.ts:54`), an *approve* claims the checkpoint set-once
  (mirror `api/src/services/run-continuation.ts`'s `consumedByRunId` pattern) and
  enqueues a continuation run (`Run.continuationOfRunId`) that loads the checkpoint,
  re-enters the loop, and re-attempts the gated tool **with an `approvalProof`
  minted from the resolution** — so `policy.ts:119` now sees the proof and allows.
  A *reject* transitions the run to a terminal state with the model's next turn
  told the action was declined.
- **One gate, two verdict sources.** Extend the single chokepoint
  (`tool-authorization.ts`) so a tool invocation is evaluated by: (1) deterministic
  `PolicyRule` (unchanged, authoritative for deny), then (2) **auto-review** for
  actions a policy marks `reviewable`. Auto-review is a utility-model call
  (`NESSIE_UTILITY_MODEL`, the same plumbing `delegate`/orchestrator use) that sees
  the tool name, typed args, and a structured risk context (never free-string
  heuristics — obey "intent is model-judged, never string-matched"). Its verdict
  maps allow → proceed, require-approval → open an `ApprovalRequest` + suspend
  (path above), deny → `tool_denied`. **Require-Approval wins** any tie; a
  deterministic deny short-circuits before auto-review even runs (least-privilege
  is never weakened).
- **Fail policy.** Auto-review **fails closed to require-approval** (a model error
  becomes "ask a human"), never fail-open to allow — the opposite of the
  engagement-decision's fail-open, because here the cost of a wrong allow is an
  executed side effect. This is an explicit inversion and must be tested.
- **Thread + reply.** The suspended run holds its thread run-slot
  (`thread-serialization.ts` already lists `waiting_approval` as active — wire it),
  and resume reuses the persisted reply anchor so the answer lands where it would
  have.

### 1d. Phased path

1. **P1 — suspend/resume core.** Checkpoint-at-gate, `waiting_approval` write,
   `continuationToken`→continuation-run resume, approve/reject/expiry paths. No
   auto-review yet; the gate is still deterministic-only, but now a gated tool
   *suspends* instead of re-running. Ship with the existing approval cards +
   `RunStopContinue.tsx` doorway.
2. **P2 — auto-review layer.** Add the `reviewable` policy facet + the utility-model
   reviewer + verdict mapping into the same gate. Owner config surface for which
   tools/actions are reviewable and the default verdict.
3. **P3 — org-hierarchy routing polish.** Route a require-approval to the right
   approver set (reuse `PolicyBinding` scope chain + `ROLE_REQUIRED`), and surface
   pending approvals in the approver's inbox.

### 1e. Risks

- **Resumability correctness** is the whole game: a checkpoint that doesn't
  faithfully restore tool-call context resumes into a different action than the one
  approved. Mitigation: stamp the exact validated args on the approval + assert
  byte-equality on resume (mirror the live-doc streamed-equals-parsed discipline).
- **Latent proof-validation hole (must fix in P1).** Today `requiresApproval` is
  satisfied by *any* non-empty `approvalProof` string
  (`packages/workspace-admin/src/policy-check.ts`), because the proof was never a
  real credential — nothing minted or checked it. Wiring resume means the proof
  becomes security-bearing, so it must be **verified against the approval row**
  (organization, status, token, tool name, args-hash, run lineage) and **consumed
  set-once**. Shipping resume without closing this would let a model forge its own
  approval. (Surfaced by the deep-dive; do not skip.)
- **Auto-review latency/cost** on every reviewable call. Mitigation: scope
  `reviewable` narrowly (high-blast-radius actions only), cache within a run.
- **Double-execution / race** on resolve. Mitigation: set-once checkpoint claim +
  thread run-slot, exactly as continuation already does.

### 1f. New vs reused

- **Reused:** `RunCheckpoint`/continuation (`run-continuation.ts`,
  `continuation.ts`, `checkpoint.ts`), the classified-stop exit
  (`budget-stop.ts`/`cancel-stop.ts`), `ApprovalRequest` + resolve route + realtime
  events, `waiting_approval` status, `continuationToken` field, `PolicyRule`
  chokepoint, `NESSIE_UTILITY_MODEL`, `RunStopContinue.tsx`.
- **New:** the gate→checkpoint→suspend transition, the resolve→continuation resume,
  the `reviewable` policy facet, the auto-review utility-model reviewer + verdict
  mapping, and its owner config surface. **No new pause mechanism, no second
  approval table.**

---

## Gap 2 — Full browser / terminal / filesystem actuation

### 2a. Current state (code-cited)

- **Real executor micro-VM, narrow verbs.** The executor is a paired daemon that
  boots a **Linux micro-VM via Apple `Virtualization.framework`**
  (`executor/vm/Sources/NessieExecutorVMCore/VMConfiguration.swift`) with a
  read-only virtiofs COW workspace and an authenticated egress gateway. What an
  agent can call today: `executor.file.list/read/write` (COW, read ≤8 KB / write
  ≤64 KB), `executor.browser.open` (one approved URL) + `executor.browser.observe`
  (DevTools target list — title/url/type, ≤64 KB, **no screenshot/DOM/input**),
  and `executor.coding.launch/observe` (a Codex/Claude CLI in a guest tmux pane).
- **The actuation verbs are declared-only.** `browser.act` and `command.run`
  exist in the op-key enum (`packages/schemas/src/executor.ts:96-113`) and the
  logical-tool catalog (`packages/executor-manage/src/executor-logical-tools.ts:19,22`)
  but have **no model-facing schema** (`worker/src/run/executor-toolset.ts:46-116`
  `descriptorFor` returns `null` for them) and **no daemon dispatch**
  (`executor/src/daemon.ts` handles only the wired verbs). So they are unreachable
  — the **live Rule-zero risk** the audit flagged.
- **Sessions are ephemeral + time-boxed** — browser 10 min
  (`executor/src/browser-session-manager.ts:15`), coding 20 min
  (`coding-session-manager.ts:14`), COW discarded on stop
  (`sandbox-workspace.ts`).
- **A separate docker/gcloud provisioner exists but is workflow-only** —
  `worker/src/control/execution/docker-provider.ts` / `gcloud-provider.ts` serve
  workflow `environment_launch` steps, not free agent actuation. (Note: there is
  **no "DeepTest" runtime in code** — the executor micro-VM *is* the execution
  model; the workflow docker/gcloud path is the "remote runner" analog. Any plan
  copy must not imply a DeepTest service exists.)
- **Egress is IP-pinned** (`packages/runtime/src/url-safety.ts:233,304`
  `pinnedFetch`/`safeFetch`) and the guest has no direct network route — its sole
  vNIC terminates at the daemon egress gateway (`executor/src/egress-gateway.ts`,
  `egress-policy.ts`, `executor/guest/egress_proxy.go`).

### 2b. Target

Ship real computer-use with Nessie's **per-session isolation advantage intact**:
1. **`browser.act`** — click / type / navigate / scroll a real web app via CDP in
   the guest Chromium, plus a **`browser.observe` fidelity upgrade** (a bounded
   screenshot and/or accessibility-tree snapshot) so the model can actually see
   what it is acting on.
2. **`command.run`** — a validated-argv shell with bounded output, working-dir
   confined to the COW workspace, no ambient home/Docker/SSH/cloud creds, non-root,
   resource-limited (extend the existing guest sandbox, `coding_runtime.go`'s
   sandbox profile is the template).
3. **Approval integration** — every actuation verb is `reviewable`/gated through
   Gap 1, so a click that submits a form or a shell command can require a human.
4. **Close the honesty gap** — either ship these verbs or **hide them from the
   catalog/UI until shipped** (Phase 0, decoupled).

### 2c. Design

- **`browser.act`:** add the arg schema (action ∈ click/type/scroll/navigate/key,
  plus a target ref) to `executor.ts`, a `descriptorFor` case in
  `executor-toolset.ts`, and a daemon dispatch branch in `executor/src/daemon.ts`
  that drives CDP `Input.*`/`Page.navigate` inside `executor/guest/browser_runtime.go`.
  Target resolution should be a stable element ref from the observe snapshot
  (accessibility node id), **not** raw pixel coordinates — coordinates are brittle
  and violate the structural-action discipline.
- **`browser.observe` fidelity:** return a bounded accessibility tree (ref → role →
  name) as the primary signal, and optionally a downscaled screenshot. **Open
  decision:** a screenshot is only useful to a vision-capable model, and Nessie's
  current chat providers (deepseek/kimi/minimax) report `supportsVision:false` —
  only openai/openai-compatible can consume it. Recommend **accessibility-tree
  first** (works with every provider) and screenshot behind a `supportsVision`
  gate.
- **`command.run`:** validated argv schema (no shell string), working dir under the
  COW root, output byte-capped like the other verbs, dispatched into the guest
  sandbox profile. Reuse the coding-session sandbox hardening
  (`coding_runtime.go`: no network, denied control dir, non-root).
- **Isolation invariants (unchanged, must be re-asserted in tests):** micro-VM per
  session; egress only via the authenticated gateway using `safeFetch`/`pinnedFetch`
  (no divergent SSRF policy); COW never touches host root; human-gated
  `workspace.promote` unchanged; per-agent tool-policy grant + exact-bundle binding
  (`executor-toolset.ts:143-208`); returned data bounded and in run consent.
- **Persistence decision (open, see §6):** either keep ephemeral-per-run (simplest,
  safest) or introduce a **persistent per-user workspace** and/or a **first-class
  headless/cloud executor** (self-hosted Linux daemon, or the workflow
  docker/gcloud provider generalised) so the "cloud computer" persists like Grok's.
  Recommendation: **Phase-gate it** — ship actuation on the ephemeral session
  first; add opt-in workspace persistence as a later phase, never a persistent
  *ambient-credential* VM (that is precisely Grok's weakness we are ahead of).
- **Disclosure/audit:** executor actions emit audit entries into the per-org
  hash-chain; a browser/terminal **read** that feeds the model's context must feed
  the `ConsumedSourceSink` (same rule as every other read), so an actuated page's
  content can't be laundered into a room its audience can't see.

### 2d. Phased path

0. **Honesty fix (immediate):** hide `browser.act`/`command.run` from any catalog/
   UI affordance until they dispatch (or land them behind a feature flag that is
   off). Decouples the credibility risk from the build timeline.
1. **`command.run`** first — smaller surface, no observe-fidelity dependency, and
   it makes the coding lane vastly more useful. Schema + descriptor + guest exec +
   Gap-1 gating.
2. **`browser.observe` fidelity** (accessibility tree) — prerequisite for act.
3. **`browser.act`** — the CDP input path against ref targets.
4. **Persistence / headless-executor** phase (only if §6 decides for it).

### 2e. Risks

- **Sandbox escape / egress bypass** is the top risk of any real actuation.
  Mitigation: no new network path — reuse the gateway; command.run inherits the
  coding sandbox's no-network/non-root profile; adversarial tests for egress and
  path-escape.
- **Guest work is Go inside an Apple-Virtualization image** — parts (VM image
  build, signing, real CDP) are **not verifiable in a CI sandbox** and need a real
  executor host. Plan must mark those slices as host-verified, not CI-green.
- **Model-usability of observe** — too little signal and the model flails; too much
  and it blows context. Bound hard and iterate.
- **Desktop-only reach** — the executor ships in the Developer-ID desktop build,
  not App Store (deliberate). Decide whether a headless daemon becomes a
  first-class distribution so actuation isn't Mac-desktop-gated (§6).

### 2f. New vs reused

- **Reused:** the entire executor daemon + micro-VM + egress gateway + COW
  workspace + session managers + per-agent policy binding, the `safeFetch`/
  `pinnedFetch` SSRF layer, Gap-1's approval gate, the audit hash-chain, the
  `ConsumedSourceSink`.
- **New:** two arg schemas + two `descriptorFor` cases + two daemon dispatch
  branches, the CDP input driver + accessibility-snapshot in `browser_runtime.go`,
  the `command.run` guest executor, and (optionally, later) a persistence/headless
  path. **No new sandbox, no new egress policy.**

---

## Gap 3 — Learn-by-demonstration

### 3a. Current state (code-cited)

- **Nothing today.** Routines are hand-authored: triggers
  (`api/src/routes/triggers.ts`, `worker/src/control/trigger-scheduler.ts`,
  `schedule_task`/`agent_trigger_create`), Workflows
  (`worker/src/control/workflows.ts`, `api/src/services/workflow-validation.ts`),
  and to-do templates (`todo_template_propose` in
  `packages/runtime/src/builtin-agent-tools.ts`, `worker/src/run/pa-tools/todos.ts`).
  No capture-and-replay exists.
- **But the raw material already persists.** Every run records typed `ToolCall`
  rows and `TaskEvent`s; the Workflow engine is a **guarded sequence runner** whose
  step types (`agent_task`, `environment_launch`, `message_send`, `tool`/`tool_call`,
  `transform` — `api/src/services/workflow-validation.ts:60-70`) map almost 1:1 onto
  a recorded tool-call sequence. So a demonstration is a *generalisation of an
  existing run's action stream*, not a new capture substrate.

### 3b. Target

Record a user's (or human-guided agent's) **workflow demonstration** into a
**reusable skill/routine**, reconciled with the to-do-template design
(demonstration → draft template/skill) and routines/scheduling. Cover: capture
(what is recorded; privacy/consent; **no microphone/audio**), conversion to a draft
skill, human edit/test, and execution.

### 3c. Design

- **Capture = the structured action stream, never the screen.** Record the ordered
  list of **tool calls with typed arguments** (builtin, MCP, and — as Gap 2 lands —
  executor browser/terminal actions) plus the involved agents/channels, from a
  session the user explicitly marks as a demonstration. This obeys "intent is
  model-judged, never string-matched" — we capture *structural facts*, not
  content-scraped heuristics. **No pixel/coordinate macros, no mic/audio, no
  keystroke logging** — only the typed tool-call record the run already writes.
- **Generalise with a model pass.** A utility-model step turns the concrete
  recording into a **parameterised draft Workflow** (or to-do template for simple
  linear routines): it identifies which literal arguments should become inputs,
  names the steps, and emits a definition the existing `workflow-validation.ts`
  accepts. The recording is never auto-run raw.
- **Human edit/test/approve before it's live.** Reuse the Workflow install/publish
  + approvals gates: a demonstrated skill is a **draft** the user reviews in the
  Workflow editor, dry-runs, and promotes; scheduling reuses triggers. This is the
  same "propose → human approves" shape as `todo_template_propose` today.
- **Recommended first step: (a) record-a-run → generalise into a Workflow.** It
  maximally reuses Workflow persistence/validation/approvals/budgets/audit and
  produces an editable, schedulable artifact. The lighter **(b) to-do-template
  capture** path can follow for simple linear routines. Rationale: reuse + scope
  honesty — we are not building a second orchestration engine.
- **Tenancy/disclosure/audit:** the demonstration and the generated skill are
  org-scoped; if replaying the skill performs reads that enter context, those feed
  the `ConsumedSourceSink` exactly as a normal run; each capture/generation/publish
  emits audit entries.

### 3d. Phased path

1. **P1 — capture + draft API (shipped 2026-08-31).** Explicit, model-judged
   `demonstration_start` / `demonstration_stop` controls and the org-scoped
   `/api/demonstrations` draft read surface arm a single `(agent, thread)`
   recording. `Demonstration` / `DemonstrationStep` retain the completed
   structural action stream at `worker/src/run/execute/tool-events.ts`
   `recordToolEnd`, including **full redacted arguments**, ordered completion,
   run, and outcome. Recording expires after four hours by default and captures
   at most 200 steps by default. `ToolCall.inputSummary` remains a ~200-character
   preview and is never used to retrofit an old run; that would be lossy. The
   recording is review-only and cannot run anything. P2 remains responsible for
   model generalization into a Workflow draft.
2. **P2 — generalise to a draft Workflow.** The utility-model parameterisation pass
   → a draft Workflow definition in the existing editor.
3. **P3 — edit/test/promote/schedule.** Reuse Workflow publish + approvals +
   triggers. Optional to-do-template path for linear routines.

### 3e. Risks

- **Over-generalisation / brittle replays** — the model mis-parameterises, and the
  skill breaks on the second input. Mitigation: human review is mandatory before
  live; dry-run before schedule.
- **Capturing too much** — a demonstration that records private reads and replays
  them for a wider audience. Mitigation: disclosure sink + org scoping + explicit
  review of what the skill reads.
- **Scope creep into a macro recorder.** Mitigation: structural-only capture, hard
  "not built" list (§3f).

### 3f. New vs reused

- **Reused:** `Run`/`ToolCall`/`TaskEvent` records, the Workflow engine +
  validation + editor + publish/approvals, triggers/scheduling, `todo_template_propose`
  shape, `NESSIE_UTILITY_MODEL`, the disclosure sink + audit chain.
- **New:** a demonstration marker/capture path, the generalisation model pass, and
  the "record → draft skill" doorway. **Explicitly NOT built:** pixel-level UI
  macro recording, cross-app desktop capture, microphone/audio capture, keystroke
  logging.

---

## 5. Combined phased roadmap

| Phase | Ships | Depends on | Parallelisable with |
|-------|-------|-----------|---------------------|
| **P0 — DONE** | Honesty fix: hide/flag-off `browser.act`/`command.run` until real | — | everything |
| **P1 — DONE** | Gap 1 suspend/resume core (checkpoint→`waiting_approval`→resume, one-use hardened proof, preflight-suspends-batch-before-side-effects) | — | Gap 3 P1 capture |
| **Gap 3 P1 — DONE** | Demonstration capture (`Demonstration`/`DemonstrationStep`, opt-in `demonstration_start`/`stop`, `recordToolEnd` hook with full redacted args) | — | P1 |
| **P2** | Gap 2 `command.run` (gated through Gap 1) | Gap 1 P1 | Gap 3 P1–P2 |
| **P3** | Gap 1 auto-review layer | Gap 1 P1 | Gap 2 P2 |
| **P4** | Gap 2 `browser.observe` fidelity → `browser.act` | Gap 2 P2, Gap 1 P1 | Gap 3 P2 |
| **P5** | Gap 3 generalise → draft Workflow → publish/schedule | Gap 3 P1 (+ richer once Gap 2 lands) | — |
| **P6** | Gap 2 persistent per-user workspace + first-class headless/cloud executor (**committed**, per §7.4) | Gap 2 P4 | Gap 3 P5 |

**What runs in parallel:** Gap 1's suspend/resume core and Gap 3's capture layer
touch disjoint code (`worker/src/run/execute/*` + `api/src/services/approvals*`
vs `worker/src/control/workflows.ts` + capture) and can be built at once in
separate worktrees. Gap 2's guest/executor work
(`executor/*`, `executor/guest/*.go`) is disjoint from both and can run in a third
worktree — its only cross-dependency is consuming Gap 1's gate, which is a stable
interface once Gap 1 P1 lands.

## 6. Rough effort sizing (order-of-magnitude, not commitments)

- **Gap 1 — M–L.** P1 suspend/resume is the load-bearing, correctness-critical
  piece (checkpoint fidelity, claim-once, thread slot) — treat as L. Auto-review P2
  is M (utility-model plumbing exists). Routing P3 is S.
- **Gap 2 — L.** Two schemas + dispatch is S each, but the **guest Go + CDP +
  micro-VM + host-only verification** is where the weight is, plus the
  observe-fidelity design. Persistence/headless (P6) is a separate L if taken.
- **Gap 3 — M.** Heavy reuse of the Workflow engine; the new work is capture + the
  generalisation model pass + the doorway.
- **P0 honesty fix — S**, days not weeks.

## 7. Resolved decisions — one test: the best experience for the person

These were "open decisions" in an earlier draft. They are not open. Every one has
a right answer once the question is "what is the best experience for the user,"
and that principle is Nessie's own Rule zero. Locking them so the build has no
ambiguity to stall on.

1. **Auto-review model + fail policy → `NESSIE_UTILITY_MODEL`, fail-closed to
   require-approval, cached within a run.** Best experience = the person is never
   surprised by a side effect they'd have wanted to see, and never blocked
   spuriously on a safe action. A model error becomes "ask a human," never "silently
   proceed." Keep it fast (utility model) and only reviewable actions pay the
   latency.
2. **Reviewable set → narrow.** Only real-world side effects (send / publish /
   purchase-like) and executor actuation. Best experience = zero nagging on safe
   reads; friction only where an action leaves the building. Owners can widen it,
   but the default earns trust by staying quiet.
3. **`browser.observe` fidelity → accessibility-tree-first, screenshot as an
   enhancement behind `supportsVision`.** Best experience = actuation works for
   **every** user regardless of which model their agent runs, not only the
   vision-capable providers (deepseek/kimi/minimax report `supportsVision:false`).
   The a11y tree is also more reliable to act on than pixels.
4. **Executor persistence → commit to a first-class headless/cloud executor with an
   opt-in persistent per-user workspace. Ship actuation on the ephemeral session
   first, but persistence is a committed next phase, not "if approved."** This is
   the decision the best-experience test changes most. The genuinely great
   experience is *"your agent just has a computer — always there, keeps your work"*:
   Grok's zero-setup persistence, **minus** the shared-ambient-credential model that
   is Grok's isolation weakness (§Non-goals). "Pair a Developer-ID Mac desktop app
   and get a 10-minute ephemeral session" is not an acceptable end state for the
   headline capability. So: ephemeral-first to get computer-use into hands fast (P4),
   then the cloud/persistent executor (P6) as a committed goal — encrypted per-user
   workspace, no ambient creds, per-session isolation preserved.
5. **Honesty fix → hide entirely until shipped.** Best experience = never show a
   person a capability that doesn't work. No "coming soon / disabled" tease in the
   catalog. Ships in the first week, decoupled from everything.
6. **Demonstration capture → record real runs, armed opt-in ("do it once with me,
   then save it as a routine").** Best experience = the most natural teaching gesture,
   in-context, with no separate mode to learn. No parallel "demo mode" UI.
7. **Priority/parallelism → P0 honesty fix immediately; Gap 1 P1 suspend/resume
   first as the safety substrate (and it is independently valuable — a person stops
   losing work at every approval); then Gap 2 and Gap 3 in parallel worktrees once
   Gap 1's gate interface is stable.** Best experience = ship the thing that removes
   a daily frustration first, and never ship unsupervised actuation onto a runtime
   that can't stop to ask a human.

## 8. Non-goals (scope honesty)

- No persistent ambient-credential VM (that is Grok's isolation weakness we are
  ahead of).
- No pixel/coordinate UI macros, no microphone/audio capture, no keystroke logging
  in demonstration.
- No second orchestration engine for Gap 3 — it generalises into the existing
  Workflow engine.
- No general DAG in Workflows (unchanged from the workflows-first-class scope).
- Auto-review never *weakens* deterministic least-privilege; it only adds friction.
