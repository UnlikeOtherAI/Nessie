# Agent to-dos — checklists, SOPs, and runbooks per agent

**Status:** discovery + design for review — no code changes.
**Date:** 2026-08-31
**Related:** [2026-08-30-agent-scopes-personal-team-global.md](2026-08-30-agent-scopes-personal-team-global.md)
(visibility — still a proposal, see §1), [2026-08-29-people-and-their-agents.md](2026-08-29-people-and-their-agents.md)
(ownership — phases 1–2 landed), [2026-08-12-workflows-first-class.md](2026-08-12-workflows-first-class.md)
(Playbooks — the deliberately *different* thing, see §2.1),
[2026-07-06-tools-triggers-agent-designer-redesign.md](2026-07-06-tools-triggers-agent-designer-redesign.md).

## The idea

Each agent carries **to-dos**: deterministic, ordered lists of steps — the
checklists, SOPs and runbooks a human colleague would keep. Two layers:

- A **to-do template** is reusable and editable: named, ordered steps
  ("Weekly status report: 1. pull last week's messages from #launch,
  2. summarise decisions, 3. post the summary, 4. flag open questions").
  Templates can be authored by a person in the Agent Designer **or proposed by
  the agent itself** and approved/edited by a person.
- A **to-do (instance)** is one concrete occurrence — created from a template
  or standalone — with per-step status that both people and the agent tick.

Whoever can see the agent can see its to-dos. The Designer decides per agent
whether to-dos are on at all. A repetitive template plugs into the existing
trigger/scheduling system so "run this checklist every Monday" is one setting,
not a second scheduler.

The point of "deterministic": the steps live in the database as structure, are
injected into runs verbatim from that structure, and progress is recorded as
structural per-step status transitions — never re-derived from prose. What
remains model-judged is what it should be: doing the work of each step and
deciding when a step is done (the no-string-matching rule).

## 1. What exists today — verified against `main`, 2026-08-31

Four parallel code sweeps (Agent model + Designer, task/step machinery,
visibility predicates, proposal/approval patterns). The load-bearing facts,
including three stale assumptions this design must not build on:

### Landed

- **Agent ownership (stewardship) is merged.** `Agent.ownerUserId`, composite
  tenancy FK, live-membership re-derivation via `buildOwnedAgentWhere`
  (`packages/workspace-admin/src/agent-record.ts:62`), migration
  `20260829170000_agent_owner_stewardship`.
- **Agent visibility is entitlement through channels plus ownership.**
  `listAgentsForUser` (`packages/workspace-admin/src/agent-list.ts:31`) =
  bound into a channel the caller can see OR owned (live membership,
  `parentAgentId: null`); org owners additionally see unbound agents.
  `isAgentVisibleToUser` / `isAgentAccessibleToActor`
  (`packages/workspace-admin/src/access-checks.ts:54,88`) mirror it; every
  per-agent sub-resource (status, activity, messages, children, trigger
  routes) gates on `isAgentAccessibleToActor` and then re-filters *contents*
  through `buildAccessibleChannelWhere`/`ThreadWhere`.
- **The scope tabs are derived, not stored**
  (`admin/src/components/features/agents/agent-scope.ts`): PA → Personal,
  `systemManaged` → Global, else Team.
- **The Agent Designer** is `AgentDesignerContent` embedded as the Edit tab of
  `AgentDetailPage` (owner-gated via `useIsOwner()`), tabs
  `edit | activity | sub-agents | tools | messages`
  (`AgentDetailTabs.tsx:24`). Config persists through one chokepoint:
  `PUT /api/agents/:agentId` → `updateAgentRecord`
  (`api/src/services/agent-management.ts:42`), under the per-agent policy
  lock. The Tools tab (`AgentAvailableTools.tsx`) is the canonical
  "section owns one field + inline save + owner gate" pattern; a new agent
  field touches schema.prisma, `AgentRecordSchema`, `mapAgentRecord`, the
  create/update writers, the contracts, and the designer form state.
- **The trigger/scheduling system** (`AgentTrigger` types
  `manual|scheduled|webhook|event|interval`, `config Json`, `launchOrigin`
  with UOA identity, health classification + owner alerts, the sweep in
  `worker/src/control/trigger-scheduler.ts`, fire path
  `trigger-run.ts` → system kickoff message → `claimThreadRunOrPend` →
  Run+Task+enqueue). One trigger = one recurring free-text `config.prompt`.
- **`kb_publish_request` is the one working agent-proposes/human-approves
  gate** (`worker/src/run/pa-tools/knowledge-write.ts:232`): agent-authored
  draft row + an `ApprovalRequest` (`action: 'knowledge.page.publish'`,
  `requesterId = agentId`, context pins `{pageId, versionId}`, 7-day expiry,
  same-version dedupe), resolved on the `/approvals` page, effect dispatched
  by `runApprovalEffect`'s action switch
  (`api/src/services/approval-effects.ts`) with a version-staleness guard.
- **Metadata-driven chat cards** mounted in `ChannelMessageRow.tsx:326-380`
  (`runStop` → `RunStopContinue`, `workflowRun` → `WorkflowRunCard`,
  `card.comms_connect`, `documentRef`, `uiCards`): server-authored metadata,
  zod-`safeParse`d client-side, component fetches live state itself.
- **Ordered-step machinery that exists:** `WorkflowStepRun` (the Playbooks
  guarded sequence runner — `sequence` unique per run, `when:` guards,
  leases, deadlines; Stage 1 merged, Stage 2 not) and `Plan`/`PlanStep`
  (ordered + step statuses, but a delegation ledger with two hardcoded step
  types, no runner, and **no UI or consumer of its routes**).
- **`PlanStepStatus`/`WorkflowStepRunStatus`** share the vocabulary
  `pending | running | completed | failed | skipped | blocked`.

### Not landed — do not design against these

- **`Agent.visibility` (personal/team/global as a *stored* fact) is NOT
  merged.** [2026-08-30-agent-scopes-personal-team-global.md](2026-08-30-agent-scopes-personal-team-global.md)
  is a design proposal; there is no `visibility` column and no
  `buildAgentVisibilityWhere` in code. What this plan can and does rely on is
  the *predicate discipline*: gate every read through
  `isAgentAccessibleToActor` / `listAgentsForUser`, so when the visibility
  fragment lands there, to-dos inherit it with zero changes here (§4).
- **Approvals-in-chat is superseded** (its own banner says do not implement).
  There is no in-chat approval card, no `UserAlertKind.approval_requested`,
  and — critically — **no run suspend/resume**: `approval_required` denies
  the tool call and the loop continues. Nothing in this design may assume a
  run can wait for a human.
- **No to-do/checklist/SOP concept exists anywhere** — grep confirms zero
  hits as a data model in code or docs.

## 2. The model — template vs instance

### 2.1 Why new tables, and why not the two existing step models

Rule zero's fourth check says reuse before forking, so the two candidates get
an explicit verdict:

- **Playbooks (`WorkflowTemplate`/`WorkflowStepRun`) — no.** A workflow step
  is *machine-dispatched*: typed (`tool_call`, `agent_task`, `transform`),
  JMESPath-wired, installation-scoped, executed by the guarded sequence
  runner with leases and deadlines. A to-do step is *model-interpreted*:
  natural-language instructions one agent works through inside a single
  ordinary run, with deterministic **tracking** rather than deterministic
  **dispatch**. Bolting free-text steps onto the workflow engine would give
  them either fake executability or a second step type that bypasses
  everything the engine guarantees — and to-dos are per-agent,
  Designer-authored, and agent-proposable, none of which fits installations.
  The boundary is stated in §9: the day a to-do needs typed tool steps,
  branching, or cross-agent orchestration, that to-do is a Playbook, and the
  Designer should say so rather than growing a second engine.
- **`Plan`/`PlanStep` — no, but adopt its vocabulary.** A `Plan` is per-run
  delegation lineage (one plan per run, auto-created, steps appended by
  `spawn_subtask`); to-dos are durable per-agent artifacts that outlive every
  run. Overloading `PlanStep.type` would silently change what the existing
  plan reads mean. What *is* reused: the step-status enum values, the
  advisory-lock append discipline, and `sequence` uniqueness.

So: three new tables plus one agent column, deliberately small.

### 2.2 Schema

```prisma
enum AgentTodoTemplateStatus { draft  active  archived }
enum AgentTodoStatus         { open   running completed cancelled }
enum AgentTodoStepStatus     { pending running completed failed skipped }
enum AgentTodoAuthorType     { user   agent }

model AgentTodoTemplate {
  id             String  @id @default(uuid()) @db.Uuid
  organizationId String  @db.Uuid            // required — a template is tenant data
  agentId        String  @db.Uuid            // the owning agent; per-agent association
  name           String
  description    String?
  steps          Json    // ordered array, validated by AgentTodoTemplateStepsSchema
  version        Int     @default(1)         // bumped on every steps/name edit
  status         AgentTodoTemplateStatus @default(draft)
  authorType     AgentTodoAuthorType     // who authored the *current* version
  createdByUserId String? @db.Uuid          // set when a person authored/last edited
  proposedByRunId String? @db.Uuid          // set when the draft came from an agent run
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([organizationId, agentId, status])
}

model AgentTodo {
  id              String  @id @default(uuid()) @db.Uuid
  organizationId  String  @db.Uuid
  agentId         String  @db.Uuid
  templateId      String? @db.Uuid   // null = standalone to-do
  templateVersion Int?               // pinned at instantiation
  title           String
  status          AgentTodoStatus @default(open)
  createdByUserId String? @db.Uuid   // person who instantiated (null for schedule fires)
  triggerId       String? @db.Uuid   // set when a schedule instantiated it (§6)
  threadId        String? @db.Uuid   // where it is being executed, once a run starts
  activeRunId     String? @db.Uuid   // the run currently working it, if any
  completedAt     DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([organizationId, agentId, status])
}

model AgentTodoStep {
  id         String @id @default(uuid()) @db.Uuid
  todoId     String @db.Uuid
  sequence   Int                       // materialized copy of the template order
  key        String                    // stable per-template step key
  title      String
  instructions String
  status     AgentTodoStepStatus @default(pending)
  note       String?                   // short outcome note (agent- or human-written)
  updatedByActorType String?           // 'user' | 'agent'
  updatedByActorId   String? @db.Uuid
  completedAt DateTime?
  @@unique([todoId, sequence])
  @@index([todoId])
}

Agent.todosEnabled Boolean @default(false)
```

Decisions folded into that shape:

- **Template steps are one validated JSON column; instance steps are rows.**
  A template edit is one atomic write (the `WorkflowTemplate.graphJson`
  precedent), and the editor reorders an array, not rows. An instance
  needs per-step status, actor attribution and timestamps — that is row
  territory (the `PlanStep` precedent). The step schema lives in
  `packages/schemas/src/agent-todos.ts` (`{ key, title, instructions }`,
  ≥1 step, bounded count and lengths) so API validation, the worker's prompt
  assembly, and the admin editor share one contract — the
  `EMBEDDING_DIMENSIONS` "state it once" discipline.
- **Instances pin the template version and copy the steps.** Editing a
  template never mutates in-flight work (the `WorkflowRun.graphSnapshot`
  rule). `templateVersion` + the copied rows are the provenance; the
  approval flow (§5) uses the same version pinning for staleness.
- **`AgentTodoStepStatus` drops `blocked`** from the shared vocabulary —
  nothing in v1 can block a step (no dependencies, no leases). Adding a value
  later is additive; carrying a dead state from day one is not.
- **`title` on the instance, not just the template**, because standalone
  to-dos have no template to name them.
- **No `assigneeUserId`.** A to-do belongs to the agent. Work distribution to
  people is the existing Task/kanban system; see §9 for the deliberate
  non-link.

### 2.3 Determinism guarantees, stated as invariants

1. Steps enter a run's context **verbatim from `AgentTodoStep` rows**,
   server-rendered in `sequence` order — never from the model's memory of the
   template and never re-parsed from chat.
2. Progress is only ever a structural transition on an `AgentTodoStep` row,
   written by the `todo_step_update` builtin (agent) or the tick endpoint
   (human), both recording actor + timestamp. No code path infers a step's
   status from message content.
3. Instance completion is derived: `completed` when every step is terminal
   (`completed | skipped | failed`), computed in the same transaction as the
   final step write — the `computePlanTerminalStatus` shape. A run ending
   with steps still `pending` leaves the to-do honestly `open` (or `running`
   → back to `open` when `activeRunId` clears); nothing auto-ticks.

## 3. Executing vs tracking

A to-do is **tracked** by default and **executed** when a run picks it up.
Execution is an ordinary agentic run — no new runner, no suspension:

- **From chat (the main path).** When `todosEnabled` and the run's toolset
  includes the to-do tools, the prompt gains one structural block listing the
  agent's *active template names + ids* and *open instances* (facts from the
  toolset/DB, never message content — the research-routing-block precedent).
  The model, asked "do the weekly report", calls **`todo_start`**
  (instantiate from template, or adopt an existing open instance) and gets
  the full steps back verbatim; it works through them calling
  **`todo_step_update`** (`{todoId, stepKey, status, note?}`) as it goes.
  Whether the request *means* "run your checklist" is the model's judgement;
  what the checklist *says* is the database's.
- **From the To-dos tab ("Run now").** The instance needs a thread. The
  caller picks a target channel the agent is bound to and the caller is a
  member of (exactly `schedule_task`'s cross-channel constraint); the server
  posts a system kickoff message naming the to-do and creates Run + Task via
  `claimThreadRunOrPend` — the `trigger-run.ts` fire shape, in a small shared
  `todo-run` service beside it. The kickoff prompt is server-authored from
  the pinned steps.
- **From a schedule** — §6.
- **Manual tracking.** Humans tick steps from the To-dos tab (and the chat
  card): `POST .../steps/:stepId` with a status + optional note, actor
  recorded. A person and the agent can share one checklist — the agent does
  steps 1–3, a person signs off step 4.

Run integration details:

- `AgentTodo.activeRunId` is claimed with a conditional update when a run
  adopts a to-do (one run per to-do at a time; a second `todo_start` on the
  same instance refuses in words) and cleared at the run's terminal
  transition — fused into `updateRunStatus` exactly like the 👀
  working-marker, so completion, failure, budget stop, and cancellation all
  release it without remembering to.
- The to-do tools are **builtins gated by `Agent.todosEnabled`**, checked
  structurally at toolset assembly (like `surfacePolicy`), not new
  `requiresExplicitGrant` keys — this is an owner-configured feature of the
  agent, not a privileged capability. They are not PA-only: any agent with
  to-dos enabled works its own list; `agentId` always comes from the run
  context, never from arguments, so an agent can never touch another agent's
  to-dos.
- **Chat surface (rule zero doorway):** when a run starts a to-do, the
  server stamps `metadata.todoRef = { todoId }` on the kickoff/reply message;
  a `TodoProgressCard` in `ChannelMessageRow` (the `runStop`/`workflowRun`
  precedent — zod-parsed, self-gating) fetches live instance state through
  the gated API and renders the checklist with per-step status, updating on
  a realtime `agent.todo.updated` event (id-only payload, the
  `agent.updated` precedent — clients refetch through the entitled route).
- **Disclosure analysis (obligation stated in the same change):** to-do
  content needs no `ConsumedSourceSink` scope because its audience is
  structurally a superset of every reply destination — a to-do is readable by
  whoever can see the agent; a run's reply lands in a channel the agent is
  bound to; every member of that channel can see the agent and therefore the
  to-do. For a future private agent the same holds degenerately (replies land
  in the owner-only DM). If a later change ever lets a to-do embed content
  from a scoped source (e.g. a step generated from a private thread), that
  change owns feeding the sink.

## 4. Visibility and permissions

**Reads: whoever can see the agent sees its to-dos** — by construction, not
by a parallel rule. Every to-do route is a per-agent sub-resource under
`/api/agents/:agentId/todos*` and takes the exact two-layer gate the
status/activity routes take:

1. `isAgentAccessibleToActor(agentId)` → 404 `AGENT_NOT_FOUND` otherwise.
   This single choice is what makes the leakage story future-proof: when the
   agent-scopes proposal lands its visibility fragment inside
   `isAgentVisibleToUser`/`isAgentAccessibleToActor`, a private agent's
   to-dos vanish from every non-owner **with zero to-do code changes**. This
   plan adds one row to that doc's read-path gating table ("to-do routes —
   inherit via the mirror pair") in the same change that builds phase 1, so
   the obligation is recorded where future reviewers look.
2. Run/thread linkage is re-filtered: `AgentTodo.threadId`/`activeRunId`
   render as links only when the viewer passes `buildAccessibleThreadWhere` —
   seeing the checklist does not grant reading the room it ran in.

**Writes**, each mirroring an existing gate rather than inventing one:

| Action | Gate | Mirrors |
|---|---|---|
| Enable/disable to-dos; create/edit/archive templates | org owner (v1) | `PUT /api/agents/:agentId` — `requireOwner` after the visibility gate; templates are agent *configuration* |
| Approve/reject an agent-proposed template | `POST /api/approvals/:id/resolve` semantics: live role, no self-approval, atomic claim | the `kb_publish_request` gate |
| Instantiate + Run now | any active member who passes the agent gate, target channel bound + member | messaging the agent / `schedule_task` targeting |
| Tick a step manually | instance creator, org owner, or the agent's steward | task-board permissiveness; humans drag cards backwards |
| Agent writes (`todo_start`, `todo_step_update`, `todo_template_propose`) | run context only — own `agentId`, own org/team | `deep_water_run_update`'s tenancy-from-run-context rule |

Template editing should eventually open to the agent's **steward**
(`ownerUserId`), but people-and-their-agents phase 3 is explicitly blocked on
that entitlement decision — so v1 matches the Designer's actual gate (org
owner) and widens with the Designer when that decision lands, not before.
Service functions live in `@nessie/workspace-admin` (`agent-todos.ts`) so the
API routes and the worker's builtins call the same code — the provisioning
mirror rule, stated before any tool ships.

## 5. The agent-recommends flow

The agent can propose both **that** a to-do should exist and **what its steps
should be** — following `kb_publish_request` piece for piece:

1. **Propose.** A new builtin `todo_template_propose`
   (`{name, description?, steps: [{title, instructions}]}`; `safe: false`,
   available to any agent with to-dos enabled) validates the steps against
   the shared schema, assigns stable keys, and writes an
   `AgentTodoTemplate` at `status: draft`, `authorType: agent`,
   `proposedByRunId` set. It then creates an `ApprovalRequest`
   (`action: 'agent.todo_template.publish'`, `requesterId = agentId`,
   `context: {templateId, version}`, 7-day expiry, same-version dedupe scan)
   and returns "proposed — pending review". *Whether* to propose is
   model-judged (noticing "I do this every week" in any language); the
   proposal itself is this one structural act. The run does not wait —
   there is no suspend/resume, and the proposal doesn't need one.
2. **Review.** The draft renders in the Designer's To-dos tab with a
   "proposed by the agent" badge and on the existing `/approvals` page
   (context-narrowed card + deep link into the To-dos tab, the
   `knowledge.page.publish` rendering shape).
3. **Approve** → a new `runApprovalEffect` case with a zod context schema and
   the staleness guard: if `template.version !== context.version` the effect
   returns "draft superseded — re-review", else flips the template
   `draft → active` and emits `agent.todo_template.published` audit.
4. **Edit-before-approve is a first-class path, not a workaround.** Unlike
   the KB flow (where a human edit forces a re-request), a person editing a
   draft template in the Designer *takes authorship*: the save bumps
   `version`, sets `authorType: user`, and may activate directly — human
   authorship needs no review, which is already the rule for
   Designer-authored templates. The dangling approval then dies naturally on
   its staleness guard (resolved as "superseded", never silently).
5. **Rejection** resolves the approval and archives the draft; the agent
   learns the outcome the honest way — the template list it sees next run no
   longer contains a pending proposal — and the anti-nag rule is the dedupe
   scan: one pending approval per (template, version), ever.

## 6. Scheduling — repetitive templates ride the existing triggers

No second scheduler (the Playbooks plan's own hard rule). A recurring to-do
is an `AgentTrigger` whose config carries `todoTemplateId`:

- The Designer's template editor offers "Repeat on a schedule", which creates
  a `scheduled`/`interval` trigger through the existing
  `createAgentTrigger` path — owner-gated, `launchOrigin` captured, and on a
  signing deployment refused without UOA identity, exactly as today.
  Everything the trigger system owns comes free: the sweep, overlap skips,
  delivery retries, **health classification and the owner alert when the
  schedule dies**, and explicit reauthorization.
- At fire time, `trigger-run.ts` sees `config.todoTemplateId`, instantiates
  an `AgentTodo` pinned to the template's current version, and builds the
  kickoff prompt from the materialized steps instead of `config.prompt`. Each
  fire is a fresh instance (a Monday checklist half-done on Tuesday stays
  visible as its own honest record; next Monday starts clean — rollover is an
  open question, §10).
- A template referenced by an enabled trigger cannot be archived, and
  `todosEnabled` cannot be switched off, until those triggers are paused or
  deleted — a reason-coded 409 (`TODO_TEMPLATE_IN_USE` /
  `AGENT_TODOS_IN_USE`), the `LEDGER_DEEPWATER_ACTIVE_RUNS` precedent, so a
  schedule never fires into a feature that no longer exists.

## 7. The Agent Designer / edit-agent interface

- **The per-agent switch.** `Agent.todosEnabled` renders in the Designer form
  (`AgentDesignerForm`) as a `Switch` beside Run limits, persisted through
  the one `PUT /api/agents/:agentId` chokepoint like every other config
  field (the five-places checklist from the code sweep: schema,
  `AgentRecordSchema`, `mapAgentRecord`, create/update writers, contracts,
  plus form state and mutation types). Disabling hides the tools from
  toolset assembly and the authoring UI; templates and history are retained
  dormant (the trigger `enabled: false` semantics), guarded by the §6 409
  when schedules still reference them.
- **A "To-dos" tab** joins `AgentDetailTabs`
  (`edit | activity | sub-agents | tools | messages | to-dos`) — the owning
  surface (rule zero check 1). It is one component with two sections:
  - **Templates** (owner-editable, read-only for everyone else — the
    `AgentToolsEditor`/`AgentToolsReadOnly` split): list with status pills
    (draft/proposed/active/archived), an editor for name + description +
    ordered steps (add / remove / reorder / edit title + instructions),
    "Repeat on a schedule", archive. Proposed drafts carry the badge and
    Approve/Reject inline (calling the same resolve endpoint as
    `/approvals`).
  - **To-dos** (instances): open and recent, each a checklist with per-step
    status, actor, notes; manual ticking; "Run now" with the target-channel
    picker; link to the executing thread when visible.
- **In-context doorways** (rule zero check 1, the second half): the
  `TodoProgressCard` in chat wherever a to-do is being worked (§3); the
  existing `/approvals` page rows for pending proposals; and the agent's own
  offer in conversation ("I have a checklist for that — want me to run it?"),
  which the structural prompt block makes possible.
- Non-owners see everything read-only — visible-and-refuses-in-words, the
  `connector_*` precedent, rather than a hidden tab.

## 8. New vs reused

| Need | New | Reused |
|---|---|---|
| Data model | `AgentTodoTemplate` + `AgentTodo` + `AgentTodoStep`, `Agent.todosEnabled`, step schema in `@nessie/schemas` | step-status vocabulary + `sequence` uniqueness (`PlanStep`/`WorkflowStepRun`), version-pinning discipline (`WorkflowRun.graphSnapshot`) |
| Visibility | nothing — routes compose the existing gates | `isAgentAccessibleToActor` mirror pair, `buildAccessibleThreadWhere` for run links; future `Agent.visibility` inherits free |
| Authoring service | `agent-todos.ts` in `@nessie/workspace-admin` | the shared-package pattern; API routes + worker tools call one implementation |
| Execution | `todo_start`, `todo_step_update` builtins; small `todo-run` kickoff service; `activeRunId` claim/release | agentic run loop, `claimThreadRunOrPend`, `trigger-run.ts` fire shape, run terminal-status fusion (👀-marker precedent), toolset structural gating |
| Agent proposals | `todo_template_propose` builtin; one `runApprovalEffect` case | `ApprovalRequest` + resolve semantics, version-pin staleness guard, dedupe, `/approvals` page, audit |
| Scheduling | `config.todoTemplateId` branch in the fire path; 409 in-use guards | the whole trigger system: sweep, launchOrigin/UOA identity, health + alerts, reauthorize |
| Designer UI | To-dos tab + step editor + progress card + `metadata.todoRef` | `AgentDetailTabs`, `TabBar`, `Switch`, Tools-tab edit/read-only split, `ChannelMessageRow` card mount, id-only realtime + gated refetch |

**Deliberately not built:** a second step *engine* (typed steps, guards,
branching stay in Playbooks), per-step tool bindings, step dependencies or
`blocked`, run suspension awaiting a human step, to-do assignment to people,
a standalone org-wide to-dos page, PA tools for managing *other* agents'
to-dos, and any mirroring of instances onto the kanban board.

## 9. Boundaries with neighbours

- **Playbooks:** a to-do is what a *person or agent reads and works through*;
  a Playbook is what the *engine executes*. If a template accretes needs for
  typed tool calls, conditionals, or multi-agent handoffs, the answer is
  "make it a Playbook", and the Designer's template editor should link to the
  workflow designer rather than grow those features. Revisit only if real
  usage shows the two converging (§10.5).
- **Task/kanban:** `Task` rows remain the per-run work ledger and the human
  board. A to-do instance deliberately does not create board cards — one
  thing in two places would need the one-component rule, and nothing yet
  names the decision a board mirror would drive.
- **Memory/knowledge:** a template is configuration, not knowledge — it lives
  with the agent, not in a KB space, so its visibility is the agent's and not
  a space ACL. An agent may of course *reference* KB docs inside step
  instructions; those reads happen at execution time through the normal tools
  and feed the disclosure sink as usual.

## 10. Phased path

Each phase lands with its surface, docs updated in the same turn, additive
migrations only.

1. **Templates + tracked instances (no execution).** Schema + step contract,
   `agent-todos.ts` service, routes with the two-layer gate, `todosEnabled`
   in the Designer, the To-dos tab with template editor and manual
   checklists. Add the read-path row to the agent-scopes doc. Immediately
   useful: humans author SOPs and tick them.
2. **Execution.** `todo_start` + `todo_step_update`, the structural prompt
   block, `activeRunId` claim + terminal release, "Run now" kickoff,
   `metadata.todoRef` + `TodoProgressCard`, `agent.todo.updated` realtime.
3. **Agent proposals.** `todo_template_propose`, the approval action +
   effect + staleness guard, proposed-badge review UI, edit-takes-authorship
   save path.
4. **Scheduling.** `config.todoTemplateId` in the fire path, "Repeat on a
   schedule" in the template editor, the in-use 409 guards.

Phase 1 is independently shippable; 2–4 are independent of each other once 1
exists (3 and 4 can swap if proposals are wanted sooner).

## 11. Open questions (flagged, not guessed)

1. **Instance-creation floor.** v1 says any member who can see the agent may
   instantiate and Run (they could ask the agent in chat anyway). Should
   Run-now be narrower than instantiate-for-tracking?
2. **Steward editing rights.** Template editing widens from org owner to
   `ownerUserId` when people-and-their-agents phase 3's entitlement decision
   lands. Confirm to-dos ride that decision rather than pre-empting it.
3. **Scheduled-instance rollover.** Each fire creates a fresh instance;
   should an unfinished previous instance auto-cancel, roll its unfinished
   steps forward, or just accumulate as honest history (current design)?
   Decide after real use; accumulation is the no-magic default.
4. **Failed steps.** A step the agent marks `failed` leaves the to-do open.
   Should a failure raise anything (a mention-style alert to the
   instantiator?), or is the progress card + unread state enough in v1?
5. **Convergence with Playbooks.** If Stage 2 of workflows lands
   `invoke_workflow`, a to-do step saying "run Playbook X" becomes natural.
   That is the sanctioned crossing point — a step that *references* a
   Playbook — and should be designed then, not now.
6. **Proposal breadth.** Should the agent also be able to propose *edits* to
   an existing active template (a step diff), or only new templates in v1?
   Proposed: new-only; an edit proposal reuses the same draft+approval shape
   later.
7. **`AgentTodoStatus.cancelled` semantics** — who may cancel an open
   instance (creator + owner proposed), and does cancelling a running one
   also cancel its run (proposed: no — it just releases `activeRunId` at the
   run's own terminal state; run cancellation stays on the run controls).
