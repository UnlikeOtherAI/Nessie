# Model-based auto-review + true approval suspend/resume

> Status: proposed plan, 2026-08-31. No code changed yet.
> Closes dimension 8 of
> [2026-08-31-grok-bot-vs-nessie-capability-audit.md](./2026-08-31-grok-bot-vs-nessie-capability-audit.md)
> ("Approvals / HITL / auto-review — Behind") and the §6 Nessie-side risk
> "Approval semantics are weaker than the UI implies". Every claim about the
> current tree below carries a file citation; the design reuses the existing
> checkpoint/continuation machinery rather than inventing a second suspend
> mechanism (Code Quality: no patches on patches, no premature abstraction).

## 0. The one-paragraph version

Today a policy-gated tool call is a **block, not a gate**: the worker returns
`{ type: 'tool_denied', reason: 'approval_required' }` to the model and the run
keeps going without the action
(`worker/src/run/execute/tool-authorization.ts:151-177`), while the machinery
that was clearly meant to make it a gate sits dead — the `waiting_approval`
run status is never written by any code path, `ApprovalRequest.continuationToken`
has zero consumers, and `createApprovalRequest` in
`api/src/services/approvals.ts` is itself uncalled (the two live approval
creators write rows directly: `worker/src/run/pa-tools/knowledge-write.ts:283`,
`worker/src/run/pa-tools/todos.ts:118`). This plan wires the dead parts to the
live ones: when a tool hits `approval_required` mid-run, the run **checkpoints
its work state with the existing `RunCheckpoint` upsert, posts an in-thread
approval card, and suspends as `waiting_approval`** — a status the thread
run-slot already treats as in-flight
(`packages/db/src/thread-serialization.ts:56`) — and a human resolve
**re-enqueues a continuation run through the existing claim-once
checkpoint/continuation pattern** (`api/src/services/run-continuation.ts`),
carrying a now-*verified, single-use, args-scoped* `approvalProof` so the
re-attempted tool passes `evaluateToolInvokePolicy`
(`worker/src/run/execute/policy.ts:95-141`). On top of that gate, a
**policy-declared model reviewer** — the same utility-model plumbing as
checkpoint notes and the watch-status gate
(`worker/src/run/execute/utility-model.ts`, `watch-status-gate.ts`) — inspects
a proposed high-risk action and answers allow / deny / escalate-to-human,
**failing closed to escalation**, so routine gated actions stop waking a human
while risky ones still do. No new suspend mechanism, no new queue, no second
approval table.

## 1. Where approvals actually stand today (evidence)

What exists, verified against the tree:

- **The chokepoint.** Every tool execution — builtins, MCP names, executor
  names, `delegate`, and nested sub-agent calls — passes
  `authorizeToolExecution` (`worker/src/run/execute/tool-authorization.ts:96`),
  called from the loop's `executeTool` at
  `worker/src/run/execute/agent-loop.ts:285` and for sub-agents at `:326`.
  Its third stage, `evaluateToolInvokePolicy`
  (`worker/src/run/execute/policy.ts:95`), resolves `PolicyRule` rows through
  the one shared evaluator
  (`packages/workspace-admin/src/policy-check.ts` `resolveDecision`,
  `defaultVerdict: 'allow'` + the run's approval proof).
- **The gate that only blocks.** `resolveRules` returns `APPROVAL_REQUIRED`
  when a matching allow rule carries `conditions.requiresApproval` and no
  proof is present (`policy-check.ts:184-196`). The worker converts that into
  `toolDeniedResult(...)` and the loop simply continues
  (`tool-authorization.ts:157-177`). Nothing creates an `ApprovalRequest`,
  nothing suspends, and no human is told.
- **The proof that proves nothing.** `options.approvalProof` is satisfied by
  *any non-empty string* (`policy-check.ts:155,184`) — it is never checked
  against an `ApprovalRequest` row, a tool, or arguments. Since no live path
  populates `actorContext.approval.approvalProof`
  (`packages/schemas/src/access-context.ts:76`), this has not yet been
  exploitable, but the moment a proof is minted it must become verifiable.
- **Vestigial suspend machinery.** `Run.status = 'waiting_approval'` exists in
  the enum (`packages/schemas/src/lifecycle.ts:107`, and in the DB enum — the
  raw SQL in `thread-serialization.ts:379` and the API's
  `ACTIVE_RUN_STATUSES` in `api/src/services/run-access.ts:6` both name it)
  and is *read* in three places — the thread-slot busy check, the API's
  immediate-cancel of a not-yet-executing run
  (`api/src/services/runs.ts:170`), and the expiry sweep that fails such runs
  (`api/src/services/approvals.ts:317-327`) — but **no code path ever writes
  it**. `ApprovalRequest.continuationToken` is minted on every row
  (`approvals.ts:24,41`; `knowledge-write.ts:297`; `todos.ts:124`) and
  consumed by nothing.
- **Approvals are deferred-action tickets, not resume points.** On approve,
  `resolveApprovalRequest` runs `runApprovalEffect`
  (`api/src/services/approvals.ts:247-273`), which knows exactly two actions —
  `knowledge.page.publish` and `agent.todo_template.publish` — and no-ops on
  everything else (`api/src/services/approval-effects.ts:121-134`).
- **The one true suspend/resume lives in workflows.** Suspended workflow steps
  hold no lease, wait on an external continuation, and are reclaimed by
  `deadline_at` (`worker/src/control/workflow-step-reaper.ts:13-16`) through
  the guarded `finishWorkflowStepRun` transition. That shape — *release the
  worker, hold a durable row, resume via a guarded transition, reap by
  deadline* — is the pattern this plan applies to chat runs.
- **The resume machinery to reuse.** Budget stops already do everything a
  suspend needs except the waiting state: `prepareRunStop`
  (`worker/src/run/execute/run-stop.ts:82`) writes a model-authored
  `RunCheckpoint` (upsert keyed on `runId`,
  `worker/src/run/execute/checkpoint.ts:152`) carrying the run's disclosure
  basis; `POST /api/runs/:id/continue` (`api/src/services/run-continuation.ts:52`)
  and the worker's `enqueueAutoContinuation`
  (`worker/src/run/execute/continuation.ts:44`) both create a fresh run +
  task + queue job and **claim the checkpoint with one conditional UPDATE**
  (`claimCheckpointForRun`, `checkpoint.ts:122`) inside a transaction that
  first checks `isThreadRunSlotBusy`; and `loadRunCheckpointForRun`
  (`checkpoint.ts:65`) lets a pre-claimed continuation find its state on
  pickup (`worker/src/run/execute/run-setup.ts:252`). The admin already
  renders a Continue affordance off `metadata.runStop`
  (`admin/src/components/features/channels/RunStopContinue.tsx`).
- **No model-based auto-review exists anywhere** — "review" in the tree is
  human review of discovered MCP tools. The utility-model plumbing it needs is
  live and proven: `resolveUtilityModel`
  (`worker/src/run/execute/utility-model.ts`, `NESSIE_UTILITY_MODEL` pinned to
  the run's own org provider route) drives compaction, checkpoint notes, the
  delegate sub-agent, and the watch-status disposition call
  (`worker/src/run/execute/watch-status-gate.ts` — a one-call structured
  judgement with an explicit fail-open decision; ours fails the other way, §4).

## 2. Design decisions

1. **One suspend mechanism: the checkpoint.** A suspended run's work state is a
   `RunCheckpoint` row with `reason: 'approval_required'` — the `reason`
   column is a free string precisely so classifications can evolve without
   migrations (`api/prisma/schema.prisma` RunCheckpoint comment). No new
   "run state" table, no serialized transcript blob. What the checkpoint's
   model-authored note cannot carry (it is UNTRUSTED narrative by design,
   `checkpoint.ts:7-13`) — the exact tool name, args, and resume identity —
   lives typed and server-authored on the `ApprovalRequest` row.
2. **`waiting_approval` becomes a real state with exactly one writer and three
   exits.** Written only by the worker's suspend path; exited by approve
   (→ continuation run + original `completed`), reject (→ `completed` with a
   rejection notice), or expiry/cancel (existing sweeps, §3.4). The status
   already holds the thread run-slot (`thread-serialization.ts:56`), so
   messages arriving mid-wait pend and drain exactly as they do around any
   in-flight run — that behaviour ships today and is why no slot changes are
   needed.
3. **The proof becomes verifiable, single-use, and args-scoped.** An
   `approvalProof` is `ApprovalRequest.continuationToken`, accepted only after
   the worker re-reads the approval row and checks: org matches the run's,
   status `approved`, token equality, `action === 'tool.invoke'`,
   `toolName` matches, `argsHash` matches the SHA-256 of the canonical
   JSON of the proposed args, the run is in the approved run's continuation
   lineage, and `proofConsumedAt` is claimed by set-once conditional update.
   A proof therefore authorizes **one execution of one tool with byte-identical
   arguments** — the model changing its mind about the args re-enters the gate.
   This closes the "any non-empty string" hole before it becomes reachable.
4. **Auto-review is policy-declared, model-judged, and fail-closed.** *Which*
   actions get reviewed is a structural fact declared on the `PolicyRule`
   (`conditions.reviewMode: 'auto'` beside the existing
   `requiresApproval`/`approvalActionType`,
   `packages/schemas/src/governance.ts:85-86,104-105`) — never inferred from
   message content. *Whether* a specific proposed action is safe is the
   model's judgement, in any language (AGENTS.md "Natural-language intent is
   model-judged"). A reviewer error, timeout, or unparseable verdict
   **escalates to the human gate** — the exact inverse of the watch-status
   gate's fail-open, because there a miss costs one redundant message and here
   it would execute an unreviewed side effect.
5. **Approve resumes a fresh run; it never revives the suspended one.** The
   continuation-run idiom (fresh `Run` + `continuationOfRunId` lineage +
   claim-once checkpoint + fresh queue job key) is what makes restart, budget
   accounting, and at-least-once queue delivery already work; re-enqueueing
   the same `runId` would fork all of it. The suspended run terminalizes as
   `completed` at resolve time — mirroring how a budget stop completes with a
   notice (`worker/src/run/execute/run-job.ts:497`).

## 3. True approval suspend/resume

### 3.1 Worker: the suspend path

`authorizeToolExecution` gains a third decision arm:

```ts
| { decision: 'suspend'; approval: { id, toolName, argsHash, reasonSummary } }
```

produced when `evaluateToolInvokePolicy` returns `approval_required` **and**
the run is eligible to suspend. Eligibility is structural: not a delegate
sub-agent call (nested calls keep today's deny — a sub-agent has no run row of
its own to suspend; the audit-silent `emitAudit` seam at
`agent-loop.ts:344-349` marks that boundary already), and not a DeepWater
handoff turn (those keep their own recovery matrix untouched). Inside the
chokepoint, before returning `suspend`:

- Create the `ApprovalRequest` idempotently — unique on `(runId, toolCallId)`
  (§5) so a crash-redelivered job that replays the same provider tool call
  finds its row instead of minting a twin. Fields: `action: 'tool.invoke'`,
  `context` (member-visible: `{ toolName, inputSummary:
  summarizeToolInput(args), policyRuleId, approvalActionType }` — the bounded
  summary the audit denial already records, `tool-authorization.ts:139`),
  server-only `toolCallId`, `argsHash`, `args` and the resume identity inside
  the new non-presented `resumeState` column (§5), `runId`, `taskId`,
  `agentId`, `requesterId = agentId`, `requiredApproverRole` from the rule's
  `approvalActionType` mapping when declared, `expiresAt` (default 30 min,
  `approvals.ts:7`).
- Return `suspend` to the loop.

The loop (`runAgenticLoop`) learns one new exit, exactly parallel to
`cancelled`: `executeTool` returning a sentinel makes the loop stop issuing
work and return `LoopResult` with a new `pendingApproval: { approvalId } |
null` field (any *other* gated calls in the same tool batch are answered with
the ordinary denial result; they never reach another inference because the run
suspends first — on resume the model re-plans, see §11.3).

`run-job.ts` then handles the exit beside its `cancelled` and
`exhaustedBudget` branches (`run-job.ts:468-534`):

1. **Checkpoint.** `prepareRunStop`'s note generator is reused via a thin
   `prepareApprovalSuspend` in a new
   `worker/src/run/execute/approval-suspend.ts`: `generateCheckpointNote` +
   `persistRunCheckpoint` with `reason: 'approval_required'`,
   `basis: runReplyBasis(context)` (the checkpoint carries the run's
   disclosure basis exactly as budget stops do, `run-stop.ts:110-124`),
   `generation: priorGeneration + 1`.
2. **Notice message.** Post partial text (if any) + a waiting notice through
   `createAgentMessage` — the one write chokepoint, so the basis is stamped —
   with `metadata.approvalGate = { approvalId, runId, toolName, status:
   'pending' }`, the same metadata-driven-affordance pattern as
   `metadata.runStop` (`run-job.ts:566`, rendered by `RunStopContinue.tsx`).
3. **State flip.** `updateRunStatus(prisma, runId, 'waiting_approval')` —
   non-terminal, so `finishedAt` stays null and the 👀 working marker is
   deliberately **kept** (`lifecycle.ts:31-47`): the agent is still on the
   message. `setAgentStatus(..., 'waiting_approval')` (the `AgentStatus` enum
   already has it, `lifecycle.ts` widens its accepted union). Task →
   `awaiting_approval` (`TaskStatusSchema` already has it).
4. **Realtime + alert.** Publish `approval.needed` on org + channel scopes
   (today only `approval.resolved` exists, `api/src/routes/approvals.ts:92`;
   the worker publishes via `deps.realtimeTransport` like
   `publishRunUpdated`), and record `run.suspended` as a `TaskEvent`
   (mirroring `run.budget_exhausted`, `budget-stop.ts:136`). A durable
   `UserAlert` + push for role-routed approvals follows the
   trigger-health precedent (once per approval, revalidated on read) in
   stage 3 — §9.
5. **Complete the queue job.** The worker holds nothing: like a suspended
   workflow step, the waiting run is a durable row with a deadline, reaped by
   `sweepExpiredApprovals`. **Do not drain pending thread messages** — the
   slot is intentionally held so interleaving turns pend
   (`claimThreadRunOrPend` sees `waiting_approval` as active).

### 3.2 API: resolve → resume

`resolveApprovalRequest` (`api/src/services/approvals.ts:156`) keeps its
atomic pending→resolved claim, self-approval / live-role / expiry guards, and
effect dispatch untouched. A new `runApprovalEffect` case, `'tool.invoke'`,
delegates to `resumeRunFromApproval` in a new
`api/src/services/approval-resume.ts` — a sibling of `run-continuation.ts`
that reuses its transaction shape rather than forking it:

**On approve**, one transaction:

1. Guard: the linked run is still `waiting_approval` (conditional UPDATE
   `waiting_approval → completed`, `finishedAt = now()`; count 0 → the run was
   cancelled or expired meanwhile — record `effect: run no longer waiting` in
   the resolution note, exactly the "failed effect stays approved" contract at
   `approvals.ts:246-272`). This flip happens under the same advisory-locked
   slot check as every run-creation path, and *before* the new run is
   created, so `isThreadRunSlotBusy` (which counts `waiting_approval`) cannot
   deadlock the resume against itself.
2. Create the continuation run: `continuationOfRunId = suspendedRun.id`,
   inherited `replyPlacement` (the resume answers the same exchange —
   `run-continuation.ts:141-144`), same `threadId`/`principalUserId`,
   `triggerMessageId = suspendedRun.triggerMessageId`.
3. `claimCheckpointForRun` — the set-once conditional update; a lost race
   (a concurrent expiry sweep, or an operator's `/continue`) rolls the unit
   back and reports `ALREADY_RESOLVED`-style feedback.
4. Create the task, `run.continued` TaskEvent
   (`{ auto: false, fromApprovalId }`), and enqueue with key
   `run:approval:<newRunId>` — the fresh-key rule of
   `run-continuation.ts:202-205`.
5. The enqueued payload's `actorContext` is the **original run's**, restored
   from `ApprovalRequest.resumeState` (the pending-message table already
   persists actor contexts as JSON for later replay,
   `thread-serialization.ts:167` — same precedent), with
   `approval: { approvalProof: continuationToken, approvalRequestId }` set.
   The resolver is *recorded* (`resolverId`, audit) but the run keeps acting
   as its original principal — approving is consent, not impersonation.

Post-commit: `approval.resolved` WS event (already published by the route),
update the notice message's `metadata.approvalGate.status`, and edit nothing
else — the continuation run's own lifecycle events carry the rest.

**On reject**: flip the run `waiting_approval → completed`, post a notice into
the thread ("<resolver> declined *toolName* — reply to continue without it")
via the API's message service with `metadata.approvalGate.status =
'rejected'`, leave the checkpoint **unconsumed** so a plain reply resumes with
full context through the ordinary auto-load (`run-setup.ts:252`) — the model
then knows the action was declined because the rejection notice is in its
transcript. Terminalizing releases the slot; pended messages drain via the
existing `sweepPendingThreadMessages` re-poll (`thread-serialization.ts:360`),
which covers exactly this "API-side transition no worker observes" case per
its own header comment.

### 3.3 Worker: the resume run

Nothing new is needed for pickup: the continuation run finds its pre-claimed
checkpoint (`loadRunCheckpointForRun` matches `consumedByRunId: runId`,
`checkpoint.ts:74-77`) and injects it under the untrusted framing. Two
additions:

- A structural prompt line (from the approval row, never from content):
  "A human approved your proposed `<toolName>` call; re-issue it to proceed"
  — so the model re-attempts deliberately rather than rediscovering the need.
- `evaluateToolInvokePolicy` verifies the proof per §2.3 before passing it to
  `resolveDecision`, and claims `proofConsumedAt` set-once at the moment the
  verified call is authorized. Different args → no proof → the gate fires
  again (a fresh approval, correctly). The verification read is one indexed
  lookup on `approvalRequestId`, paid only on runs that carry a proof.

### 3.4 Expiry and cancellation

- **Expiry** already half-exists: `sweepExpiredApprovals`
  (`approvals.ts:301-332`, driven by `api-maintenance.ts`) flips expired
  approvals and fails `waiting_approval` runs. It gains: a thread notice
  ("approval expired — reply to retry") with
  `metadata.approvalGate.status = 'expired'`, task → `failed`, agent →
  `idle`, and it keeps the checkpoint unconsumed for a reply-resume. Slot
  release again drains via the pending-message sweep.
- **Cancel** needs one addition: `POST /api/runs/:id/cancel` already
  terminalizes a `waiting_approval` run atomically (`runs.ts:170`); it now
  also expires the linked pending approval
  (`updateMany({ where: { runId, status: 'pending' } })` — reusing the
  `expired` status, no enum change) and stamps the card metadata, so a
  cancelled run cannot leave a live Approve button pointing at a dead run.
  The reverse race — approve landing first — is already handled by §3.2's
  conditional flip.

## 4. Model-based auto-review

### 4.1 What it gates

A `PolicyRule` with `conditions: { requiresApproval: true, reviewMode:
'auto' }` (schema extension in `packages/schemas/src/governance.ts`; the
evaluator in `policy-check.ts` surfaces `reviewMode` on the
`APPROVAL_REQUIRED` decision the same way it surfaces
`approvalActionType`). Semantics:

- absent / `reviewMode: 'human'` — §3 exactly: suspend for a human.
- `reviewMode: 'auto'` — the reviewer model judges first; **allow** executes
  without waking a human, **deny** returns a reasoned `tool_denied` to the
  model (it can adjust and retry), **escalate** — including every reviewer
  failure — falls through to §3's human suspend.

The selection of gated tools is structural (rule scope chain: org / team /
channel / agent / tool ids, `buildScopeChain` in `policy-check.ts:107`); the
judgement of a *specific proposed call* is the model's. No keyword lists, no
"looks risky" regexes, anywhere.

### 4.2 Plumbing

The reviewer is one bounded utility call at the chokepoint. `ToolAuthorization
Hooks` (`tool-authorization.ts:52`) gains an optional `reviewProposedAction`
seam, wired in `agent-loop.ts` from `input.inference.runUtility` — the same
function compaction and checkpoint notes use (`agent-loop.ts:192-199`), so it
inherits Ledger routing, signed attribution, and `NESSIE_UTILITY_MODEL`
resolution (`utility-model.ts:14`) with zero new inference paths, and its
invocations are pushed into the caller-owned `invocationSink` so the spend is
metered against the run like every other call.

Reviewer input (server-composed): the tool name and JSON-schema description,
the full proposed args (middle-out-truncated through the existing
`tool-util.ts` chokepoint), the run's goal line, the last assistant turn, and
the rule's `approvalActionType` label. Reviewer output: a strict JSON verdict
`{ verdict: 'allow' | 'deny' | 'escalate', reason: string }`, parsed with a
zod schema; anything else **is** an escalation (fail-closed, §2.4). Test
fixtures must include non-English, slang, and misspelled content in the args
and goal (AGENTS.md intent rule).

### 4.3 Recording and composition

Every reviewer verdict is recorded: the existing `policy.evaluated` audit
event gains `metadata.autoReview = { verdict, reviewerModel }` on both allow
and deny (allow currently emits no audit — it starts to, for reviewed calls
only), plus a `tool.auto_reviewed` `TaskEvent` so the run timeline shows the
machine judgement. An escalation produces a normal §3 approval whose `reason`
carries the reviewer's own explanation of what made it hesitate — the human
sees *why* they were woken. Deliberately **no** `ApprovalRequest` row for
auto-allows: the audit chain is the tamper-evident record
(`packages/db/src/audit-chain.ts`), and a synthetic pre-resolved approval per
routine call would bury the Approvals page in noise (Rule zero check 3).

### 4.4 Cost and latency

One utility call per *gated* call only — an ungated tool pays nothing, and the
gate itself is opt-in per rule. Budgeted like compaction: counted in run
totals, subject to the run's token/cost caps, so a pathological gated-tool
loop cannot review for free. Expected added latency per gated call is one
small-model round trip; acceptable because the alternative was a human
round trip. No caching of verdicts across calls: `argsHash` differing means a
different action, and identical repeats are already collapsed by the loop's
repeated-tool-call guard.

## 5. Data model and migrations

One new migration folder (immutable once committed; never edits an existing
folder — `pnpm lint:migrations` enforces this), all additive:

- `approval_requests`:
  - `tool_call_id TEXT NULL` + partial unique index
    `(run_id, tool_call_id) WHERE tool_call_id IS NOT NULL` — suspend
    idempotency (§3.1).
  - `args_hash TEXT NULL` — proof scoping (§2.3).
  - `resume_state JSONB NULL` — server-authored `{ actorContext, messageId,
    interactive, args }`; **never emitted by `mapApproval`**
    (`approvals.ts:336`) or any presenter, mirroring how trigger provenance
    is stripped before leaving the server.
  - `proof_consumed_at TIMESTAMPTZ NULL` — single-use claim (§3.3).
- No `Run` changes: `waiting_approval` already exists in the DB enum (§1), and
  lineage/`replyPlacement`/`triggerMessageId` columns already carry everything
  the resume needs. No `RunCheckpoint` changes: `reason` is a free string.
- No new tables, no `ApprovalStatus` enum change (`pending / approved /
  rejected / expired` suffice; run-cancel reuses `expired`).
- Verify the whole chain on a throwaway pgvector container before merge (the
  established migration-check recipe).

Non-`CONCURRENTLY` index creation is fine here (`approval_requests` is small
and not on the lint-warned hot tables).

## 6. Rule zero — the home and the doorways

- **Owning surface: `/approvals`** (`admin/src/pages/ApprovalsPage.tsx`,
  routed in `admin/src/router.tsx:321`). It gains a renderer for
  `action: 'tool.invoke'` cards — tool name, args summary, requesting agent,
  originating channel link, Approve/Reject — beside the two existing
  publish-action renderers, using the same
  `useApprovalRequests`/`useResolveApproval` facade
  (`admin/src/facades/approvals/hooks.ts`).
- **In-context doorway 1: the in-thread approval card.** A new
  `RunApprovalGate.tsx` beside `RunStopContinue.tsx`
  (`admin/src/components/features/channels/`), driven by
  `metadata.approvalGate` on the notice message exactly as Continue is driven
  by `metadata.runStop` — Approve/Reject inline for entitled viewers
  (the API's `approvalVisibilityWhere` + self-approval/role guards decide;
  the card just relays the route's refusal verbatim, the
  `RunStopContinue` toast pattern), live-updated by `approval.needed` /
  `approval.resolved` WS events. The card is where the requester's colleagues
  are already standing when the agent pauses — the doorway check.
- **In-context doorway 2: the pending badge.** The existing
  `GET /api/approvals/pending/count` feeds a count pill on the `/approvals`
  nav entry, so a pending gate is visible from anywhere.
- **Policy config: `/policy`** (`admin/src/pages/PolicyPage.tsx`). The rule
  editor gains the `requiresApproval` / `reviewMode` / `approvalActionType`
  condition fields with plain-language labels ("Ask a human first" / "Let a
  reviewer model triage, ask a human when unsure"). This is the owning
  surface for *which tools are gated*; its in-context doorway is a "Gated by
  policy" pill on the tool rows of the agent's tool listing (ToolsPage /
  Agent Designer) linking to `/policy` — the pill names the decision it
  drives: click to see or change the gate.
- Every element names its decision: the card answers "may this action run",
  the badge answers "is anything waiting on me", the pill answers "why did my
  agent pause". Reviewer telemetry beyond the audit log is deliberately not
  given a page (check 3 — no decision it would drive yet).

## 7. Disclosure and tenancy invariants

- **The checkpoint carries the basis.** `persistRunCheckpoint` already stamps
  the suspending run's `RunBasisScope` rows and the resume path already
  subjects the note to the untrusted framing + basis inheritance
  (`checkpoint.ts:26-37,105-108`); the suspend path changes none of that —
  it is the same function budget stops call.
- **The notice message goes through `createAgentMessage`**, the one write
  chokepoint, so a suspend notice built after the run consumed a privileged
  source is basis-stamped and withheld from unentitled viewers like any other
  run reply (§ disclosure rules in AGENTS.md).
- **The approval card is bounded.** Member-visible `context` carries only
  `summarizeToolInput(args)` — the same bounded summary the audit trail
  already records — never full args; full args live in the non-presented
  `resumeState`. Visibility is the existing `approvalVisibilityWhere`
  (`approvals.ts:73-91`: owners org-wide, others requester-or-channel-reach),
  and resolving takes the same gate plus live-role re-read. An owner seeing a
  summary of an action their agent proposed in a channel they govern is the
  intended entitlement, not a leak.
- **Tenancy.** The approval row copies the run's org/project/team/channel at
  creation (as today); `resumeRunFromApproval` loads the run through
  `loadRunForOrg` and the proof verification re-checks
  `organizationId` — a `continuationToken` is not a capability across orgs.
  The resume payload's restored `actorContext` still passes
  `validateRunActorContext` (`policy.ts:190`) on pickup, so a tampered
  `resumeState` write would hard-fail the run rather than act cross-tenant.
- **Proof ≠ policy bypass.** A verified proof satisfies exactly the
  `requiresApproval` condition of the matching rule; deny rules still
  override (`resolveRules` returns EXPLICIT_DENY before any allow is
  considered), and the registry/grant gate still runs first — an approval
  cannot resurrect a tool the agent was never granted.

## 8. Testing

- **Unit (worker):** the new authorization arm (suspend vs deny vs allow;
  delegate calls still deny; DeepWater turns untouched); proof verification
  matrix (wrong org / wrong tool / args drift / consumed / rejected / expired
  → no proof passed); reviewer verdict parsing incl. garbage → escalate;
  loop exit ordering (gated call mid-batch). Worker unit suites run with the
  existing `--test-concurrency=4` constraints.
- **DB-backed (api/test):** resolve→resume transaction — claim-once under two
  concurrent approves (exactly one continuation run); resume vs cancel race
  (conditional `waiting_approval → completed` flip loses cleanly); expiry
  sweep terminalizes + preserves the unconsumed checkpoint; reject leaves a
  reply-resumable state; `resumeState` never appears in any presenter
  response. Per the shared-DB rules: no global counts, cleanup scoped to the
  seed's ids, and any suite driving the pending-message sweep lives in
  `worker/test/db/` with `assertGlobalQueuesQuiet`. Note `waiting_approval`
  runs are *excluded* by `sweepPendingThreadMessages`' NOT EXISTS (it lists
  the status, `thread-serialization.ts:379`) — assert that a suspended run's
  pended messages do **not** drain early, and prove the test fails without
  the fix (the established discipline).
- **Mock-LLM harness (`@nessie/mock-llm`):** an end-to-end scenario — scripted
  run proposes a gated tool → suspend, `waiting_approval` visible → scripted
  resolve → continuation run re-issues the call with proof → executes →
  completes; and the auto-review variant with a scripted reviewer turn for
  each verdict. Fixtures include non-English/slang args per the intent rule.
- **UI:** headless Playwright against `http://localhost:5455` — the in-thread
  card renders and resolves, the Approvals page shows the tool-gate card, the
  policy editor round-trips `reviewMode` — screenshots before done
  (AGENTS.md Verification).

## 9. Staged rollout

1. **Stage 1 — the gate becomes real.** §3 + §5 + the in-thread card and
   Approvals-page renderer. Behaviour changes *only* where a rule already
   declares `requiresApproval` — an opt-in that today produces a confusing
   silent denial, so the stage is strictly an improvement; no env flag needed.
2. **Stage 2 — auto-review.** §4 behind the `reviewMode: 'auto'` condition
   (opt-in per rule again). Requires `NESSIE_UTILITY_MODEL` resolution;
   unresolved → every review escalates (fail-closed degrades to Stage 1, never
   to open).
3. **Stage 3 — reachability polish.** Pending-count nav badge, durable
   `UserAlert` + push for role-routed approvals (trigger-health alert
   precedent), policy-editor affordances, "Gated by policy" pills.

Each stage is its own worktree branch, merged after review/lint/tests in the
same turn, worker rebuilt after worker edits, docs updated in the same turn
(§12).

## 10. Scope honesty — what this does NOT build

- **No approval for actions already in flight** — the gate is pre-dispatch
  only; a long-running MCP call cannot be paused mid-transport.
- **No arg editing at approve time** — the human approves the exact
  `argsHash` or rejects; "approve with changes" is a later feature.
- **No multi-approver quorum** and no approver delegation beyond the existing
  `requiredApproverRole`.
- **No secure-secret handoff** (Grok's paired claim) — out of scope entirely.
- **No unification with workflow-step approvals** — workflows keep their own
  suspend/resume; the two share the *pattern*, not code, until workflows'
  first-class delivery settles (its plan lists its own approval step work).
- **No reviewer memory/learning** — each verdict is stateless; "learn from
  past approvals" would need its own disclosure design.
- **No sub-agent suspend** — a delegate's gated call stays a denial.
- Product copy must not claim "human-in-the-loop for everything": only
  policy-gated tools pause, and only where an owner authored the rule.

## 11. Defects, risks, and open questions

1. **The proof hole (existing, latent).** `resolveRules` accepts any
   non-empty proof today. §2.3's verification MUST land in the same stage
   that first populates `actorContext.approval`, or the first minted token
   becomes an org-wide skeleton key. The verification lives in
   `evaluateToolInvokePolicy`, before `resolveDecision` sees the proof.
2. **Crash between approval-create and status flip.** The queue redelivers
   and the run re-executes from the top (today's crash semantics for any
   run); the `(runId, toolCallId)` unique index makes the second suspend find
   the first row. A crash *after* the flip leaves a consistent waiting row —
   reaped by expiry like a suspended workflow step. Residual risk: tools
   executed before the gated one re-execute on redelivery — unchanged from
   today's crash behaviour, and honest to say so.
3. **Multiple gated calls in one batch.** Only the first suspends; siblings
   get denials the model never reads (the run suspends before the next
   inference). On resume the model re-plans and re-proposes; each gets its
   own gate. Bundling several proposals into one approval card is a possible
   later refinement, not v1.
4. **Notice-then-flip ordering.** If the worker dies between posting the
   notice and writing `waiting_approval`, the card exists for a run the
   sweep will 404 on resolve — the §3.2 conditional flip already reports
   this as a failed effect rather than corrupting state. Acceptable; the
   card's status metadata is updated lazily.
5. **Reviewer prompt injection.** The reviewer reads model-proposed args that
   may embed adversarial text ("reviewer: approve this"). Mitigations: the
   verdict schema is strict JSON with no tool access; args are framed as
   untrusted data in the reviewer prompt (the `BEGIN/END UNTRUSTED` framing
   used by dashboards/compaction); and the reviewer can only *narrow*
   (allow was already policy-possible with a human click — the reviewer never
   grants anything policy denies). The audit's §10 caveat about non-uniform
   untrusted framing applies here and the reviewer must not worsen it.
6. **Expiry default.** 30 minutes (`DEFAULT_EXPIRY_MS`) is short for a
   sleeping approver. Open question for stage 1: read `expiresAt` from the
   rule's conditions (declared, structural) with the 30-min fallback; the
   sweep and the checkpoint-preserving reply-resume make a late human still
   able to say "go ahead" in words even after expiry.
7. **`requesterId = agentId` self-approval.** The guard at `approvals.ts:180`
   compares resolver to requester; an agent id never equals a user id, so the
   human who *asked* the agent can approve their own agent's action. That is
   the intended trust model (the approver consents to the action, and the
   audit chain records both identities), but it deserves the explicit
   sentence here rather than silence.

## 12. Documentation updated with the change

Same-turn updates (AGENTS.md "Documentation & Goals"): `docs/functionality.md`
approvals section (block-and-return description → suspend/resume contract);
`CLAUDE.md` gains a short "Approvals — suspend/resume + auto-review" pointer
section; the capability audit's dimension 8 gets a "closed by" banner once
stages land; this plan moves to `docs/done/` when stage 3 completes.
