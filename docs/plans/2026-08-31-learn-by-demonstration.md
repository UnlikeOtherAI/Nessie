# Learn-by-demonstration — recorded, replayable skills

> Status: in delivery, revision 3 (2026-08-31). P1 capture and P2
> generalisation-to-draft Workflow are implemented, including provenance,
> approval-gated agent proposals, and the existing Workflows review doorway.
> Remaining work is adoption measurement and the later to-do-template fallback.
> Motivated by the competitive audit
> [2026-08-31-grok-bot-vs-nessie-capability-audit.md](./2026-08-31-grok-bot-vs-nessie-capability-audit.md)
> dimension 6: "Learn-by-demonstration is **behind — no code found**."
> This plan is the concrete delivery of **S4.2 · Promote-a-run-to-a-playbook**
> from [2026-08-12-workflows-first-class.md](./2026-08-12-workflows-first-class.md)
> (§6b), which already named the shape and the prerequisite ("Not before §4.2a
> gives it a version to write into") — it is deliberately **not** a new
> subsystem beside Playbooks. Where the two documents disagree, the workflows
> plan wins; this one adds the capture half S4.2 assumed ("a trustworthy
> trace") and did not design.

## 0. The one-paragraph version

A Nessie demonstration is not screen recording. The user's hands in Nessie are
agents, so "show the system how" means: guide an agent through the task once in
chat, with recording armed, and the platform captures the **structural trace**
of what the agent actually did — tool ids, full (redacted) structured
arguments, step order, outcomes — at the one chokepoint every tool call already
flows through (`worker/src/run/execute/tool-events.ts` `recordToolEnd`). When
the user stops the recording, a bounded model pass generalizes that concrete
trace into an existing **`WorkflowTemplate`** (Playbook): literals become typed
`variableSchema` inputs, spans expressible as deterministic steps become
`tool`/`transform`/`message_send` steps, everything else folds into an
`agent_task` step so judgment stays with the model. The output is a *draft* the
user reviews in the existing designer and installs through the existing
install/trigger/approval/budget/audit machinery — a raw recording is never
runnable, because the only runnable artifact in this design is an installed
workflow, and installation was already an explicit, entitlement-checked act
(`api/src/routes/workflows/installations.ts:68`). Nothing here records pixels,
DOM events, keystrokes, or desktop apps, and nothing here string-matches
message content: recording starts and stops are model-judged tool calls or
explicit UI clicks, and the captured facts are all structural.

**Scope honesty up front:** this teaches Nessie to *pin a procedure an agent
performed*, not to watch a human use a computer. Grok's claimed capture of user
VM actions is a different capability sitting on a different execution model
(the audit §7 flags even Grok's fidelity as unverified). Product copy must say
"teach an agent by doing it together once", never "record your screen".

## 1. Why record-a-run → Playbook, and why the to-do path follows

The task offered two shapes. Decision: **(a) record-a-run generalized into a
Workflow/Playbook is the first step**; (b) to-do-template capture is a cheap
follower, not the lead. Reasons, in order of weight:

1. **(b) already half-exists.** `todo_template_propose`
   (`packages/runtime/src/builtin-todo-tools.ts:5`, handler
   `worker/src/run/pa-tools/todos.ts` `runTodoTemplateProposeTool`) *is*
   embryonic learn-by-demonstration: an agent generalizes what it just did into
   a reusable named checklist, gated by an owner `ApprovalRequest`
   (`agent.todo_template.publish`, effect in
   `api/src/services/approval-effects.ts:129`), with a pending-proposal cap and
   a disclosure fail-closed guard. But a to-do template is **instructions for a
   future agentic run** (`AgentTodoStep.instructions`, free prose) — it buys no
   cost floor, no pinning, no deterministic replay. The audit's gap is
   *replayable skills*, and replayability is exactly what the workflow engine
   provides and to-dos do not.
2. **Every expensive piece of (a) already exists.** Persistence
   (`WorkflowTemplate`/`WorkflowInstallation`/`WorkflowRun`/`WorkflowStepRun`,
   `api/prisma/schema.prisma:2690-2873`), save-time validation that rejects
   anything the runtime cannot execute
   (`api/src/services/workflow-validation.ts`, the W17 rule), an executor with
   guards/leases/overlap policy (`worker/src/control/workflows.ts`), scheduling
   with no second scheduler (`AgentTrigger.workflowInstallationId`,
   `api/src/routes/workflows/installations.ts:393`,
   `worker/src/control/trigger-scheduler.ts`), entitlement-scoped surfaces
   (W19/W20/W21: `admin/src/pages/WorkflowsPage.tsx`,
   `admin/src/components/features/channels/ChannelAutomationsPanel.tsx`), and
   route-level audit (W22). The greenfield part is only: a capture table, one
   hook at an existing chokepoint, one generalization job, and doorways.
3. **The workflows plan already reserved the slot.** S4.2 says the promotion
   needs "a trustworthy trace and a defined validation pass". This plan is
   those two things. Building demonstration capture that generalizes into
   anything *other* than a `WorkflowTemplate` would be the Rule-zero §4 fork —
   a second automation artifact beside Playbooks.

**How (b) follows:** once the trace exists, offering "save as a to-do template
instead" is one extra branch in the generalization prompt whose output feeds
the *existing* `createAgentTodoTemplate` + approval path — for routines that
are checklists of judgment rather than pinnable procedures. Stage C, ~days of
work, zero new tables.

## 2. Scope decisions (made, not open)

| Question | Decision | Why |
|---|---|---|
| Record human UI actions (admin clicks, browser, desktop)? | **Never in this plan.** | Nessie's actuation surface is agent tools. Even the executor's `browser.act`/`command.run` are declared-only (audit §2, `worker/src/run/executor-toolset.ts`); recording pixels for verbs that cannot replay is fiction. Structural tool traces are the only faithful, replayable substrate we have. |
| Capture full arguments on **every** run? | **No — opt-in arming only.** | `ToolCall.inputSummary` is a redacted 200-char preview by design (`worker/src/run/tool-util.ts:123` `summarizeToolInput`). Widening it, or shadow-writing full args for all runs, creates an always-on sensitive-data lake (the `stepSamples` lesson: "a convenience feature must not become an unaudited data lake") and write amplification for a feature most runs never use. |
| Reconstruct a recording retroactively from a past run's `ToolCall` rows? | **No.** | The rows carry truncated, redacted summaries (`tool-events.ts:58`); "best-effort" reconstruction of arguments from previews is the silent-lossy-replay defect class. If a user asks *after* the fact, the PA answers honestly: arm a recording and do it once more together. |
| New tables vs reusing `Run`/`ToolCall` with a marker? | **New `Demonstration` + `DemonstrationStep` tables; runs are referenced, not copied.** | Justified in §4. A marker column on `ToolCall` cannot hold full arguments without changing every run's write path; a marker on `Run` cannot span the multi-run session a guided demonstration is. |
| A separate "Skills" artifact/library? | **Never.** The generalized artifact **is** a `WorkflowTemplate` with provenance columns. | Rule zero §4 (reuse the surface); the workflows plan's "one row is one app" store lesson. A parallel skill store guarantees drift from the Playbooks surface. |
| Auto-run or one-click-run a raw recording? | **Never.** | The only runnable artifact is an installed workflow. Generalization produces a *template*; running requires the pre-existing explicit install (`POST /api/workflows/:id/install`) + fire/trigger, each entitlement-checked, audited, budget-gated. |
| Start/stop detection from message content? | **Never string-matched.** | AGENTS.md "Natural-language intent is model-judged". Conversational arming is a PA builtin the model calls (`demonstration_start`/`demonstration_stop`); the UI button is structural. No trigger-phrase lists. |
| Generalization pass — where does it run? | Worker queue job (`demonstration.generalize`), model client resolved the way non-run inference already is (engagement decisions, `worker/src/run/orchestrate.ts`; utility-model preference per the compaction precedent, `worker/src/run/context-compaction.ts`). | Stop can come from the UI with no live run to piggyback on. |
| Ship unconditionally? | **No** — adoption gate at the end of Stage B (§10), mirroring workflows §9. | If demonstrations are armed but drafts are never installed, the capture half was the wrong bet; keep `todo_template_propose` and stop. |

## 3. What a demonstration session is

A **`Demonstration`** is a bounded recording window on one `(agent, thread)`
pair, opened by a person:

- `Demonstration { id, organizationId, agentId, threadId, channelId,
  startedByUserId, status: recording | captured | generalized | discarded,
  workflowTemplateId?, generalizationError?, startedAt, capturedAt?, expiresAt }`
  — org-scoped, `onDelete: Cascade` from `Organization`, partial unique index
  on `(agentId, threadId) WHERE status = 'recording'` so two recordings cannot
  interleave on one surface.
- `DemonstrationStep { id, demonstrationId, runId, sequence, toolName,
  argumentsJson, success, startedAt, durationMs }` — `@@unique([demonstrationId,
  sequence])`. `argumentsJson` is the **full structured tool arguments after
  `redactToolInputValue`** (the same redactor `summarizeToolInput` already
  applies, minus the 200-char slice), so a secret-shaped value is dropped at
  write time, not at render time. No output payloads are stored — the
  generalizer needs *what was asked*, not *what came back*; step outputs are
  exactly the customer-data lake §2 refuses to build. `success` and duration
  are enough for the model to skip dead-end branches.

**What is captured (all structural, zero content heuristics):** tool id, full
redacted arguments, order, success, the run each step belonged to, and the
session's fixed agent/channel/thread identities. The *goal* is not copied
text: `goalMessageId` references the message that asked for the task, and the
generalizer reads it (and the recorded runs' trigger messages via
`Run.triggerMessageId`) through the normal read path at generalization time —
one copy of content, owned by the messages table.

**Arming and capture mechanics:**

- Run setup (`worker/src/run/execute/run-setup.ts`) loads the active
  `Demonstration` for `(context.agent.id, context.run.threadId)` into
  `RunContext` — one indexed query per run, null for everyone else.
- The capture hook is a sibling module
  `worker/src/run/execute/demonstration-capture.ts` called from
  `recordToolEnd` (`tool-events.ts:22`) — the single funnel every builtin,
  MCP, KB, and executor tool end already passes through, including the
  executor's pre-created-ToolCall path (`toolCallRecordId`,
  `worker/src/run/executor-toolset.ts:284`). It appends a `DemonstrationStep`
  with a transaction-free insert; sequence is allocated per demonstration
  under the same advisory-lock discipline as `applyReplyBookkeeping`-style
  counters. Capture failures log and never fail the run (the connector-usage
  precedent in the same file, `tool-events.ts:88`).
- Executor operations (`executor.browser.open`, `executor.file.*`,
  `executor.coding.launch`) are captured like any other tool: they are
  structural tool calls. They are **not** replayable as deterministic workflow
  steps (not in `WORKFLOW_TOOL_IDS`), so §5 folds them into `agent_task` spans.
- `delegate` sub-agent internals are not captured; the `delegate` call itself
  is one step. Recursing into a sub-agent's trace records an implementation
  accident, not the demonstrated procedure.
- **Bounded by construction:** `expiresAt` (default now + 4 h; env
  `NESSIE_DEMONSTRATION_TTL_MS`) and a step cap
  (`NESSIE_DEMONSTRATION_MAX_STEPS`, default 200). The sweep that already
  expires approvals handles expiry → status `stopped` with a "expired, review
  what was captured" note. A forgotten recording must not become ambient
  surveillance of a channel.

**Starting and stopping (three doorways, all structural or model-judged):**

1. **Chat:** new builtins `demonstration_start`, `demonstration_stop`,
   `demonstration_status` — definitions in
   `packages/runtime/src/builtin-demonstration-tools.ts`, handlers in
   `worker/src/run/pa-tools/demonstrations.ts`, wired through the
   `worker/src/run/tools.ts` dispatch like `workflow_transform_preview`
   (`tools.ts:170`). Available to any agent (not PA-only): the person
   demonstrates *to the agent that will own the skill*. The model calls them
   when the person's intent is to teach — in any language, per the
   model-judged rule. The service functions live in
   `packages/workspace-admin/src/demonstrations.ts` so the API routes reuse
   them (the pa-tools mirroring rule, AGENTS.md).
2. **UI:** a Record control in the channel header for a bound agent, calling
   `POST /api/demonstrations` / `POST /api/demonstrations/:id/stop`
   (`api/src/routes/demonstrations.ts`, re-exporting the shared service).
   Requires channel membership (`getChannelIfMember`) — the person can only
   record where they can already speak.
3. **Structural stop:** TTL, step cap, or the agent/thread being deleted.

While recording, the channel shows a persistent recording pill on the feed for
**everyone who can see the channel** (reusing the `Pill` primitive and the
`message.updated`-style realtime refresh from the watch-status machinery) —
naming the agent and the person who armed it. Teammates in a shared channel
must be able to see that a trace is being kept.

## 4. Storage decision — why not reuse `Run`/`ToolCall` alone

Considered and rejected:

- **A `demonstrationId` marker on `ToolCall` + widening `inputSummary`.**
  `ToolCall` is written on *every* tool end of *every* run
  (`tool-events.ts:58`); its `inputSummary` is deliberately a truncated
  preview for the timeline UI (`schema.prisma:3436-3459`). Making it
  conditionally full-fidelity gives one column two meanings decided by a flag
  elsewhere — the exact "store re-derives a decision from `status`" shape the
  App Store work banned. It also couples retention: demonstrations need
  quota/retention/cascade-delete semantics (`stepSamples` precedent) that run
  telemetry does not.
- **A marker on `Run`.** A guided demonstration spans several runs (the person
  corrects, the agent retries across turns in the thread). Sessions are the
  unit, runs are members. `DemonstrationStep.runId` keeps the join to the
  existing record model — the trace *references* runs and tool calls, it does
  not duplicate their lifecycle.

So: two new tables, opt-in writes, referencing `Run` rows, full arguments
stored once, redacted at write time, deleted with the demonstration
(`POST /api/demonstrations/:id/discard`, and cascade when the draft template
is deleted only if the demonstration was already terminal).

## 5. Generalization — concrete trace → parameterized draft

On `stop`, the service enqueues `demonstration.generalize` (idempotency key
`demonstration:generalize:<id>`; the worker claims the `captured → generalized`
transition in the same transaction that creates the template, so redelivery
cannot double-generalize). The job, in
`worker/src/control/demonstration-generalize.ts`:

1. **Assemble the evidence.** Ordered successful `DemonstrationStep` rows and
   the closed workflow vocabulary — `WORKFLOW_TOOL_IDS` and the executable step
   types in `@nessie/workspace-admin`:
   `agent`/`agent_task`, `environment_launch`, `message_send`,
   `tool`/`tool_call`, `transform`).
2. **One model pass with a structural contract.** The prompt states the
   mapping rules rather than asking for creativity: a step whose `toolName` is
   in `WORKFLOW_TOOL_IDS` may become a deterministic `tool` step; contiguous
   spans that are not (KB writes, executor ops, connector calls, `delegate`)
   fold into a single `agent_task` step whose instruction the model writes
   from the goal + span; repeated-literal values that vary per invocation
   (dates, names, URLs, ids) become `variableSchema` entries referenced as
   `{{workflow.input.x}}` bindings; values flowing from one step's output to
   another's input become `{{steps.<id>.output…}}` bindings or a `transform`
   step. Failed steps and retried dead ends are dropped (the trace marks
   `success`). The judgment of *what generalizes* is the model's; the
   *vocabulary it may emit* is closed.
3. **Validate with the real validator, iterate bounded.** `validateWorkflowGraph`
   in `@nessie/workspace-admin` is called by both the API's save path and the
   worker before persistence. It includes binding order/syntax, JMESPath,
   executable-step, tool, and live-agent entitlement checks. Issues
   are fed back to the model for up to `NESSIE_DEMONSTRATION_GENERALIZE_ATTEMPTS`
   (default 3) — the compaction bounded-attempts pattern. This is the W17 rule
   doing its job: the generalizer *cannot* mint a step type or tool the runtime
   would fail on, because the same list gates both.
4. **Persist the draft.** A normal `WorkflowTemplate` uses two additive provenance
   columns: `source: 'authored' | 'demonstration'` (default `'authored'`) and
   `demonstrationId?`. `createdByActorType/Id` is the **demonstrating user**,
   not the agent — the person owns the skill (the `Agent.ownerUserId`
  stewardship philosophy). Demonstration → `generalized`, with
  `workflowTemplateId` set. Model-call spend is recorded through the normal
   inference accounting; the run-level attribution is the generalize job's
   durable origin (the user-triggered-system-job rule from the Ledger identity
   contract).
5. **Failure says so.** An exhausted validation loop or a restricted source
   remains `captured` with `generalizationError`, rendered on the Workflows
   demonstration drafts list. It is never a silent retry loop.

## 6. Review, approve, install — a recording is never runnable

Two paths, split by who initiated — mirroring the to-do template split
(owner-direct vs `todo_template_propose`):

- **User-initiated (Stages A–B, the default).** The demonstrating user
  reviews their own draft: the completion card links to
  `WorkflowTemplateDetail` and the designer
  (`admin/src/pages/WorkflowDesignerPage.tsx`) where the graph, variables, and
  bindings are inspectable and editable exactly like a hand-authored template.
  Making it *runnable* is the pre-existing explicit chain: install
  (`POST /api/workflows/:workflowTemplateId/install`,
  `installations.ts:68` — entitlement-checked, install scope explicit per
  workflows §4.4) → run-now (`installations.ts:242`) or schedule
  (`installations.ts:393` creating an `AgentTrigger` on the one scheduler).
  Budgets, overlap policy, run cards, failure alerts, and W22 audit all apply
  because the artifact is an ordinary installation. **No new approval
  machinery is needed for this path** — install *is* the human decision, made
  by a person on a reviewable, validated artifact, and adding a second gate in
  front of it would be ceremony.
- **Agent-proposed.** When an agent (not a person) initiates —
  "I've done this three times, want me to pin it?" — the draft is created the
  same way but gated behind an `ApprovalRequest` with a new action
  `workflow.template.adopt`, cloning the `todo_template_propose` shape
  exactly: pending-proposal cap under `acquireAgentTodoAgentLock`-style
  advisory lock, `requiredApproverRole: 'owner'`, expiry, and a third `case`
   in the `approval-effects.ts` dispatch. Until approved, the draft template is
  install-refused: `installations.ts:68` gains one guard — a
  `source: 'demonstration'` template whose demonstration was agent-initiated
  and whose adopt approval is not `approved` returns 409. The store-reads-a-
  decision rule: approval *writes* an `adoptedAt` on the template; the install
  guard reads that column, never re-derives from approval status.

In both paths the raw `DemonstrationStep` trace remains attached read-only to
the template detail ("what this was learned from"), entitlement-checked by the
same W19 read scoping as the template itself.

## 7. Rule zero — the owning surface and the doorways

**Owning surface: the Workflows page** (`admin/src/pages/WorkflowsPage.tsx`).
Learned drafts are rows in the existing template list with a provenance pill
("Learned" — one addition to
`admin/src/components/features/workflows/presentation.tsx`), not a parallel
library. Drill-down is the existing template → installation → run column
browser. Rule zero §4: the same thing appears in one component parameterised
by provenance, never a fork.

**Doorways, on the screen where the question arises:**

1. **The channel/thread — where the work happens.** The Record routine control
   and the persistent recording pill use the shared channel header and `Pill`
   primitive; nothing starts from interpreted text in the browser.
2. **Chat itself** — `demonstration_start/stop/status` builtins (§3), so
   "let me show you how we do the weekly digest" needs no UI hunt.
3. **The Workflows page.** `DemonstrationDraftsColumn` is a list within the
   existing workflow column browser. Its Generalise action queues a draft and
   its Review action selects the resulting ordinary template; it is not a skills
   library. The channel Automations tab
   (`ChannelAutomationsPanel.tsx`) — where an installed learned playbook lives
   beside every other automation of that channel, with run-now/pause per the
   W19 role matrix. No new tab: a learned playbook installed to a channel *is*
   an automation of that channel.
4. **Approvals** (agent-proposed path) — the existing approvals surface
   renders the `workflow.template.adopt` request like any other.
5. **Triggers/scheduling** — the installation's existing Triggers surface
   (`installations.ts:377,393`); nothing new.

Every element names its decision: the pill answers "where did this playbook
come from"; the card answers "did my demonstration become something, and what
do I do next"; the recording pill answers "is a trace being kept here".

## 8. Tenancy, disclosure, audit

- **Tenancy.** Both new tables carry `organizationId` with cascade FKs;
  every route and service predicate resolves through channel membership
  (`getChannelIfMember`) and the live `OrganizationMember` row at call time
  (the pa-tools `resolveActingMember` rule). `DemonstrationStep` never stores
  cross-org references — `runId` is same-org by construction (the run's thread
  is the demonstration's thread). The generalizer validates any `agentId`/
  `channelId` appearing in the draft graph through the same
  `isAgentAccessibleToActor` check save-time validation already applies.
- **Disclosure — the proposal is the exposure point, and it fails closed.**
  A workflow template is visible to reviewers/installers beyond any single
  run's audience and cannot carry a per-run basis — exactly the
  `todo_template_propose` situation, so the same rule applies. Before inference,
  any recorded run has `RunBasisScope` rows (the persisted form of
  `ConsumedSourceSink`), generalization is refused in words: the person is
  told the demonstration drew on restricted material and to re-demonstrate in
  a clean conversation. Checked against the durable per-run scopes, not the
  live sink, because stop can arrive after the runs ended.
  *Replay-time* disclosure needs nothing new: deterministic workflow tools
  are public-web + state + channel-write, and `agent_task` steps run ordinary
  agent runs whose reads feed the sink like any other run.
- **Redaction.** `argumentsJson` passes `redactToolInputValue` at write time;
  the demonstration read routes additionally apply the W0 taint rules before
  rendering (the trace is a data sink in W0's list-of-sinks sense). Retention:
  steps are deleted on discard and pruned `NESSIE_DEMONSTRATION_RETENTION_DAYS`
  (default 90) after the demonstration goes terminal without a template.
- **Audit.** Every mutation writes through the audit chain
  (`packages/db/src/audit-chain.ts` `writeAuditEntry`):
  `demonstration.started`, `demonstration.stopped`, `demonstration.discarded`,
  `demonstration.generalized` (links `workflowTemplateId` — the reciprocal
  audit↔artifact link workflows §4.4 asks for), and
  `workflow.template.adopted` on approval. Install/run/trigger mutations are
  already audited by W22 and gain nothing new.

## 9. Testing

- **Capture unit tests** (`worker/test`): armed vs unarmed runs (no rows when
  unarmed — the empty-basis-fails-open lesson says test the *absence*);
  redaction of secret-shaped arguments; the `toolCallRecordId` executor path;
  step cap and TTL stop; capture failure not failing the run.
- **Generalizer tests with the mock-LLM harness** (`worker/test/db`): a scripted
  malformed transform is rejected by the shared save-time validator, the next
  scripted answer is persisted as an `agent_task` fold, and an agent-proposed
  draft creates a pending `workflow.template.adopt` request.
- **DB suites** (`worker/test/db` rules apply — seed-scoped cleanup, no
  global assertions): the partial-unique recording index under concurrent
  arms; CAS on `stopped → generalizing` under queue redelivery; disclosure
  fail-closed when a recorded run carries `RunBasisScope` rows.
- **API tests**: route entitlements (member records only where a member;
  agent-proposed install refused before adoption; 409 shape); Prisma-fake
  rule — every new delegate/relation the routes read is taught to the fake in
  the same commit.
- **Playwright verification** (AGENTS.md "Verification") of: the Record
  control, the recording pill, the completion card deep link, the Learned
  pill on the Workflows list, and the install-refusal state — against
  `http://localhost:5455`.

## 10. Staged rollout, with an adoption gate

- **Stage A — capture + generalize + review (the spine, implemented).** Tables +
  migration, capture hook, stop/discard, generalize job, provenance columns,
  Workflows-page provenance pill and drafts column, UI record control, and the
  approval-gated agent proposal path. Exit criterion: a person records "fetch this page,
  summarize, post to #ops" once, and the resulting *installed* playbook
  re-runs it on a schedule with zero agent hops on the deterministic steps —
  the same flagship shape as workflows §3.5.1.
- **Stage B — conversational arming.** The three builtins + model-judged
  start/stop, non-English/slang test fixtures (the intent-testing rule), the
  demonstration card in-thread. **Adoption gate here**, mirroring workflows
  §9: instrument armed demonstrations, drafts produced, drafts installed, and
  repeat runs of learned playbooks. If drafts are produced but never
  installed, stop — the trace was the wrong substrate, and
  `todo_template_propose` remains the honest routine-capture story.
- **Stage C — to-do fallback.** The "save as a to-do template instead" branch
  (§1), gated on Stage B's adoption verdict.

Docs land with each stage (CLAUDE.md capability section, this plan's status
banner, and a cross-reference from the workflows plan's S4.2 row) — the
Documentation & Goals rule.

## 11. Never build / not built (scope honesty)

- **No pixel, DOM, keystroke, screen, or coordinate recording** — no macro
  recorder, no screen-scraping heuristics, no replay of UI coordinates.
- **No cross-app desktop capture** and no capture inside executor guests: the
  executor's own actuation verbs are partially unshipped (audit §2); recording
  a terminal session is not a replayable skill, it is a video.
- **No always-on capture of every run**, and no retroactive reconstruction
  from `ToolCall` previews.
- **No parallel skill store, no skill marketplace, no sharing across orgs.**
- **No auto-run, no "replay raw recording" button** — replay exists only as
  an installed, validated workflow.
- **No new scheduler, approval system, audit path, or notification path** —
  workflows §10 already banned each fork and this plan inherits the bans.
- **No content-pattern triggers** for when to propose a skill — an agent's
  "I do this repeatedly" judgment (Stage C) is model-made from its own memory,
  never a frequency-counter over message strings.

## 12. Risks and defects to avoid

| # | Risk | Mitigation |
|---|---|---|
| R1 | Trace becomes a sensitive-data lake | Opt-in arming, write-time redaction, no output capture, retention + discard cascade, W0 taint at render (§4, §8) |
| R2 | Generalizer emits steps the runtime cannot execute (the `delegate`-class bug) | The exact save-time validator gates the model loop; closed vocabulary in the prompt; mock-LLM test proves the gate bites (§5, §9) |
| R3 | Restricted material laundered into an org-visible template | Fail-closed on any recorded run's `RunBasisScope`, the `todo_template_propose` precedent (§8) |
| R4 | Two recordings interleave on one surface | Partial unique index on `(agentId, threadId) WHERE status='recording'` (§3) |
| R5 | Queue redelivery double-generalizes or double-creates templates | Status CAS + idempotency key on the job; template creation inside the claiming transaction (§5) |
| R6 | Forgotten recording = ambient surveillance | TTL + step cap + a recording pill visible to everyone in the channel (§3) |
| R7 | Agent-proposed drafts spam the template list / get installed unreviewed | Pending cap + owner approval + install guard reading the written `adoptedAt` decision (§6) |
| R8 | Lossy "learn from that old run" feature ships anyway under demo pressure | §2 records the refusal and the honest alternative (re-demonstrate); product copy constraint in §0 |
| R9 | Capture hook slows or breaks runs | Non-fatal, logged, out-of-transaction insert at an already-async chokepoint (§3) |
| R10 | Fidelity oversold ("Nessie records your screen") | §0 and §11 are the copy boundary; the audit's own §7 note on Grok's unverified fidelity is the cautionary tale |
