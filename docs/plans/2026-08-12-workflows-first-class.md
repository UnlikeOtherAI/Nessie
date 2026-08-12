# Workflows, made first-class

> Status: approved plan, in delivery — **revision 3**
> Supersedes the target-state sections of
> [2026-04-15-n8n-inspired-workflow-tools-and-triggers.md](./2026-04-15-n8n-inspired-workflow-tools-and-triggers.md)
> and completes the founding decision of
> [2026-04-07-workflow-builder.md](./2026-04-07-workflow-builder.md) ("Workflows Are Tools").
> Derived from three independent code reviews (2026-08-12), then audited by the
> same three reviewers against this document. Findings are tracked to completion
> in §12. Revision 2 incorporated that audit; revision 3 incorporates a second
> confirmation round that caught contradictions revision 2 itself introduced.
> §11 records what changed and why.

## 0. The one-paragraph version

Nessie's workflow *persistence and choreography* are worth keeping; the runtime
built on them is not yet dependable, and the surface above it is a lie. The
run/step model, the mailbox suspend/resume choreography, and the trigger
scheduler are real foundations — but terminal writes are unguarded, children
outlive cancellation, async terminal events never fire, execution definitions
mutate mid-flight, and stuck steps are never reclaimed. Above that: the graph
contract is a flat list, the canvas draws edges the runtime discards, installed
"versions" are decorative, and the whole surface is owner-only and invisible from
chat. The deterministic layer cannot deliver its own output — the only way a
workflow result reaches a human is by paying for an agent hop, which inverts the
entire economic argument for having workflows. This plan fixes the correctness
defects first, adds the primitives that unlock every real use case, and wires
workflows into channels, agents, approvals, budgets, and the audit trail. It
deliberately never builds a general DAG, a code node, a connector catalogue, or a
second scheduler.

**Scope honesty:** what Stages 1–2 deliver is a *guarded sequence runner* —
Playbooks. It does not model parallel independent work or per-item batch actions.
Where this document says "workflow" it means that, and product copy must not
claim multi-system orchestration the engine cannot execute (§2, DAG row).

## 1. What a workflow is for

Agents already loop, call tools, retry, and fire on a schedule. So a workflow
must earn its existence by providing a guarantee an LLM cannot:

1. **A cost and latency floor.** A watcher sweeping 96×/day must not spin an
   agentic loop 96×/day. Deterministic steps cost ~0 tokens; the agent is invoked
   only on the sweeps where something actually changed.
2. **Pinning.** When a procedure is solved, re-deriving it through fresh
   inference every time is variance with a bill attached. A workflow is the
   promotion target: the same steps, now deterministic, reviewable, versioned,
   and policy-checked. This is also the compliance story — an approval on a
   workflow step approves the *exact* side effect, not an agent's paraphrase.
3. **An authority boundary.** A workflow runs as a durable identity with a fixed,
   policy-checked tool set. You can hand it to a trigger without granting an
   agent broad tool policy.
4. **Durable waiting.** A suspended workflow holds a database row. A waiting
   agent holds a run slot and a budget.

**The governing design rule that follows: never build a Router node.** Branching
on meaning is the one thing agents do natively and deterministic graphs do
badly. An agent step returns a structured verdict and the runner switches on it —
judgment stays in natural language, the edge stays deterministic. This single
rule removes most of the n8n control-flow surface area from scope.

## 2. Scope decisions (made, not open)

These were contested across the three reviews. Decided here so implementation
does not relitigate them.

| Question | Decision | Why |
|---|---|---|
| General DAG with free-form edges? | **No** — and the product is therefore named **Playbooks**, not workflows, in user-facing copy. Guarded sequence with forward-only `next`/`goto`, modelled on Amazon States Language, not n8n. | Every valuable use case reviewed is a sequence with conditions and error paths. A DAG engine is a second product. The naming constraint is binding: a guarded sequence cannot model parallel independent work or a real join, so we must not market those. |
| Conditions as branch nodes? | **No.** Step-level `when:` guard. Requires: forward references validator-proven, skipped steps materialised as `skipped` rows, and agent verdicts schema-validated before a guard reads them. | Keeps the executor a single forward pass; kills demand for routers. |
| Error routing? | **Yes**, `onError: fail \| continue \| { goto }`, forward-only. | Reviewers split; error routing is genuinely needed, cycles are not. |
| Loops / foreach? | **Deferred with a named decision point, not "never".** A bounded `map` (N ≤ k, implicit join) is revisited at the end of Stage 3. §10's "never" applies to *unbounded* loop nodes only. | Two reviewers noted real collection-shaped cases (release notes over N PRs, connector results). Claiming no use case exists was wrong; deferring is defensible. |
| MCP connector steps? | **Yes, Stage 3**, only through the existing `@nessie/mcp-manage` `resolveInstanceMcpTransport`/`callInstanceTool` seam, and **hard-gated on two prerequisites: the per-installation tool allow-list (§4.4) and the secret-taint boundary (W0).** | The objection was forking the credential/policy model. Reusing the one seam answers the transport half; the allow-list answers the policy half. Without both, Stage 3 ships a second, weaker-governed path to the same tools. |
| Sandboxed JS / code node? | **Never.** | Sandbox escape is RCE in the worker. JMESPath covers ~95% projection work. `environment_launch` is the governed escape hatch. |
| Collapse `WorkflowTemplate` + `WorkflowInstallation`? | **Not now — explicit Stage 4 decision point.** | The correctness bug it is often paired with (version pinning) is fixed independently by run-level snapshots. Collapsing is irreversible if a shared template library is ever wanted. |
| Immutable `WorkflowVersion` table? | **Stage 2, as §4.2a — before `invoke_workflow`/`approval`, and a hard prerequisite for them and for `connector_call`.** Stage 1 uses run- and installation-level snapshots (W4). | A callable contract, an approval, and a governed side effect must each refer to an exact published definition; building those against mutable-template APIs first means rewriting every one. Revision 1 deferred this to Stage 4; revision 2 moved it to Stage 3 but left its dependants in Stage 2, which was not topologically executable; revision 3 moves it into Stage 2 ahead of them. |
| Canvas as primary authoring? | **No.** Conversational (PA-authored) primary; step-list editor secondary; canvas becomes truthful viewer/run-replay. | A designer that renders semantics the runtime cannot execute is worse than no designer. |
| Second scheduler for workflows? | **Never.** `AgentTrigger` already carries `workflowInstallationId`. | One claim protocol, one cron library, one delivery/dedupe model. |
| Ship unconditionally? | **No.** One adoption gate, at the **end of Stage 2** (§9), with seeded playbooks shipped alongside Stage 2 so the gate has something to measure. | The original recommendation was conditional investment. If seeded playbooks see no repeat use, we stop and keep Agent Triggers. |

## 3. Stage 1 — Stop lying, become reachable (target: 2 weeks)

Stage 1 makes the existing thing truthful, correct, and visible. It introduces no
graph *topology* — but it does extend the step contract additively (`when:`,
`transform`), so §4.1's shared contract seam is defined here and filled in
Stage 2, rather than being invented twice.

**Items are not independently mergeable.** The ordering constraints are binding:

- **W0 gates W15, W17, W19, W20, W21** — every member-visible surface and every new
  data sink. Nothing that widens visibility or adds a rendering path merges before
  the redaction boundary.
- **W1 gates W2** — cancel propagation makes the unguarded write fire on *every*
  cancel; merging W2 first turns a latent race into a certainty.
- **W3 gates W21 and W23** — run cards and failure push consume terminal events never
  emitted when the last step is async, i.e. the common case.
- **W1, W3, W6 gate the `onOverlap: 'queue'` release path** (§6): a missed terminal transition
  becomes a silent permanent queue stall.

**Minimum viable subset**, if the two weeks are short — ship these as a block and
let the rest slip together: W0, W1–W8, W15, W16, W18, W22, **W26** (exit criterion
6, overlapping fires produce one run, cannot be met without it; W18's CAS only
*detects* the collision). W16 carries the JMESPath evaluator module — including
its off-event-loop envelope (§5) — into scope even when W17's `transform` step
and designer preview slip; `when:` needs it too.

### 3.0 W0 · The redaction boundary (blocking prerequisite)

Revision 1 put the secret-taint boundary in Stage 2 while widening read access in
Stage 1 — a contradiction all three auditors flagged as the plan's single most
important error. `resolvedBindings` and `config` are arbitrary JSON today,
interpolated into step inputs, persisted, and rendered in the run inspector.

A minimal boundary therefore ships **first**, covering four sinks, not just reads:

1. **Read widening** (W19) — member-visible responses.
2. **Message rendering** (W15) — a channel sink for interpolated values.
3. **Transform context** (W17) — full-context expressions.
4. **Persisted samples** (§5).

Minimum: declare in `bindingSchema` which bindings are references vs literals;
persist only server-minted `secret_*` refs; mark tainted values; redact them from
run JSON, prompts, messages, logs, exports, and samples. The full typed model
lands in §4.4; the boundary itself cannot wait.

### 3.1 Correctness fixes (blocking; error management depends on them)

- **W1 · Guard terminal transitions — shipped.**
- **W2 · Cancel propagates to every kind of child, not just agents — shipped.**
- **W3 · Emit terminal events from async continuations — shipped.**
- **W4 · Snapshot the graph onto the run — shipped.**
- **W5 · Remove `delegate` from the workflow tool set — shipped.**
- **W6 · Reap stuck steps — by lease, not by age — shipped.**
- **W7 · Mark unreached steps `skipped` on failure — shipped.**

> Shipped items keep their original intent above and their as-built detail in
> [the delivery log](./2026-08-12-workflows-delivery-log.md). Record new
> completions there, not here, so this document stays a plan.

- **W8 · Fix `paused` enforcement.** Dispatch checks only `active` and `disabled`
  (`api/src/services/trigger-dispatch-workflow.ts`,
  `worker/src/control/workflow-trigger-run.ts`), so a `paused` installation still
  fires while the UI states it will not. Also add the missing update-installation
  endpoint: there is **no way to pause an installation after install** — status is
  write-once at install time.

### 3.2 Validation and designer honesty

- **W9 · `{{` must not disable validation.** `hasBindingToken`
  (`api/src/services/workflows.ts`) short-circuits both `toolName` and `agentId`
  checks, so any string containing `{{` skips validation entirely. Parse binding
  expressions properly: validate syntax, verify every `steps.<id>` reference names
  an existing step that *precedes* the referencing step. A typo must be a save
  error, not a failed run.
- **W10 · Stop the designer eating steps.** `getWorkflowCanvasNodeType`
  (`admin/src/lib/workflow-designer/node-sources.ts`) returns `null` for
  `environment_launch` and the loader `flatMap`s it away; re-saving writes the
  template back *without that step*. Preserve unknown/unrenderable steps through a
  load→save cycle. This is silent data loss.
- **W11 · The canvas must stop drawing fiction.** Until graph v2 lands (Stage 2),
  forbid multiple outgoing connections and cycles in
  `useWorkflowCanvasInteractions`/`geometry.ts` rather than silently linearizing
  them in `serialization.ts`. Disconnected nodes must not be silently appended to
  the end of the sequence and executed.
- **W12 · One tool allow-list.** `builtin-tools.ts`, the designer's `constants.ts`,
  and `services/workflows.ts` each maintain the list by hand and agree only by
  coincidence. Export one list and derive all three.
- **W13 · Demote the trigger node — binding decision: remove the config, keep the
  node as a labelled entry marker.** Three layers hold three different beliefs
  about what a `trigger` step is: validation accepts it, the runtime no-ops it
  ("visual-only at runtime"), and the designer strips it on save. Worse, the cron
  and timezone a user types into the canvas trigger node **never become an
  `AgentTrigger`** — real scheduling requires a separate "Add trigger" action on
  the installation. Delete the cron/timezone/interval fields from the canvas
  inspector and link to the Triggers page, which stays the one trigger authoring
  surface; drop `trigger` from the executable step-type set so validation, runtime
  and designer finally agree (revision 1 left this "either/or"; an unresolved
  choice is not a fix). Also collapse the install-time `triggersJson`
  materialisation, which duplicates trigger-creation logic — one code path.
- **W14 · Scope the designer draft.** `localStorage` drafts
  (`draft-storage.ts`) are keyed globally, not per template, so editing template A
  then opening "new workflow" hydrates A's nodes.

### 3.3 The primitives that make workflows worth having

- **W15 · `message_send` step.** A deterministic channel write through the
  existing message-create service, under the workflow's durable actor, targeting
  the installation's channel or a bound thread, body rendered from bindings. The
  single highest-leverage missing node: without it the platform's cheapest
  capability is the one thing its deterministic engine cannot do.
- **W16 · `when:` guard.** A step-level predicate; falsy ⇒ step `skipped`, run
  continues. Turns the flagship watcher from "pay for an agent every sweep" into "pay
  only when something changed".
- **W17 · `transform` step (JMESPath).** See §5.
- **W18 · Compare-and-set on `state_put`, as a complete read→write contract.**
  Today a blind `upsert` with a blind version increment. Two overlapping runs both
  read the same previous value and both act — corrupting exactly the watcher
  pattern the tools exist for. CAS alone is not enough; the contract is:
  1. `state_get`/`change_detect` **return the exact version compared**, so a
     caller has something to pass back.
  2. `state_put(expectedVersion)` fails the write on mismatch.
  3. **The guarded write happens before the notification side effect**, so a lost
     CAS race cannot produce a duplicate alert.
  4. **The write is attempt-scoped and idempotent.** A crash after a successful
     `state_put` but before the step is marked finished would otherwise make the
     retry's `expectedVersion` mismatch permanently, killing a healthy watcher.
     Record the writer's `(stepRunId, attempt)` on the entry and treat a repeat
     write from the same writer **whose value hash matches** as a no-op success
     rather than a conflict. The hash condition is one line and prevents a
     same-writer retry carrying *different* data from being silently swallowed.
  Note that CAS *detects* the collision; §6's `onOverlap: 'skip'` default is what
  prevents it. Both ship in Stage 1.

### 3.4 Reachability (Rule zero)

- **W19 · Entitlement-scoped access, with the roles stated.** All 19 workflow
  route handlers are `requireOwner`, and `WorkflowsPage` renders "Owner access
  required" to everyone else. Scope by entitlement, not by the session claim. The
  exact matrix, decided here rather than left to implementation:
  | Action | Who |
  |---|---|
  | Read installation, runs, run detail | Any member entitled to the installation's scope (after W0 redaction) |
  | Start a run manually | Any member entitled to the installation's **channel** — the same entitlement that lets them trigger an agent there |
  | Pause / resume / uninstall an installation | Org admin or owner |
  | Author, edit, publish a template | Org admin or owner |
  Manual start is deliberately member-level: a playbook a member can already
  trigger by talking to an agent in that channel gains nothing from an owner gate,
  and W28 must land first so the target check cannot leak cross-org existence.
- **W20 · Channel Automations tab.** The doorway. Lists installations whose
  `channelId` is this channel, with last-run status and run-now/pause.
- **W21 · Run cards in the channel.** Start/finish/fail messages carrying
  `metadata.workflowRun = { workflowRunId, installationId, status }`, exactly as
  budget-stop notices carry `metadata.runStop`. In Stage 1 the failed card offers
  **Retry** (full re-run, which exists) and a link to the run — **not Resume**,
  which depends on §4.2.7's partial-resume API and arrives in Stage 2.
- **W25 · Persist run origin.** Add `originChannelId`, `originThreadId`,
  `originMessageId`, `replyRootMessageId` to `WorkflowRun`. Without them a result
  cannot return to the thread that asked for it, `invoke_workflow` (§4.3) has
  nowhere to reply, and §8's shared run component has no origin to render a
  reciprocal doorway from. Cheap now, expensive to retrofit once three surfaces consume
  run records.
- **W26 · Overlap policy, default `skip`.** See §6. Enforced at **every** entrypoint —
  scheduled, manual, webhook, event, and `invoke_workflow` — not only inside
  `queueWorkflowTriggerRun`.
- **W27 · Retry must not rewrite history.** `retryWorkflowRun` overwrites
  `startedByActorId` with the retrying owner, erasing the original actor. Preserve
  the original; record the retrying actor separately and in the audit entry.
- **W28 · Fix the `agent_task` target check.** The channel/binding validation runs
  outside the mailbox transaction (a race) and its error strings confirm or deny
  the existence of channel and binding IDs across the org boundary. Move the check
  inside the transaction and make the failure text org-generic. This must land before
  W19 widens who can start runs.
- **W22 · Audit every mutation.** No workflow route writes an audit entry today.
  Template create/update (it mutates executable org behaviour), install, manual
  run, cancel, retry, skip, block/unblock, and pause are all audit-worthy.
- **W23 · Failure reaches a human.** Route `workflow.run.failed` through the shared
  push pipeline (`worker/src/control/push-delivery-core.ts`, the budget-alert
  precedent) to the installation creator and channel managers, deep-linking the run.
- **W24 · Paginate the lists.** `WORKFLOW_LIST_LIMIT` truncates at 200 with no
  cursor; the admin silently stops showing rows past the cap. Separately, correct
  the list endpoint's leading comment, which claims it omits `graphJson` while the
  select fetches it — comment and code contradict each other and the code itself.
- **W29 · A failed-runs triage surface.** Push (W23) is alerting, not triage. Add a
  cross-installation "what failed" filter on the Workflows page plus a count on the
  nav item, so a person can answer "what broke last night" in one place.

### 3.5 Stage 1 exit criteria

Stage 1 is done when all of the following are demonstrably true, not when the
items are merged:

1. **The zero-agent-hop watcher runs.** A scheduled playbook fetches a page,
   detects no change, and completes **without invoking a single agent run and
   without posting a message** — then, on a real change, posts a deterministic
   message naming what changed. This is the flagship demo and the proof that the
   cost argument in §1 holds.
2. A non-owner member of the installation's channel can see the playbook, its last
   run, and its failure — and no binding or config value is visible to them that
   W0 marked tainted.
3. Cancelling a run stops its child agent and the run stays cancelled.
4. Editing a template does not change any run already in flight.
5. Every mutation **in W22's scope** (route-level: create, update, install, run,
   cancel, retry, skip, block/unblock, pause) appears in the audit log with the
   correct actor — automatic trigger starts, wait resolution, and dispatch-time
   authorization decisions are Stage 2 (§4.4) and are not required here.
6. Two overlapping scheduled fires produce one run, and the skip is visible.

## 4. Stage 2 — Graph v2 and error management (target: 2 months)

### 4.1 The contract

Additive, with a `graphVersion` discriminator; v1 templates keep executing
unchanged through the existing path.

```ts
type WorkflowStepV2 = {
  id: string
  type: 'tool_call' | 'agent_task' | 'transform' | 'message_send'
      | 'connector_call' | 'approval' | 'human_input' | 'invoke_workflow' | 'wait'
  title?: string
  input?: Record<string, unknown>   // may contain {{…}} and jmespath: bindings
  when?: string                     // JMESPath predicate; falsy ⇒ 'skipped', run continues
  retry?: { maxAttempts: number; backoffMs: number; multiplier?: number
            retryOn?: 'any' | 'transient' }
  timeoutMs?: number
  onError?: 'fail' | 'continue' | { goto: string }   // forward reference only
  next?: string                     // optional explicit successor (else lexical)
}
```

`next`/`goto` are **forward-only**, validator-enforced, so execution stays
loop-free and the executor stays a single pass with a cursor instead of "first
pending".

**Attempts are rows, not a JSON blob.** Revision 1 proposed an `attemptHistory`
JSON column on `WorkflowStepRun`; two auditors independently rejected it and they
are right. Retry, timeout, cancellation, and late-result arrival all mutate that
one document, with no unique attempt identity, no compare-and-set rule, no
queryability, and a direct conflict with §4.2.7 resetting `attempt`. Instead add
**`WorkflowStepAttempt`** rows (attempt number, status, lease, timestamps,
sanitized input/output refs, error class, provider correlation). This gives
atomic late-result rejection and a real audit object.
`WorkflowStepRun` keeps `@@unique([workflowRunId, sequence])` and gains
`currentAttempt` and `nextAttemptAt`.

**Reachability is computed by traversal, not by `sequence` comparison.** Once
`next`/`goto` exist, "mark unreached steps skipped" (W7) and the run timeline must
both walk the graph. Steps **bypassed by a successful branch or an error route
must be atomically marked `skipped`**, or they linger as `pending` in a completed
run and can be re-selected by any residual "first pending" logic.

Move the shared contract into a package consumed by API, worker, and admin. The
worker currently redefines a weaker local `WorkflowGraph` type
(`worker/src/run/workflows.ts`), which is how contract drift starts. **Define this
seam in Stage 1**, so `when:`/`transform` are not added ad hoc to v1 and then
migrated.

**Validation accepts only step types that have a registered executor.** The v2
union above names types that do not exist yet; shipping the union without this
rule recreates exactly the `delegate` bug (D1) that W5 removes — a template that
validates cleanly and is guaranteed to fail at runtime.

The designer serializer emits v2, **derives `next` from its edges instead of
discarding them** — the canvas finally means what it shows — and **moves designer
metadata out of step `input`**. Canvas coordinates currently ride inside the
runtime payload and have to be laundered back out by `stripWorkflowDesignerConfig`
before use; once edges are semantically load-bearing, presentation data must stop
living inside execution data.

**V1 migration rules.** "Additive" is not a migration plan:
1. Convert each v1 `steps[]` into v2 nodes with sequence edges `0→1→…`.
   **Do not infer semantics from `workflowDesigner.outgoingNodeIds`** — those
   edges never controlled runtime and inferring them would change behaviour.
2. Snapshot each template's current graph as one immutable legacy version and
   repoint installations at it.
3. Installations whose recorded version differs from the current template cannot
   be reconstructed. Label them `legacy-current-snapshot` and say so in the UI
   rather than displaying a version number that means nothing.
4. Keep the v1 reader for already-queued runs only; remove it once the queue and
   in-flight runs drain.

### 4.2 Error management (the addendum, in full)

1. **Per-step retry with backoff.** On failure, if `attempt < retry.maxAttempts`
   and the failure class matches `retryOn`, set the step back to `pending` with
   `nextAttemptAt = now + backoffMs * multiplier^(attempt-1)` and enqueue a
   delayed `workflow.run.execute` (the pg queue already supports `visibleAt`).
   Classification: `transient` = 5xx, timeout, network, queue crash. Everything
   else — binding not found, validation, `UrlSafetyError`, 4xx — is permanent;
   retrying a deterministic failure is noise. The executor's step selection gains
   `nextAttemptAt <= now`.
2. **Idempotency — two different keys, and conflating them is a correctness bug.**
   Revision 1 used one key for both purposes; that is wrong in the dangerous
   direction.
   - **Dispatch identity** (mailbox, internal re-dispatch): must *change* per
     attempt, because a fresh attempt genuinely intends a fresh dispatch. The
     mailbox correlation id is `workflow-step:${stepRunId}` today, so a retried
     `agent_task` dedupes against the *failed* attempt's row and never
     re-dispatches. It must become `workflow-step:${stepRunId}:${attempt}`.
   - **Provider logical idempotency** (external side effects): must *stay stable*
     across attempts — `runId:stepId[:itemIndex]`. Sending
     `Idempotency-Key: <stepRunId>:<attempt>` would tell the provider each retry is
     a brand-new operation, permitting duplicate charges, messages, or writes after
     an ambiguous response. That is the exact failure the key exists to prevent.
   Non-idempotent connector steps default to no retry regardless.
3. **Catch / error branches.** `onError: { goto }` routes to a later step; the
   failed step records `failed` and the run continues at the target with
   `steps.<failed>.status` visible to `when:` guards. `onError: 'continue'` is the
   degenerate case. No silent continue-on-error: it is always explicit in the graph.
4. **Timeouts.** `timeoutMs` per step, enforced in-process for tool/transform
   steps and by the W6 sweep for suspended steps (`agent_task`, approval, human
   input). Timed-out steps finish through the guarded transition so retry and
   `onError` apply normally.
5. **Non-idempotent side effects.** A step declaring a non-idempotent side effect
   that times out ambiguously must not auto-retry; it routes to a human decision.
   Borrowed from the DeepWater recovery discipline.
6. **Dead letter and alerting.** The failed-runs view (W29) covers failed *runs*,
   and for those no new table is needed. But it cannot represent a **trigger
   delivery that never produced a run** — a poison webhook payload that fails
   before run creation has no row to appear in a run list. Add
   `WorkflowDeadLetter` for exactly that case: delivery identity, failure reason,
   resolution state, and an explicit entitlement-checked replay action. Poison
   caps: a hard ceiling per step (5) and per run (25 total attempts) so a
   mis-configured retry block cannot spin.
7. **Partial resume from the failed step.**
   `POST /api/workflow-runs/:id/resume` flips the failed step — and only it —
   back to `pending` and re-enqueues execute. Completed steps stay completed and
   their snapshots keep feeding bindings. Requires W1's guards (a terminal run
   must transition `failed → running` through one guarded `updateMany`).
   **Attempt numbers are monotonic and never reset.** Revision 2 said resume
   "resets `attempt`", which contradicts attempt rows in the dangerous direction:
   a reset collides with an existing `WorkflowStepAttempt` row and re-uses a
   mailbox correlation id that was already consumed, so the re-dispatch silently
   dedupes and the resumed step never runs. Resume creates attempt **N+1**.
   Poison caps (§4.2.6) count per *resume generation*, not per step lifetime —
   otherwise a step that exhausted its retries can never be resumed by a human,
   which is precisely when a human resume is most wanted.
   Lease-expiry recovery (W6) likewise creates a new attempt; W18's replay-safe
   state writes are keyed by `(stepRunId, attempt)`, so crash redelivery of the
   *same* attempt stays a no-op success while a genuinely new attempt is a new
   writer.
   Keep full `retry` for the "inputs were wrong" case; the run card offers both.
   Changed inputs or a changed definition **fork a new run**; an unchanged retry
   keeps the original logical key and version.

8. **Compensation is explicitly out of scope for Stage 2.** `onError: { goto }`
   can approximate a cleanup step, but the plan does not record compensation
   intent or status, prevent double compensation, or relate a compensating action
   to the original side effect. Saying so plainly is the point: error routing is
   not rollback, and governed side effects must not be sold as transactional.

### 4.2a Immutable published versions (was S3.1 — moved earlier, and blocking)

`invoke_workflow`, `approval`, and `connector_call` each need a stable definition
to refer to: a callable contract, an approved side effect, and an audit entry are
all meaningless against a mutable template. So this lands **before** §4.3, not in
Stage 3.

`WorkflowVersion { id, templateId, version, definitionJson, inputSchema,
outputSchema, checksum, createdBy, createdAt }`, immutable once published.
Editing creates a draft; publishing is explicit; upgrading an installation shows
a diff and is explicit. `WorkflowRun` records the version id and checksum it
executed. This subsumes W4's snapshots — those were the emergency fix for the
live mutation bug; this is the contract. §4.1's V1 migration step 2 ("snapshot
each template as one immutable legacy version") refers to *this* entity, and
therefore runs here rather than at the start of Stage 2.

### 4.3 Composition and human-in-the-loop

- **`invoke_workflow` builtin.** The founding design decision, never built.
  `invoke_workflow(installationId, input)` creates a `WorkflowRun` with
  `parentRunId` (the column and validation already exist), suspends the tool call,
  and resumes the agent run when the workflow terminates — the exact inverse of
  `agent_task`, on the same continuation machinery. Gated per-agent through
  `toolPolicy` with the DeepWater explicit-grant pattern; installation scope is
  enforced as **tenancy**, not policy. `WorkflowRun.output` already carries the result.
- **`approval` step.** A real Approval row that resumes on resolution — not the
  current operator `blocked` toggle, which is an operator race, not a decision.
  Human input and approval stay distinct: approval authorizes, human input
  collects data. Requires: **re-check entitlement at resolution time** (not at
  creation), eligible-approver rules, expiry with a timeout branch, and a mandatory
  audit entry on resolution.
- **`human_input` step.** Suspends on the same mailbox mechanism, resumes with a
  **schema-validated** reply payload, surfaced as a channel card. Same governance
  as `approval`, and for the same reason: eligible-responder rules, entitlement
  re-checked **at reply time** rather than at creation, and an expiry with a timeout
  branch. A question anyone can answer, or that hangs forever, is not a workflow
  step.
- **`wait` step**, and the state model all three wait forms need.

**Waiting is a first-class state, and waiting must not hold a concurrency slot.**
`approval`, `human_input`, and `wait` all suspend indefinitely. Without explicit
modelling: a forgotten approval on a `limit: 1` installation blocks every
subsequent run forever, because §6 admits new work only on *terminal* transition,
and the run looks `running` to every surface. So Stage 2 adds:

- A **`WorkflowWait`** record — durable, single-use, with wake-up and cancellation
  semantics — rather than inferring waiting from step status.
- Run states that distinguish `waiting` / `needs_action` from `running`.
- **Concurrency admission releases the slot while a run is waiting on a human or
  a timer**, and reclaims it on wake. A run holds a slot only while it owns active
  external work.
  **But releasing the slot re-opens the hole `onOverlap: 'skip'` exists to close.**
  On a stateful installation — the watcher pattern — a run parked on an approval
  would let the next scheduled fire start and interleave `state_put` writes against
  the same keys. So slot release is per-installation configuration
  (`releaseSlotWhileWaiting`, default **false** for installations that write state,
  true otherwise), and where the two policies disagree, `onOverlap` wins: a
  stateful installation blocks rather than interleaves. Starvation is the lesser
  failure, and the wait's expiry branch bounds it.

### 4.4 Governance

- **Budget gate.** `executeWorkflowRun` never consults the org `Budget`. Apply
  `evaluateBudget`/`applyBudgetGate` at run start and between steps; roll child
  agent-run spend **and connector/tool charges** up to the `WorkflowRun`; snapshot
  the resolved limits onto the run so a mid-run limit change cannot retroactively
  alter a verdict; and show consumed/remaining in the run header. Add a workflow
  dimension to `/ops/usage` (owner-only telemetry — never beside customer credits).
- **The full secret-taint model.** W0 ships the minimum boundary in Stage 1; Stage 2
  completes it: a typed secret-reference in `bindingSchema`, taint propagation
  through transforms and step outputs, and redaction proven by test at every sink.
- **Per-installation tool allow-list.** An installation declares which tools it
  may call; effective permission is the **intersection** of installation scope,
  tool scope, triggering actor, connector lifecycle/review status, and the
  workflow grant, re-checked **at dispatch time**, not only at save time. Each
  installation runs as a server-minted workflow principal. A user-scoped OAuth
  connector must never become an unattended organization credential because an
  owner could see its registry row. **This is a hard prerequisite for Stage 3's
  `connector_call`** — without it, "tool-registry policy" is asserted, not designed.
- **Install scope must be explicit.** Install copies `projectId`/`teamId` from the
  session while accepting any channel in the org, never proving they agree.
  Accept them explicitly and validate the whole hierarchy. Also eliminate the
  contradictory `active`/`status` combinations that API, worker, and UI currently
  interpret differently (D13) — one validated lifecycle, not two independent flags.
- **Dynamic identity fields are not authorization.** W9 makes binding syntax
  valid; it does not make a target legitimate. `agentId`, `toolName`, `channelId`
  and similar resolved-at-runtime identity fields must be validated against exact
  scope **at dispatch**, or prohibited from being binding-derived at all.
- **Audit coverage is broader than routes.** W22 covers route mutations. Stage 2
  adds: automatic trigger starts, publish/upgrade, wait creation and resolution,
  dispatch-time authorization decisions, and reciprocal audit↔run links.
- **Data minimisation.** An agent step receives selected fields, never a whole
  webhook or connector response.
- **Typed alerts, not just push.** W23 sends failure push. Stage 2 adds typed
  workflow alert kinds — `failed`, `waiting_for_human`, `budget_blocked`, and opt-in
  completion — as actionable Alerts/Threads items with subscriber preferences.
  Recipients are resolved by **current entitlement at delivery time**, not by a role
  label captured earlier, and push payloads carry no raw error or input data.

## 5. The deterministic converter (addendum 1, in full)

**Decision: JMESPath, plus a typed field-picker that compiles to it. No
sandboxed JS.**

Why: JSONPath selects but cannot construct — you can pluck, not reshape.
JSONata is more expressive but a much larger language with one reference
implementation. Sandboxed JS is maximally expressive and maximally expensive —
an escape is RCE in the worker, and agent-authored JS is unreviewable by
non-engineers. JMESPath is a closed, side-effect-free spec with multiselect
hashes and lists (real reshaping:
``items[?stock > `0`].{name: title, price: cost}``), a maintained JS
implementation, and the Step Functions precedent. It is deterministic by
construction: a pure function of the input document, no I/O, no clock, no
randomness. It is also in every major model's training data, so agents author it
reliably — a decisive point against a bespoke DSL.

**Mechanism.** A `transform` step, implemented in its own module (the 500-line
cap makes a sibling file the right call, not a case in the existing tool switch):

```jsonc
{ "id": "shape", "type": "transform",
  "input": { "expression": "body.releases[0].{tag: tag_name, url: html_url}",
             "source": "{{steps.fetch.output}}" } }
```

`source` defaults to the full binding context (`workflow.input`,
`workflow.bindings`, `steps.*.{input,output,status}`) so one expression can join
across steps. Any step input may also use the inline prefix form
`"jmespath:<expr>"`, keeping `{{…}}` for the simple pluck case — backwards
compatible, one added branch in `resolveWorkflowStepInput`.

**Security envelope.** Expression length cap (4 KiB); input document cap (1 MiB —
tool outputs are already truncated middle-out upstream); output cap (256 KiB); and
**the binding context never contains secrets** (W0, §4.4). No network, no
filesystem, no ambient env by construction.

On the time fuse, revision 1 was technically wrong: a 100 ms "watchdog" cannot
pre-empt a synchronous evaluation on the worker's event loop — the timer only
fires once the evaluation has already finished. Either evaluate in a
`worker_thread` that can actually be terminated on deadline, or rely on a proven
structural bound. We do both: the 1 MiB input cap is the real fuse (JMESPath has
no loops or recursion, so cost is bounded by document size × expression size), and
evaluation runs off the main event loop so a pathological wildcard projection
cannot block the worker.

**`stepSamples` is a new sensitive-data store, and must be treated as one.**
Successful tool outputs routinely contain customer data even when they contain no
credential. Samples therefore inherit W0's redaction, carry installation
provenance, have a per-template size quota and a retention limit, are deleted with
their template, and are entitlement-checked before being sent to the client-side
evaluator. A convenience feature must not become an unaudited data lake.

**Shape awareness in the designer.** Half-built already: test runs map step
results onto canvas nodes (`useWorkflowTestRun.ts`) and the inspector lists
upstream steps with `{{steps.<id>.output}}` hints.

1. Persist the last successful test run's per-step output as
   `WorkflowTemplate.stepSamples Json`, keyed by step id, so field pickers work on
   reopen without re-running.
2. The inspector renders the upstream sample as an expandable tree; clicking a
   leaf inserts the JMESPath for it (tree-path → expression is mechanical).
3. **Live preview:** evaluate the draft expression against the sample
   client-side and render the result beside the editor. This is the n8n feature
   that actually matters and it costs one dependency.
4. **Save-time compilation** in `validateWorkflowGraphSteps`: compile every
   `expression`, `jmespath:` and `when:` string; parse errors become validation
   issues. Combined with W9's reference checking, a typo is a save error.
   **One grammar, defined once, shared by both readers.** `{{…}}` bindings and
   `jmespath:` expressions coexist in the same field, so W9's binding parser and
   this compiler must consume a single exported grammar definition — not two
   implementations that happen to agree. Two hand-maintained parsers of the same
   syntax is precisely the disease W12 cures for tool lists, and it would fail the
   same way: silently, and only at runtime.

**Agent authoring: the identical artifact.** PA `workflow_create`/`workflow_update`
tools accept the same graph JSON and get the same validation errors back as tool
output, so an agent iterates against the same compiler a human does. Add
`workflow_transform_preview(expression, sampleJson)` running the same evaluator —
deterministic, no LLM in the loop, which is precisely the requirement.

## 6. Scheduling (addendum 3, in full)

**One scheduler. Emphatically.** The system already chose correctly:
`AgentTrigger` carries `workflowInstallationId`, one sweep branches to
`queueWorkflowTriggerRun` for workflow triggers, one shared
cron/timezone/next-run library serves API and worker, one claim protocol, one
delivery/dedupe model, and the Triggers page already renders workflow targets.
A second scheduler would be a Rule-zero-grade fork. What is missing is policy,
not machinery:

**Staging.** Overlap policy (`W26`) is **Stage 1** — it is what actually prevents
the watcher race, and W18's CAS only detects it. Catch-up policy and the rate
ceiling are **Stage 2**.

- **Overlap/concurrency: there is none today.** Every due fire creates a fresh
  run regardless of one still `running`; the only dedupe is the per-slot key. Add
  `WorkflowInstallation.concurrency Json` →
  `{ limit: 1, onOverlap: 'skip' | 'queue' | 'parallel' }`, defaulting to
  `{ limit: 1, onOverlap: 'skip' }`, under
  `pg_advisory_xact_lock(hashtext(installationId), …)`.
  `skip` records the delivery with a `skipped_overlap` status so silent skips stay
  diagnosable; `queue` withholds the execute job until the active run's terminal
  transition releases the next one, **with a bounded queue depth** (beyond it,
  skip and record) so a stalled installation cannot accumulate unbounded pending
  work; `parallel` is opt-in for stateless workflows.
  **Enforced at every entrypoint** — scheduled, manual (W20), webhook, event, and
  `invoke_workflow` — not only in `queueWorkflowTriggerRun`, or the policy is
  trivially bypassed by the surfaces this plan is adding. And per §4.3, a run
  waiting on a human or a timer **releases its slot per §4.3's
  `releaseSlotWhileWaiting` configuration** — which defaults to *off* where the
  installation writes state, because releasing there would re-open the very
  interleaving hole `onOverlap: 'skip'` closes. Not unconditional policy.
- **Catch-up after downtime is two accidents, not a policy.** Cron computes the
  next fire from the *missed* slot, so an outage of N slots replays N fires
  uncapped; interval uses `max(from, now)` and silently drops them. Add per-trigger
  `catchUp: 'skip' | 'once' | 'all'` (default `'once'`: one make-up run, then
  compute from now) in the shared library. `'all'` takes a per-trigger
  `maxCatchUpRuns` cap and persists a discard summary — a deployment-wide hourly
  ceiling is not a substitute, since one trigger would consume the global
  allowance.
  **This changes existing agent-trigger behaviour**, because the library is shared:
  cron agent triggers replay missed slots uncapped today. That is a behaviour change
  to a shipped feature arriving as a side effect of a workflow plan, so it needs a
  migration note, a docs update, and a deliberate default — not a silent flip.
- **Rate ceiling.** `NESSIE_WORKFLOW_MAX_RUNS_PER_HOUR` as a deployment backstop —
  the same "safety envelope, not user budget" philosophy as `NESSIE_RUN_BACKSTOP_*`.
- **Cron and timezones are already correct** (`cron-parser` with a validated
  `timezone`, `until` end-dates, one-off mode). Expose the timezone field in the
  designer's trigger inspector — it is advanced-JSON-only today.

## 6a. Stage 3 — Connectors and product actions

Revision 1 referenced "Stage 3" and "Stage 4" without defining them; all three
auditors flagged rows that could therefore never be scheduled or closed. Both
stages are defined here.

Revision 2 then created its own contradiction: it made immutable versioning
(then "S3.1") a hard prerequisite for `invoke_workflow` and `approval` while
leaving those in Stage 2 — a stage plan that is not topologically executable.
Fixed in revision 3 by moving immutable versioning **into Stage 2 as §4.2a**,
ahead of §4.3's composition work. Stage 3 is therefore connectors and product
actions only.

**S3.2 · Per-installation tool allow-list** (§4.4) — the policy half of the
connector decision. Ships before S3.3, not alongside it.

**S3.3 · `connector_call`** over `resolveInstanceMcpTransport`/`callInstanceTool`,
validated at save time against the org's active `ToolRegistryEntry` projections,
executed with the workflow principal's signed context, honouring instance scope,
with stable provider idempotency keys (§4.2.2) and non-idempotent steps defaulting
to no retry.

**S3.4 · First-class product actions.** Task, Plan, and Knowledge steps — the
capability behind C14/C15. "Wire or drop the columns" was not an answer: either
`WorkflowRun.planId`/`planStepId` and `WorkflowStepRun.taskId` become real actions
with real doorways, or the columns go. Decide by building the actions; they are
the highest-value non-connector steps for a knowledge-worker product.

**S3.5 · Bounded `map` decision point.** With connector steps live, re-examine
whether collection-shaped cases (release notes over N PRs, connector result sets)
justify a bounded `map` with implicit join. Decide with usage data, then record
the decision here either way.

## 6b. Stage 4 — Consolidation

**S4.1 · The template/installation collapse decision.** Revisit with usage data
from Stages 1–3. Two of three reviewers argued the indirection buys nothing today;
the third argued for keeping it. Deferred this long because W4 and §4.2a remove the
correctness argument for rushing it, and collapsing is expensive to reverse if a
shared template library is ever wanted.

**S4.2 · Promote-a-run-to-a-playbook**, properly: extract the audited tool calls,
parameterise concrete values into typed bindings, classify deterministic vs
agent-owned steps, and re-run schema and policy checks. §7 calls this "a PA prompt
over the same tools", which understates it — the PA needs a trustworthy trace and
a defined validation pass. Not before §4.2a gives it a version to write into.

**S4.3 · (moved to Stage 2.)** The three seeded playbooks — changed-page alert,
weekly project-risk review, webhook → approval → governed action — ship with
Stage 2, because §9's adoption gate is evaluated at the end of Stage 2 and cannot
measure artifacts that do not exist yet.

## 7. Authoring UX

**Primary: conversational, PA-authored, compiling to the JSON graph.** Nessie's
users talk to agents all day and its standards require intent to be model-judged.
"Watch the Kubernetes releases page and tell #platform when a new minor ships"
*is* the spec; the PA compiles it. The pieces are unusually cheap: the API exists,
`validateWorkflowGraphSteps` is a real compiler front-end returning actionable
issues, and the `connector_*` PA tools are the exact template. Add
`workflow_list/create/update/install/run/run_status` PA tools; the agent proposes,
the human confirms in chat, the card links to the designer for inspection.

**Secondary: a vertical step-list editor** reusing the existing
`WorkflowNodeInspector` — roughly 20% of the canvas code and 100% honest about
execution order.

**The canvas becomes a truthful viewer and run-replay view.** A picture of what
executed is genuinely valuable; a picture you edit that lies about branches is
not. Once graph v2 lands its edges mean `next`/`goto` and it can be an editor again.

**JSON stays the source of truth**; the existing import/export serves power users
at zero extra cost. **Defer record-and-promote** — once `invoke_workflow` and PA
authoring exist, "turn what you just did into a workflow" is a PA prompt over the
same tools rather than a new subsystem. **No template marketplace** for now.

## 8. Observability

Emit a `workflow.run.timing` TaskEvent at terminal state (per-step durations are
already derivable), add realtime `workflow.run.updated` events so the admin stops
polling, and make the run view answer five questions without opening JSON: what
started this, what version ran, where is it waiting, what side effects happened,
what did it cost. Render one shared run component in Workflows, chat, and audit —
never a second implementation.

## 9. The adoption gate — one gate, at the end of Stage 2

Revision 2 described this gate in three incompatible ways: §2 placed it at the end
of Stage 1, §9 at the end of Stage 2, and it depended on seeded templates filed
under Stage 4. One placement, stated once:

**The gate is evaluated at the end of Stage 2.** The seeded playbooks it needs
(changed-page alert, weekly project-risk review, webhook → approval → governed
action) move out of Stage 4 and ship **with Stage 2**, since a gate that depends
on artifacts built two stages later cannot be evaluated.

Instrument starts, completions, failures, **repeat** runs, and whether anyone
opens or acts on a run card. **If there is no repeat use beyond the seeded
playbooks, stop.** Do not build Stage 3. Keep what exists — by then it is correct,
truthful, and reachable, which is worth having on its own — and let Agent Triggers
own the use case.

**What the gate does and does not test.** It evaluates the *playbook-without-
connectors* proposition: deterministic delivery, guards, error handling, and human
steps over public-web and internal actions. It does **not** test connector-backed
automation, which is Stage 3's multiplier. A "stop" verdict therefore means "this
shape did not earn its next stage", not "connector automation has no value" — that
proposition was never put in front of a user. Record which one the verdict refers
to, or the gate will be misread later.

## 10. Never build

- A general DAG editor, free-form fan-out/join, or loop nodes.
- Sandboxed JS or code nodes in the API/worker process.
- A workflow-specific connector catalogue or per-service nodes — MCP connectors
  *are* the catalogue.
- A second scheduler, notification path, approval system, secret store, audit
  chain, or metering path.
- LLM-decided routing where a deterministic condition expresses the rule.
- A separate workflow inbox or workflow chat — use Channels, Threads, Approvals,
  Alerts.
- A canvas that can draw semantics the runtime cannot execute.
- `environment_launch` as a user-facing node until the execution-runner subsystem
  has a surface. Keep the code path; stop the designer destroying it (W10).
- Message-pattern/regex triggers — they violate the model-judged-intent standard.

## 11. What revision 2 changed, and why

The three reviewers audited revision 1 against their own reviews. Their findings,
and the resulting changes:

**Unanimous — the plan contradicted itself.** W19 widened read access in Stage 1
while §4.4's secret-taint boundary, declared to gate it, sat in Stage 2. All three
called this the most important error. Fixed by W0, which pulls a minimal redaction
boundary into Stage 1 and extends it to four sinks — reads, message rendering,
transform context, and persisted samples — since W15 and W17 were equally unsafe
before it.

**Two of three rejected a schema choice.** `attemptHistory` as a JSON column was
independently judged a concurrency and audit trap. Replaced with
`WorkflowStepAttempt` rows.

**One caught a correctness bug in my design.** Using `stepRunId:attempt` as the
provider `Idempotency-Key` reverses the guarantee: it tells the provider every
retry is a new operation, permitting duplicate side effects after an ambiguous
response. Split into dispatch identity (changes per attempt) and provider logical
key (stable across attempts).

**One caught a technical error.** A 100 ms timer cannot pre-empt a synchronous
JMESPath evaluation on the event loop. Replaced with a real structural bound plus
off-event-loop evaluation.

**Referenced stages did not exist.** §2, C7, C14, and C15 pointed at Stage 3 and
Stage 4, which were never written; rows citing them could not be scheduled. Both
stages are now defined (§6a, §6b), and immutable versioning moved from Stage 4 to
Stage 3 because callable workflows, approvals, and connector side effects each
need a stable published definition to refer to.

**Scheduling belonged to no stage.** §6 was cited by three defect rows but never
assigned. Overlap policy is now Stage 1 (W26); catch-up and the rate ceiling are
Stage 2.

**Also fixed:** a per-installation tool allow-list is now a hard prerequisite for
connector steps rather than an asserted one; concurrency is enforced at every
entrypoint, not only the scheduled path, and waiting runs release their slot;
`catchUp: 'all'` gained a per-trigger cap; the reaper reclaims by lease rather
than by age; `state_put` CAS gained an attempt-scoped writer identity so a crash
between write and step-finish cannot permanently wedge a watcher; W13 became a
binding decision instead of an either/or; D17, D18, D25 got real fixes rather than
adjacent ones; run origin fields were added; V1 migration rules were restored;
acceptance criteria and an adoption gate were added; and §0 stopped claiming the
engine is already sound.

**Objections recorded, not adopted.** One reviewer maintains that a guarded
sequence cannot honestly claim multi-system orchestration — accepted, and handled
by naming the product Playbooks in §2 rather than by widening the engine. One
maintains that deterministic steps needing connectors is a design smell that blurs
the authority boundary — noted; the allow-list prerequisite is the mitigation, and
S3.5 revisits it with usage data. One maintains that JMESPath, being untyped,
lets a malformed cross-step shape save cleanly and fail at runtime — accurate, and
accepted as the price of authorability; C21 revisits assignability checking in
S3.3 once real connector schemas exist.

### Revision 3 — the confirmation round

Revision 2 was re-checked by all three reviewers against their own audits. Most
findings came back closed, but the round caught several contradictions **revision
2 itself introduced** — which is the argument for doing it:

- **Immutable versioning was made a hard prerequisite for `invoke_workflow` and
  `approval` while those stayed in Stage 2 and it moved to Stage 3.** The stage
  plan was not topologically executable. Versioning moves into Stage 2 as §4.2a,
  ahead of its dependants; Stage 3 becomes connectors and product actions.
- **Partial resume still said it "resets `attempt`"** while attempts had become
  rows. A reset collides with an existing attempt row and re-uses a spent mailbox
  correlation id, so the resumed step would silently dedupe and never run.
  Attempts are now monotonic; resume creates N+1; poison caps count per resume
  generation so an exhausted step can still be resumed by a human.
- **The adoption gate was described in three incompatible places** and depended on
  seeded playbooks filed two stages later. One gate, end of Stage 2; the seeded
  playbooks move to Stage 2 with it; and the gate records that it tests the
  playbook-without-connectors proposition only.
- **The lease-based reaper could not reach suspended steps** — they hold no lease
  and run no heartbeat, yet timeouts were routed to it. Two reclaim conditions now.
- **Releasing a concurrency slot while waiting re-opened the overlap hole** that
  `onOverlap: 'skip'` exists to close, on exactly the stateful watcher the plan leads
  with. Slot release is now per-installation, defaulting off where state is written,
  and `onOverlap` wins ties.
- **W26 was missing from the minimum-viable subset** while exit criterion 6
  required it. Added, along with W18 and the JMESPath evaluator's scope note.
- Also: W2 gained a cancellation contract for environment and connector children,
  not just agents; W19 gained an explicit role matrix (C11 was the last OPEN row);
  `human_input` gained eligible-responder, entitlement-at-reply, and expiry rules;
  the CAS no-op gained a value-hash condition; V1 migration's legacy-version step
  moved to where the version entity actually exists; and Stage 1's audit exit
  criterion was scoped to W22's actual coverage.

## 12. Traceability — every review finding, and where it is handled

Findings from three independent reviews (Fable, Kimix, Codex Sol, 2026-08-12),
re-checked by those reviewers against revision 1 and updated here. Every row must
be closed or explicitly waived before this plan is considered delivered.

### Defects

| # | Finding | Handled by |
|---|---|---|
| D1 | `delegate` advertised, save-valid, always fails at runtime | W5 |
| D2 | Cancelled runs resurrected by orphaned children (unguarded terminal writes) | W1, W2 — W2 must also cancel `environment_launch` and in-flight connector/tool work, not only the child agent flag |
| D3 | Designer silently linearizes drawn branches; disconnected nodes still execute | W11 (v1: require exactly one connected chain — reject merges, multiple *incoming* edges, and disconnected components, not just multiple outgoing), §4.1 (v2: bypassed steps atomically `skipped`) |
| D4 | Version pinning decorative; template edits mutate installed **and in-flight** runs | W4 for the live defect; **§4.2a** for the versioning contract. W4 alone does not close immutable publish history |
| D5 | No overlap control; `state_put` blind upsert loses updates | W18 (full CAS contract), W26 (`onOverlap` default `skip`, all entrypoints) |
| D6 | Cron catch-up uncapped replay; interval silently skips | §6 Stage 2, with per-trigger `maxCatchUpRuns` |
| D7 | No budget gate anywhere | §4.4 — incl. run-limit snapshot, connector charges, consumed/remaining display |
| D8 | No audit entries anywhere | W22 (routes) + §4.4 (trigger starts, publish/upgrade, wait resolution, dispatch authorization, reciprocal links) |
| D9 | Mailbox correlation id lacks attempt suffix (breaks retries) | §4.2.2 — **and** the separate stable provider key |
| D10 | Terminal events never emitted when last step is async | W3 |
| D11 | Install scope ambient (project/team from session, channel unvalidated against them) | §4.4 |
| D12 | Secrets/bindings persisted cleartext into run artifacts; no taint boundary | **W0** (Stage 1 boundary, four sinks) + §4.4 (full model) |
| D13 | `paused` installations still fire; no way to pause after install | W8 + §4.4 (eliminate contradictory `active`/`status` combinations) |
| D14 | `{{` bypasses all save-time validation | W9 (syntax + reference order) + §4.4 (dispatch-time validation of identity fields — syntactic validity is not authorization) |
| D15 | `environment_launch` steps silently deleted by designer round-trip | W10 |
| D16 | `trigger` step type: three layers, three beliefs; canvas cron never creates a trigger | W13 — now a binding decision (remove config, drop from executable types, one trigger path) |
| D17 | `agent_task` target validation races and leaks existence across org boundary | **W28** (transactional check + org-generic error text). Revision 1 cited W19, which reduces exposure but fixes nothing |
| D18 | Retry rewrites `startedByActorId`, losing original actor | **W27** (preserve original, record retryer separately). Revision 1 cited W22, which only audits the wrong origin |
| D19 | List endpoints truncate at 200 with no cursor | W24 |
| D20 | Designer draft in `localStorage` leaks across templates | W14 |
| D21 | Steps stuck `running` forever after a crash; no reaper | W6 — **lease/heartbeat**, not an age threshold |
| D22 | Failed runs leave later steps `pending` forever | W7, extended by §4.1 traversal semantics |
| D23 | Run detail polls instead of using realtime events | §8 |
| D24 | Three hand-maintained tool allow-lists agree only by coincidence | W12 + §4.1 (validation accepts only step types with a registered executor) |
| D25 | List endpoint comment contradicts the code it documents | **W24 (comment correction)** — revision 1 cited pagination, which is a different bug |
| D26 | `change_detect` → `state_put` not atomic across overlapping runs | W18, W26 |
| D27 | Worker redefines a weaker local `WorkflowGraph` type (contract drift) | §4.1, seam defined in Stage 1 |
| D28 | Designer metadata stored inside execution input; laundered out at runtime | §4.1 serializer rewrite |
| D29 | No durable record for trigger deliveries that fail before a run exists | §4.2.6 `WorkflowDeadLetter` |

### Capabilities

| # | Finding | Handled by |
|---|---|---|
| C1 | No `message_send` — deterministic layer cannot deliver its own output | W15 |
| C2 | No condition — watcher pays for an agent on every sweep | W16 |
| C3 | No `transform`/mapper — cannot reshape between steps | W17, §5 |
| C4 | No `invoke_workflow` — the founding design decision, unbuilt | §4.3 + **§4.2a** (published version to call), W25 (origin thread to reply into), typed input/output validation, and a `get_workflow_run` contract |
| C5 | No approval step (operator `blocked` toggle is not an approval) | §4.3 — durable single-use wait, entitlement re-checked at resolution, eligible approvers, expiry branch, mandatory audit |
| C6 | No human-input step | §4.3 — schema-validated reply payload |
| C7 | No MCP connector step | **S3.3**, gated on S3.2 (per-installation allow-list) and W0 |
| C8 | No wait/timer step | §4.3 — `WorkflowWait` with persisted status, wake-up, and cancellation |
| C9 | No per-step retry, backoff, catch, or timeout | §4.2 + `WorkflowStepAttempt` rows for attempt identity and late-completion rejection |
| C10 | Retry is re-run-from-zero; no partial resume | §4.2.7 — plus the rule that changed inputs or definition fork a new run while an unchanged retry keeps the original logical key and version |
| C11 | Owner-only: unreachable by members | W19 (reads, after W0) + W20 must state which role may run/pause — reads alone do not grant invocation |
| C12 | No channel doorway; no run cards | W20, W21, **W25** (persisted origin/reply linkage), composer/PA invocation doorway |
| C13 | Failure alerts nobody | W23 (push) + §4.4 (typed alert kinds, preferences, entitlement-checked recipients) |
| C14 | Tasks/plans linkage is schema-only, half-wired | **S3.4** — build the actions or drop the columns |
| C15 | No KB steps | **S3.4** |
| C16 | No spend roll-up or per-installation usage | §4.4 |
| C17 | Canvas is the wrong primary authoring surface | §7 |
| C18 | No shape awareness / sample data / preview when authoring bindings | §5 — subject to `stepSamples` data handling |
| C19 | No adoption/stop decision; investment framed as unconditional | **§9** |
| C20 | No acceptance criteria; no flagship demo to prove the cost argument | **§3.5** |
| C21 | Mapper is an opaque string language, not typed/schema-checked/taint-aware | §5 + W0 taint propagation. **Partially waived:** JMESPath is deliberately untyped; assignability checking against connector output schemas is revisited in S3.3 when real schemas exist |
| C22 | Compensation for governed side effects | **Explicitly out of scope** (§4.2.8) — error routing is not rollback |

### Open decisions, deliberately deferred

**S4.1 · Collapse `WorkflowTemplate` into `WorkflowInstallation`?** Two of three
reviewers argued the indirection buys nothing today — no marketplace, no cross-org
sharing, `resolvedBindings` largely unused. The third argued for keeping it with
immutable `WorkflowVersion` rows and, on audit, conceded the deferral. Deferred
because W4 and §4.2a remove the correctness argument for rushing it, and collapsing
is expensive to reverse if a shared template library is ever wanted.

**S3.5 · Bounded `map`.** Deferred with a named decision point, not refused.
Revision 1's claim that no use case needs it was wrong — release notes over N PRs
and connector result sets are genuinely collection-shaped. Decide with usage data
once connector steps exist.

**C21 · A typed mapper.** JMESPath is chosen for authorability and determinism at
the cost of static typing. If connector output schemas prove reliable in S3.3,
revisit assignability checking then.
