# Workflows, made first-class

> Status: approved plan, in delivery
> Supersedes the target-state sections of
> [2026-04-15-n8n-inspired-workflow-tools-and-triggers.md](./2026-04-15-n8n-inspired-workflow-tools-and-triggers.md)
> and completes the founding decision of
> [2026-04-07-workflow-builder.md](./2026-04-07-workflow-builder.md) ("Workflows Are Tools").
> Derived from three independent code reviews (2026-08-12) whose findings are
> tracked to completion in §10.

## 0. The one-paragraph version

Nessie's workflow engine is sound and its surface is a lie. The runner, the
run/step state machine, the mailbox suspend/resume choreography, and the trigger
scheduler are real and worth keeping. Everything above them is not: the graph
contract is a flat list, the canvas draws edges the runtime discards, installed
"versions" are decorative, and the whole surface is owner-only and invisible from
chat. The deterministic layer cannot deliver its own output — the only way a
workflow result reaches a human is by paying for an agent hop, which inverts the
entire economic argument for having workflows. This plan fixes the lies first,
adds the five primitives that unlock every real use case, and wires workflows
into channels, agents, approvals, budgets, and the audit trail. It deliberately
never builds a general DAG, a code node, a connector catalogue, or a second
scheduler.

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
| General DAG with free-form edges? | **No.** Guarded sequence with forward-only `next`/`goto`, modelled on Amazon States Language, not n8n. | Every valuable use case is a sequence with conditions and error paths. A DAG engine is a second product. |
| Conditions as branch nodes? | **No.** Step-level `when:` guard. | Keeps the executor a single forward pass; kills demand for routers. |
| Error routing? | **Yes**, `onError: fail \| continue \| { goto }`, forward-only. | Reviewers split; error routing is genuinely needed, cycles are not. |
| Loops / foreach? | **Deferred, not never.** A bounded `map` (N ≤ k, implicit join) only if real usage proves it. | No current use case needs it. |
| MCP connector steps? | **Yes, late (Stage 3)**, and only through the existing `@nessie/mcp-manage` `resolveInstanceMcpTransport`/`callInstanceTool` seam with tool-registry policy. | The objection was forking the credential/policy model. Reusing the one seam is the opposite of forking. |
| Sandboxed JS / code node? | **Never.** | Sandbox escape is RCE in the worker. JMESPath covers ~95% projection work. `environment_launch` is the governed escape hatch. |
| Collapse `WorkflowTemplate` + `WorkflowInstallation`? | **Not now — explicit Stage 4 decision point.** | The correctness bug it is often paired with (version pinning) is fixed independently by run-level snapshots. Collapsing is irreversible if a shared template library is ever wanted. |
| Immutable `WorkflowVersion` table? | **Stage 4, paired with the collapse decision.** Stages 1–3 use run-level and installation-level graph snapshots. | Snapshots fix the live correctness bug now without prejudging the table design. |
| Canvas as primary authoring? | **No.** Conversational (PA-authored) primary; step-list editor secondary; canvas becomes truthful viewer/run-replay. | A designer that renders semantics the runtime cannot execute is worse than no designer. |
| Second scheduler for workflows? | **Never.** `AgentTrigger` already carries `workflowInstallationId`. | One claim protocol, one cron library, one delivery/dedupe model. |

## 3. Stage 1 — Stop lying, become reachable (target: 2 weeks)

Stage 1 ships no new graph model. It makes the existing thing truthful, correct,
and visible. Every item is independently mergeable.

### 1.1 Correctness fixes (blocking; error management depends on them)

- **W1 · Guard terminal transitions.** `markWorkflowStepRunFinished`
  (`worker/src/run/workflows.ts`) selects only `output`/`workflowRunId` and writes
  `workflowRun.status` unconditionally. Convert both the step write and the run
  write to guarded `updateMany` on non-terminal current status — the pattern
  `cancelWorkflowRun`/`skipWorkflowStepRun` already use. Without this a cancelled
  run is resurrected to `completed` by its orphaned child.
- **W2 · Cancel must propagate.** `cancelWorkflowRun`
  (`api/src/services/workflows.ts`) marks steps `skipped` but never cancels the
  suspended child agent run. Propagate cancellation to the child run via the
  existing cooperative `cancelRequestedAt` flag.
- **W3 · Emit terminal events from async continuations.**
  `worker/src/run/execute/parent-workflow.ts` and
  `worker/src/control/execution/workflow-continuation.ts` import the *raw*
  `markWorkflowStepRunFinished`, bypassing the wrapper in
  `worker/src/control/workflows.ts` that emits `workflow.run.completed/failed`.
  When the last step is asynchronous — the common case, since `agent_task` is
  usually last — no terminal event is ever emitted. Route both through the
  emitting wrapper.
- **W4 · Snapshot the graph onto the run.** Add `WorkflowRun.graphSnapshot Json`,
  written at run start; execute from the snapshot. Today `loadWorkflowGraph`
  (`worker/src/run/workflows.ts`) reads the template's *current* `graphJson` on
  every continuation, so a template edit rewrites installed workflows and mutates
  runs already in flight. Also pin an installation-level snapshot at
  install/upgrade so a new run is reproducible from what was installed.
- **W5 · Remove `delegate` from the workflow tool set.**
  `packages/runtime/src/workflow-tools.ts` advertises it and
  `WORKFLOW_TOOL_IDS` makes save-time validation accept it, but the executor has
  no case and always fails. Remove it (do not implement it — sub-agent fan-out
  from a deterministic step is out of scope).
- **W6 · Reap stuck steps.** A crash inside `executeWorkflowBuiltinTool` leaves a
  step `running` forever with nothing to reclaim it. Add a worker sweep (sibling
  of the trigger scheduler) that fails steps `running` past a threshold through
  the same guarded transition.
- **W7 · Mark unreached steps `skipped` on failure.** A failed run leaves later
  steps `pending` forever, which reads in the UI as "still coming".
- **W8 · Fix `paused` enforcement.** Dispatch checks only `active` and `disabled`
  (`api/src/services/trigger-dispatch-workflow.ts`,
  `worker/src/control/workflow-trigger-run.ts`), so a `paused` installation still
  fires while the UI states it will not. Also add the missing update-installation
  endpoint: there is currently **no way to pause an installation after install** —
  status is write-once at install time.

### 1.2 Validation and designer honesty

- **W9 · `{{` must not disable validation.** `hasBindingToken`
  (`api/src/services/workflows.ts`) short-circuits both `toolName` and `agentId`
  checks, so any string containing `{{` skips validation entirely. Parse binding
  expressions properly: validate syntax, verify every `steps.<id>` reference names
  a step that exists *and precedes* the referencing step. A typo must be a save
  error, not a failed run.
- **W10 · Stop the designer eating steps.** `getWorkflowCanvasNodeType`
  (`admin/src/lib/workflow-designer/node-sources.ts`) returns `null` for
  `environment_launch` and the loader `flatMap`s it away; re-saving then writes
  the template back *without that step*. Preserve unknown/unrenderable steps
  through a load→save cycle. This is silent data loss.
- **W11 · The canvas must stop drawing fiction.** Until graph v2 lands (Stage 2),
  forbid multiple outgoing connections and cycles in
  `useWorkflowCanvasInteractions`/`geometry.ts` rather than silently linearizing
  them in `serialization.ts`. Disconnected nodes must not be silently appended to
  the end of the sequence and executed.
- **W12 · One tool allow-list.** `builtin-tools.ts`, the designer's
  `constants.ts`, and `services/workflows.ts` each maintain the list by hand and
  agree only by coincidence. Export one list and derive all three.
- **W13 · Demote the trigger node.** Three layers hold three different beliefs
  about what a `trigger` step is: validation accepts it, the runtime no-ops it
  ("visual-only at runtime"), and the designer strips it on save. Worse, the cron
  and timezone a user types into the canvas trigger node **never become an
  `AgentTrigger`** — real scheduling requires a separate "Add trigger" action on
  the installation. Either make the node create the trigger, or remove the config
  fields and link to the Triggers page. Do not ship a form that does nothing.
- **W14 · Scope the designer draft.** `localStorage` drafts
  (`draft-storage.ts`) are keyed globally, not per template, so editing template A
  then opening "new workflow" hydrates A's nodes.

### 1.3 The primitives that make workflows worth having

- **W15 · `message_send` step.** A deterministic channel write through the
  existing message-create service, under the workflow's durable actor, targeting
  the installation's channel or a bound thread, body rendered from bindings. This
  is the single highest-leverage missing node: without it the platform's cheapest
  capability is the one thing its deterministic engine cannot do.
- **W16 · `when:` guard.** A step-level predicate; falsy ⇒ step `skipped`, run
  continues. Turns the flagship watcher from "pay for an agent every sweep" into
  "pay only when something changed".
- **W17 · `transform` step (JMESPath).** See §5.
- **W18 · Compare-and-set on `state_put`.** Today a blind `upsert` with a blind
  version increment. Two overlapping runs both read the same previous value and
  both act — which corrupts exactly the watcher pattern the tools exist for. Add
  an `expectedVersion` argument and fail the write on mismatch.

### 1.4 Reachability (Rule zero)

- **W19 · Entitlement-scoped access.** All 19 workflow route handlers are
  `requireOwner`, and `WorkflowsPage` renders "Owner access required" to everyone
  else. Open **reads** — installations, runs, run detail — to members entitled to
  the installation's scope. Keep authoring owner/admin. Scope by entitlement, not
  by the session claim.
- **W20 · Channel Automations tab.** The doorway. Lists installations whose
  `channelId` is this channel, with last-run status and run-now/pause.
- **W21 · Run cards in the channel.** Start/finish/fail messages carrying
  `metadata.workflowRun = { workflowRunId, installationId, status }`, exactly as
  budget-stop notices carry `metadata.runStop`. The failed card gets a one-tap
  **Resume** mirroring `RunStopContinue.tsx`.
- **W22 · Audit every mutation.** No workflow route writes an audit entry today.
  Template create/update (it mutates executable org behaviour), install, manual
  run, cancel, retry, skip, block/unblock, and pause are all audit-worthy.
- **W23 · Failure reaches a human.** Route `workflow.run.failed` through the
  shared push pipeline (`worker/src/control/push-delivery-core.ts`, the
  budget-alert precedent) to the installation creator and channel managers,
  deep-linking the run.
- **W24 · Paginate the lists.** `WORKFLOW_LIST_LIMIT` truncates at 200 with no
  cursor; the admin silently stops showing rows past the cap.

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
pending". `WorkflowStepRun` gains `attempt Int @default(1)` and
`nextAttemptAt DateTime?`; attempts are recorded in place via an `attemptHistory`
JSON column rather than new rows, preserving `@@unique([workflowRunId, sequence])`.

Move the shared contract into a package consumed by API, worker, and admin. The
worker currently redefines a weaker local `WorkflowGraph` type
(`worker/src/run/workflows.ts`), which is how contract drift starts.

The designer serializer emits v2 and **derives `next` from its edges instead of
discarding them** — the canvas finally means what it shows.

### 4.2 Error management (the addendum, in full)

1. **Per-step retry with backoff.** On failure, if `attempt < retry.maxAttempts`
   and the failure class matches `retryOn`, set the step back to `pending` with
   `nextAttemptAt = now + backoffMs * multiplier^(attempt-1)` and enqueue a
   delayed `workflow.run.execute` (the pg queue already supports `visibleAt`).
   Classification: `transient` = 5xx, timeout, network, queue crash. Everything
   else — binding not found, validation, `UrlSafetyError`, 4xx — is permanent;
   retrying a deterministic failure is noise. The executor's step selection gains
   `nextAttemptAt <= now`.
2. **Idempotency on retry.** The mailbox correlation id is
   `workflow-step:${stepRunId}`, so a retried `agent_task` would dedupe against
   the *failed* attempt's mailbox row and never re-dispatch. It must become
   `workflow-step:${stepRunId}:${attempt}`. Same for `connector_call`: carry
   `Idempotency-Key: <stepRunId>:<attempt>` where supported, and default
   non-idempotent connector steps to no retry.
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
6. **Dead letter and alerting.** No new table: the DLQ is the failed-runs view
   (list API already returns status), the channel failure card (W21), and push
   (W23). Poison-message caps: a hard ceiling per step (5) and per run (25 total
   attempts) so a mis-configured retry block cannot spin.
7. **Partial resume from the failed step.**
   `POST /api/workflow-runs/:id/resume` flips the failed step — and only it —
   back to `pending`, resets `attempt`, re-enqueues execute. Completed steps stay
   completed and their snapshots keep feeding bindings. Requires W1's guards
   (a terminal run must transition `failed → running` through one guarded
   `updateMany`). Keep full `retry` for the "inputs were wrong" case; the run card
   offers both.

### 4.3 Composition and human-in-the-loop

- **`invoke_workflow` builtin.** The founding design decision, never built.
  `invoke_workflow(installationId, input)` creates a `WorkflowRun` with
  `parentRunId` (the column and validation already exist), suspends the tool call,
  and resumes the agent run when the workflow terminates — the exact inverse of
  `agent_task`, on the same continuation machinery. Gated per-agent through
  `toolPolicy` with the DeepWater explicit-grant pattern; installation scope is
  enforced as **tenancy**, not policy. `WorkflowRun.output` already exists to carry
  the result.
- **`approval` step.** A real Approval row that resumes on resolution — not the
  current operator `blocked` toggle, which is an operator race, not a decision.
  Human input and approval stay distinct: approval authorizes, human input
  collects data.
- **`human_input` step.** Suspends on the same mailbox mechanism, resumes with a
  reply payload, surfaced as a channel card.
- **`wait` step.** Durable timer.

### 4.4 Governance

- **Budget gate.** `executeWorkflowRun` never consults the org `Budget`. Apply
  `evaluateBudget`/`applyBudgetGate` at run start and between steps, and roll
  child agent-run spend up to the `WorkflowRun`. Add a workflow dimension to
  `/ops/usage` (owner-only telemetry — never beside customer credits).
- **Secret taint boundary.** `resolvedBindings` and `config` are arbitrary JSON,
  interpolated into step inputs, persisted, and rendered in the run inspector.
  There is no secret-reference type and no redaction. Declare which bindings are
  refs vs literals in `bindingSchema`, keep credentials server-side as
  `secret_*` refs, and mark tainted values so they cannot enter run JSON, prompts,
  messages, logs, or exports. **This gates W19's read-access widening** — do not
  broaden visibility before it lands.
- **Install scope must be explicit.** Install copies `projectId`/`teamId` from the
  session while accepting any channel in the org, never proving they agree.
  Accept them explicitly and validate the whole hierarchy.
- **Data minimisation.** An agent step receives selected fields, never a whole
  webhook or connector response.

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
tool outputs are already truncated middle-out upstream); evaluation wall-clock
cap (100 ms watchdog — JMESPath has no loops, but pathological wildcard
projections over adversarial documents deserve a fuse); output cap (256 KiB); and
the important one — **the binding context never contains secrets** (see §4.4).
No network, no filesystem, no ambient env by construction.

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

- **Overlap/concurrency: there is none today.** Every due fire creates a fresh
  run regardless of one still `running`; the only dedupe is the per-slot key. Add
  `WorkflowInstallation.concurrency Json` →
  `{ limit: 1, onOverlap: 'skip' | 'queue' | 'parallel' }`, defaulting to
  `{ limit: 1, onOverlap: 'skip' }`. Enforce inside the `queueWorkflowTriggerRun`
  transaction under `pg_advisory_xact_lock(hashtext(installationId), …)`:
  `skip` records the delivery with a `skipped_overlap` status so silent skips stay
  diagnosable; `queue` withholds the execute job until the active run's terminal
  transition releases the next one; `parallel` is opt-in for stateless workflows.
- **Catch-up after downtime is two accidents, not a policy.** Cron computes the
  next fire from the *missed* slot, so an outage of N slots replays N fires
  uncapped; interval uses `max(from, now)` and silently drops them. Add per-trigger
  `catchUp: 'skip' | 'once' | 'all'` (default `'once'`: one make-up run, then
  compute from now) in the shared library so agent and workflow triggers get the
  same semantics.
- **Rate ceiling.** `NESSIE_WORKFLOW_MAX_RUNS_PER_HOUR` as a deployment backstop
  so a mis-authored 1-minute interval plus catch-up cannot flood the queue — the
  same "safety envelope, not user budget" philosophy as `NESSIE_RUN_BACKSTOP_*`.
- **Cron and timezones are already correct** (`cron-parser` with a validated
  `timezone`, `until` end-dates, one-off mode). Expose the timezone field in the
  designer's trigger inspector — it is advanced-JSON-only today.

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
not. Once graph v2 lands its edges mean `next`/`goto` and it can be an editor
again.

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

## 9. Never build

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

## 10. Traceability — every review finding, and where it is handled

Findings from three independent reviews (Fable, Kimix, Codex Sol, 2026-08-12).
Every row must be closed or explicitly waived before this plan is considered
delivered.

### Defects

| # | Finding | Handled by |
|---|---|---|
| D1 | `delegate` advertised, save-valid, always fails at runtime | W5 |
| D2 | Cancelled runs resurrected by orphaned children (unguarded terminal writes) | W1, W2 |
| D3 | Designer silently linearizes drawn branches; disconnected nodes still execute | W11, §4.1 |
| D4 | Version pinning decorative; template edits mutate installed **and in-flight** runs | W4 |
| D5 | No overlap control; `state_put` blind upsert loses updates | W18, §6 |
| D6 | Cron catch-up uncapped replay; interval silently skips | §6 |
| D7 | No budget gate anywhere | §4.4 |
| D8 | No audit entries anywhere | W22 |
| D9 | Mailbox correlation id lacks attempt suffix (breaks retries) | §4.2.2 |
| D10 | Terminal events never emitted when last step is async | W3 |
| D11 | Install scope ambient (project/team from session, channel unvalidated against them) | §4.4 |
| D12 | Secrets/bindings persisted cleartext into run artifacts; no taint boundary | §4.4 |
| D13 | `paused` installations still fire; no way to pause after install | W8 |
| D14 | `{{` bypasses all save-time validation | W9 |
| D15 | `environment_launch` steps silently deleted by designer round-trip | W10 |
| D16 | `trigger` step type: three layers, three beliefs; canvas cron never creates a trigger | W13 |
| D17 | `agent_task` target validation races and leaks existence across org boundary | W19 (gate before widening reads) |
| D18 | Retry rewrites `startedByActorId`, losing original actor | W22 (annotate, don't rewrite) |
| D19 | List endpoints truncate at 200 with no cursor | W24 |
| D20 | Designer draft in `localStorage` leaks across templates | W14 |
| D21 | Steps stuck `running` forever after a crash; no reaper | W6 |
| D22 | Failed runs leave later steps `pending` forever | W7 |
| D23 | Run detail polls instead of using realtime events | §8 |
| D24 | Three hand-maintained tool allow-lists agree only by coincidence | W12 |
| D25 | List endpoint comment contradicts the code it documents | W24 |
| D26 | `change_detect` → `state_put` not atomic across overlapping runs | W18, §6 |
| D27 | Worker redefines a weaker local `WorkflowGraph` type (contract drift) | §4.1 |

### Capabilities

| # | Finding | Handled by |
|---|---|---|
| C1 | No `message_send` — deterministic layer cannot deliver its own output | W15 |
| C2 | No condition — watcher pays for an agent on every sweep | W16 |
| C3 | No `transform`/mapper — cannot reshape between steps | W17, §5 |
| C4 | No `invoke_workflow` — the founding design decision, unbuilt | §4.3 |
| C5 | No approval step (operator `blocked` toggle is not an approval) | §4.3 |
| C6 | No human-input step | §4.3 |
| C7 | No MCP connector step | §2 (Stage 3), §4.1 |
| C8 | No wait/timer step | §4.3 |
| C9 | No per-step retry, backoff, catch, or timeout | §4.2 |
| C10 | Retry is re-run-from-zero; no partial resume | §4.2.7 |
| C11 | Owner-only: unreachable by members | W19 |
| C12 | No channel doorway; no run cards | W20, W21 |
| C13 | Failure alerts nobody | W23 |
| C14 | Tasks/plans linkage is schema-only, half-wired | Stage 4 — wire or drop the columns |
| C15 | No KB steps | Stage 4 |
| C16 | No spend roll-up or per-installation usage | §4.4 |
| C17 | Canvas is the wrong primary authoring surface | §7 |
| C18 | No shape awareness / sample data / preview when authoring bindings | §5 |

### Open decision, deliberately deferred

**Stage 4 · Collapse `WorkflowTemplate` into `WorkflowInstallation`?** Two of
three reviewers argued the indirection buys nothing today — no marketplace, no
cross-org sharing, `resolvedBindings` largely unused. The third argued for
keeping it with immutable `WorkflowVersion` rows. Deferred because W4's snapshots
fix the live correctness bug either way, and collapsing is expensive to reverse
if a shared template library is ever wanted. Revisit with usage data after
Stage 2.
