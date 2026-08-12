# Part 2 — What Nessie has today (code-verified, 2026-08-11)

Every claim below was checked against the tree at
`claude/inter-agent-communication-plan-b20c44`. File references are clickable.

## 2.1 The five paths an agent can reach another agent

| # | Path | Who can use it | Persisted as | Authorization check |
|---|---|---|---|---|
| 1 | **`AgentMailboxMessage`** — durable agent inbox | **Workflow engine + org owner REST only. No agent tool writes it.** | `agent_mailbox_messages` row → becomes a `Message` | recipient has an `AgentBinding` on the channel; that is all |
| 2 | **`spawn_subtask`** builtin | Any agent whose `parentAgentId` is null | New **permanent `Agent` row** + `Run` + `Task` + `PlanStep` | none beyond tool grant; depth capped at 1 |
| 3 | **`delegate`** builtin | Any granted agent | Nothing durable — invocations fold into the parent run | capped at `NESSIE_MAX_DELEGATES_PER_RUN` (16); no nesting |
| 4 | **Channel messages / @mentions** | Any agent that can post | `Message` row | channel membership + engagement decision |
| 5 | **`send_message`** builtin | **Personal Assistant only** | `Message` row authored **as the human user** | `personalAssistantOnly`; destination resolution |

### 1. The mailbox — real infrastructure, no agent access

[`api/prisma/schema.prisma:1896`](../../../api/prisma/schema.prisma#L1896) defines
`AgentMailboxMessage`. It is a genuinely well-built durable queue:

- `fromAgentId` / `toAgentId` / `actorId` / `actorType`
- `planId` / `planStepId` / `workflowRunId` / `workflowStepRunId` provenance
- `correlationId` with `@@unique([toAgentId, correlationId])` — **idempotency already exists**
- `status` (queued → processing → delivered / dead_letter), `attempts`, `visibleAt`
- fixed-step reclaim backoff — 10 s, then 30 s, then 60 s — and dead-lettering at
  3 attempts
  ([`worker/src/control/mailbox.ts:159`](../../../worker/src/control/mailbox.ts#L159)).
  Not exponential, and structurally invalid destinations (missing thread, org
  mismatch, no binding) are dead-lettered **immediately**, without retries.

Dispatch ([`worker/src/control/mailbox.ts:194`](../../../worker/src/control/mailbox.ts#L194))
claims the globally oldest queued row with `FOR UPDATE SKIP LOCKED`, then validates:
thread exists → thread's channel org matches the message org → `channelId` matches
the thread → **an `AgentBinding` exists for (toAgent, channel)**. It then creates a
`Message` and either claims the per-`(agent, thread)` run slot or writes a pending
marker, with `interactive: false`.

**The critical finding: no builtin tool creates a mailbox message.** The only
writers are [`api/src/services/mailbox.ts:145`](../../../api/src/services/mailbox.ts#L145)
(reached by the owner-only REST route) and
[`worker/src/control/workflows.ts:288`](../../../worker/src/control/workflows.ts#L288)
(the workflow step engine). An agent cannot mail another agent. The employee
metaphor's core verb is unimplemented.

### 2. `spawn_subtask` — delegation by creating a coworker

[`worker/src/run/subtask-tools.ts:45`](../../../worker/src/run/subtask-tools.ts#L45)
creates a **new persistent `Agent` row** per delegation, inheriting the parent's
`model`, `effort`, `provider`, and system prompt, with the parent's `toolPolicy`
copied minus protected explicit grants
(`stripProtectedExplicitToolPolicy`). Depth is capped at one level by
[`worker/src/run/tool-policy.ts:62`](../../../worker/src/run/tool-policy.ts#L62):
an agent that already has a `parentAgentId` is refused with
`parent_agent_subtask_denied`.

Consequences: every delegation permanently grows the org's agent roster; the
child's authority is a copy **minus protected explicit grants** — attenuation
exists but is incomplete, not absent
([`explicit-tool-policy.ts:80-87`](../../../packages/runtime/src/explicit-tool-policy.ts#L80));
and there is no expiry, no purpose, no data-scope narrowing, and no fan-out cap.

### 3. `delegate` — the ephemeral sub-agent, and a live authorization bypass

[`worker/src/run/delegate.ts:62`](../../../worker/src/run/delegate.ts#L62) runs a
fixed-budget inner agentic loop with its own MCP view. Bounded in *spend*: no
nesting, capped per run at 16, budget-limited.

It is **not** bounded in authority. The sub-agent inherits every parent builtin
except `delegate` itself
([`agent-loop.ts:72-75`](../../../worker/src/run/execute/agent-loop.ts#L72)) plus a
full MCP view, and its calls are routed through `executeGuardedBuiltin`
([`agent-loop.ts:121-139`](../../../worker/src/run/execute/agent-loop.ts#L121)) —
which performs only the DeepWater handoff suppression check before calling
`executeBuiltinTool` directly. It never calls `evaluateToolInvokePolicy`; that
lives at [`agent-loop.ts:320`](../../../worker/src/run/execute/agent-loop.ts#L320),
in the main loop's dispatch path only, and is where approval requirements are
enforced ([`agent-loop.ts:327`](../../../worker/src/run/execute/agent-loop.ts#L327):
`policyDecision.reason === 'approval_required'`).

`delegate` is also invisible: no `Run`, no identity, and no `ToolCall` rows —
its `onToolCallStart` / `onToolCallEnd` callbacks are explicit no-ops
([`delegate.ts:105-137`](../../../worker/src/run/delegate.ts#L105)).

**Consequence (G11 below): an agent that would need human approval to run a
mutating tool can call `delegate` and have the sub-agent run that same tool with
no approval check, no policy evaluation, and no tool-call telemetry.** This is
live and agent-reachable today.

### 4/5. Channel messages and `send_message`

Channel posting plus the model-judged engagement decision
([`worker/src/run/orchestrate.ts`](../../../worker/src/run/orchestrate.ts)) is the de
facto agent-to-agent surface, and it is the *right* one for conversational work.
`send_message` ([`worker/src/run/pa-tools/message-delivery.ts:19`](../../../worker/src/run/pa-tools/message-delivery.ts#L19))
lets the PA post **as the user**, recording `delegatedByAgentId` /
`delegatedFromRunId` in `Message.metadata`.

## 2.2 What we already have that the brief asks for

Nessie is further along than the brief's greenfield framing assumes:

| Brief control | Nessie today |
|---|---|
| Tamper-evident audit | ✅ `AuditLog` with per-org SHA-256 hash chain under an advisory lock ([`audit-chain.ts:103`](../../../packages/db/src/audit-chain.ts#L103)); pre-chain rows deliberately unchained |
| Append-only task events | ⚠️ `TaskEvent` is insert-only **by convention, not constraint**, and cascade-deletes with its task; no `organizationId` ([`schema.prisma:2518`](../../../api/prisma/schema.prisma#L2518)) |
| Tool invocation log | ⚠️ `ToolCall` covers **main-loop calls only** ([`tool-events.ts:38`](../../../worker/src/run/execute/tool-events.ts#L38)); inner `delegate` calls write none (G11) |
| Parameter-bound approvals | ⚠️ `ApprovalRequest` has `continuationToken`, `expiresAt`, `requiredApproverRole` — but no normalized-action hash |
| Idempotency + outbox | ✅ `QueueJob` joins the caller transaction with conflict dedupe ([`queue.ts:5`](../../../packages/db/src/queue.ts#L5)); mailbox `correlationId` unique |
| Per-run budgets + circuit breaker | ✅ `run-budget.ts`, `circuit-breaker.ts`, budget-stop, checkpoints |
| Cancellation propagation | ❌ A run polls **its own** `cancelRequestedAt`; nothing propagates to separately-created child runs |
| Egress pinning | ✅ `safeFetch` / `pinnedFetch`, SSRF guard, no stdio MCP |
| Delegated identity to externals | ✅ `X-Nessie-Context` RS256 + `X-UOA-Delegation` for Ledger/DeepWater |
| Tool policy per agent | ✅ allow/deny + `personalAssistantOnly` + `requiresExplicitGrant` — **main loop only** (G11) |
| Filesystem path confinement | ✅ `allowedRoots` with realpath, no implicit fallback root ([`sandbox.ts`](../../../worker/src/run/builtin-handlers/sandbox.ts)). Path confinement for builtin file tools — **not** process or OS isolation |

## 2.3 The gaps, ranked by how much they hurt

**G11 — `delegate` bypasses policy, approval, and telemetry. Live today.**
See §2.1(3). The sub-agent inherits the parent's whole builtin toolset and MCP
view but executes through a path that skips `evaluateToolInvokePolicy` — the
approval gate — and writes no `ToolCall` rows. This is the only gap on this list
that is **both agent-reachable and exploitable right now**, and it is the seam
every later delegation feature would inherit. It ranks first.

**G1 — Agents cannot mail each other.** The mailbox exists and is unreachable
from a run. This is the headline *capability* gap and the reason the employee
metaphor breaks.

**G2 — Peer messages arrive as `role: 'user'`, unattributed.**
[`mailbox.ts:258`](../../../worker/src/control/mailbox.ts#L258) writes the mailbox
body as a plain `user` message with no `agentId` and no provenance metadata. A
receiving agent's context cannot distinguish *the boss said do X* from *a peer
agent said do X* from *a peer relaying text a web page told it to say*.

Three corrections to how this was first written:

- **It is latent, not active.** Because of G1, no agent can write the mailbox
  today; the only live traffic is workflow mail (owner-authored templates). G2 is
  the right thing to fix *before* Phase 1, because Phase 1 weaponizes it — not
  because it is being exploited now.
- **`send_message` is not part of this defect.** The PA posting as the user is by
  design: the PA is the user's explicit delegate, and
  [`message-delivery.ts:47-56`](../../../worker/src/run/pa-tools/message-delivery.ts#L47)
  records `delegatedByAgentId` / `delegatedFromRunId`. Lumping it in overstated
  the gap.
- **Attribution machinery already exists and is being routed around.**
  [`prompt.ts:40-58`](../../../worker/src/run/execute/prompt.ts#L40) prefixes
  foreign-agent turns with the author's name, and
  [`prompt.ts:85-92`](../../../worker/src/run/execute/prompt.ts#L85) injects a
  shared-thread warning explaining the convention. But `prompt.ts:45` returns
  `role === 'user'` messages unattributed, unconditionally. The fix is therefore
  **write-side** — stamp the delivered `Message` with the sending agent's
  identity so the existing prompt builder, admin feed, and engagement
  orchestrator all inherit attribution from the row. A prompt-only "untrusted
  block" would leave the admin UI rendering agent mail as human speech: a second,
  contradictory rendering, which is the fork Rule zero forbids.

Two further paths must be made consistent with the row, or the fix is partial:
the trigger prompt does not come from the `Message` row at all
([`run-job.ts:108`](../../../worker/src/run/execute/run-job.ts#L108):
`payload.promptOverride?.trim() || message.content`), and
[`orchestrate.ts:204`](../../../worker/src/run/orchestrate.ts#L204) computes
`triggerIsHuman = role === 'user'`, so mailbox deliveries are classified as human
turns by the engagement path. Changing the role interacts with the prompt
builder's "is the trigger already the last turn?" check — handle deliberately.

**G3 — No grant object.** Authority is `Agent.toolPolicy` (a static per-agent
allow/deny map) plus channel bindings. There is no per-task authority with a
purpose, an expiry, a data-scope, a recipient list, or a delegation depth. Nothing
can be attenuated because there is nothing to attenuate.

**G4 — Sender is unauthorized and unvalidated.** `POST /api/mailbox`
([`api/src/routes/mailbox.ts:30`](../../../api/src/routes/mailbox.ts#L30)) accepts a
caller-supplied `fromAgentId` and never checks it belongs to the org or that the
caller may act as it. Owner-only today, so not currently exploitable — but it is
exactly the field an agent tool would populate.

**G5 — No mailbox surface.** `grep -rl mailbox admin/src` returns **nothing**. The
only human-visible trace is a dead-letter count on ops-health
([`api/src/services/ops-health.ts:105`](../../../api/src/services/ops-health.ts#L105)).
Inter-agent traffic is invisible. This is a straight Rule-zero violation.

**G6 — No mailbox audit entries.** Neither the REST route nor the worker dispatcher
writes an `AuditLog` row. Send, claim, deliver, and dead-letter leave no
tamper-evident record.

**G7 — No row-level security.** `grep -rli "row level security" api/prisma/migrations/`
returns **0 files**. Tenancy is enforced entirely in the service layer. Correct
today because agents never touch Postgres directly — but it means one missing
`where: { organizationId }` is a cross-tenant breach with no second line of defence.

**G8 — `spawn_subtask` permanently mints agents.** No expiry, no reaping, no
fan-out cap. A busy org accumulates thousands of one-shot `Agent` rows.

**G9 — Shared writable namespaces are unaudited as channels.** The KB
(`kb_draft_write`, `kb_note_add`, `kb_comment_add`), attachments, and `file_write`
roots are all persistent shared read/write surfaces — the exact shape the incident
exploited. They are individually authorized, but nothing watches them *as
potential channels*.

**G10 — No fail-safe *contract*, though denials are partly structured.** Policy
denials already return structured JSON with a type and reason
([`policy.ts:330-351`](../../../worker/src/run/execute/policy.ts#L330)). What is
missing is uniformity — generic builtin failures are still plain strings — and,
more importantly, a **no-circumvention contract**: nothing tells the model that a
denial is final and must not be routed around.

### Gaps found in review (2026-08-11)

**G12 — No reply path.** Delivery creates a `Task` in the *recipient's* inbox
([`mailbox.ts:306`](../../../worker/src/control/mailbox.ts#L306)); nothing routes the
recipient's completion output back to the original sender. "Results return on the
`correlationId`" was an assumption, not a mechanism — it needs an explicit
`report_back` write on run completion.

**G13 — No recipient consent.** Delivery sets `interactive: false` and bypasses
the model-judged engagement decision entirely. `AgentBinding` on the channel is
the only gate, so any sender can force a run on any bound agent.

**G14 — No loop prevention.** A `report_back` that re-triggers the requester
creates A→B→A ping-pong, and every hop is a non-interactive run that *also*
auto-continues under `NESSIE_RUN_AUTO_CONTINUATIONS`. Per-task fan-out caps do
not bound a cycle; this needs a hop count or TTL carried on the correlation chain.

**G15 — Budget amplification.** `delegate` folds into the parent's budget, but a
mailbox hop mints a **fresh run with a fresh full backstop**. Fan-out × depth
multiplies spend with only the org `Budget` as a backstop.

**G16 — No tree cancellation.** Cancel is per-run and cooperative. Nothing
cancels mailbox-spawned children when the parent is cancelled, and nothing
specifies what happens to queued mail on grant revocation.

**G17 — "Delivered" is a lie under contention.** When the `(agent, thread)` slot
is occupied, delivery writes a pending marker and still marks the row
`delivered` ([`mailbox.ts:280-296`](../../../worker/src/control/mailbox.ts#L280)).
An audit entry saying "delivered" at that moment would be false. The status
vocabulary needs `queued / pended / accepted / completed / failed`, not a single
`delivered` that means "handed off somehow".

**G18 — Directed mail lands in a shared thread.** Mail addressed to one agent is
written into a channel thread every later participant can read. Whether agent
mail belongs in a human-visible thread or a separate agent DM is undecided — and
it is a Rule-zero tension either way (invisible = unreachable; visible = noisy).

**G19 — Caller-controlled text lands in a structural field.**
`Task.purpose` is set from `(subject ?? body).slice(0, 200)`
([`mailbox.ts:308`](../../../worker/src/control/mailbox.ts#L308)) and rendered on
task lists.

**G20 — `expiresAt` would be unenforced.** The dispatcher checks no expiry, so a
`delegate_task` carrying one would be advisory only.

---
