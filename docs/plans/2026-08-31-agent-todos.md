# Agent to-dos — checklists, SOPs, and runbooks per agent

**Status:** implementation in progress — all open questions decided 2026-08-31
(§11). The data contract, shared service, REST surface, and Phase 1 Designer
and To-dos surfaces have landed. Phase 2 is complete: its execution builtins,
bounded prompt facts, liveness discipline, Run-now path, progress card, and
id-only realtime invalidation have landed. Phase 3's agent proposal and
owner-review flow is complete; Phase 4 scheduling remains.
**Date:** 2026-08-31
**Reviewed:** two independent adversarial reviews on the same repo — kimix
(17 findings) and Codex Sol (18 findings, on the doc with kimix's round
already folded). Every adopted claim was re-verified against code first;
adjudications in §"Cross-model review".
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
- **Metadata-driven chat cards** mounted in
  `admin/src/components/features/channels/ChannelMessageRow.tsx`
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
enum AgentTodoActorType      { user   agent }   // template authorship AND step updates

model AgentTodoTemplate {
  id             String  @id @default(uuid()) @db.Uuid
  organizationId String  @db.Uuid            // required — a template is tenant data
  agentId        String  @db.Uuid            // the owning agent; per-agent association
  name           String
  description    String?
  steps          Json    // ordered array, validated by AgentTodoTemplateStepsSchema
  version        Int     @default(1)         // bumped on every steps/name edit
  status         AgentTodoTemplateStatus @default(draft)
  authorType     AgentTodoActorType      // who authored the *current* version
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
  updatedByActorType AgentTodoActorType?  // enum, not free text — the actor fact is structural
  updatedByActorId   String? @db.Uuid
  completedAt DateTime?
  @@unique([todoId, sequence])
  @@unique([todoId, key])     // todo_step_update addresses steps by key
  @@index([todoId])
}

Agent.todosEnabled Boolean @default(false)
```

The sketch shows the shape; the real schema is written with **relations and
storage-level tenancy, not bare scalar ids**: `agentId` is a real FK whose
agent must share `organizationId` (derive the org through the agent or add
the composite-FK pattern `Agent.ownerUserId` uses), `AgentTodoStep` cascades
with its `AgentTodo`, `templateId` is `onDelete: Restrict` — templates are
archived, never hard-deleted in v1, so provenance cannot dangle — and
`triggerId`/`threadId`/`activeRunId` are `SetNull`. The step `key` is unique
per template in the shared zod refinement **and** per instance in the DB,
because `todo_step_update` addresses by key and a duplicate would make the
write ambiguous.

Decisions folded into that shape:

- **Template steps are one validated JSON column; instance steps are rows.**
  A template edit is one atomic write (the `WorkflowTemplate.graphJson`
  precedent), and the editor reorders an array, not rows. An instance
  needs per-step status, actor attribution and timestamps — that is row
  territory (the `PlanStep` precedent). The step schema lives in
  `packages/schemas/src/agent-todos.ts` (`{ key, title, instructions }`,
  1–50 steps, title ≤ 200 / instructions ≤ 2,000 chars — §11 pins every
  bound) so API validation, the worker's prompt
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
- **No `assigneeUserId`, and no per-step `assigneeAgentId`** (which
  `PlanStep` has and a reviewer will ask about): a to-do belongs to one
  agent. If working a step calls for help, the run uses `delegate` /
  `spawn_subtask` exactly as in any other run — delegation is run machinery,
  not to-do structure, and putting an agent id on a step would be the first
  brick of a second orchestration engine (§9). Work distribution to people
  is the existing Task/kanban system; see §9 for the deliberate non-link.
- **`cancelled` is designed, not parked** (unlike `blocked`, which is
  dropped): the instance creator, an org owner, or the agent's steward may
  cancel an `open` or `running` instance. Cancelling never touches a run —
  the run keeps its own controls; its next `todo_step_update` simply refuses
  in words ("this to-do was cancelled") because the ownership check below
  reads live state, and
  `activeRunId` liveness is derived (§3), so nothing dangles.
- **System-managed agents are out of scope in v1.** The API-side exclusion
  is `isAgentAccessibleToActor`'s hard-coded `systemManaged: false` (the PA
  update refusal fires only on reserved identity/surface inputs, so it is
  *not* the guard here); `updateAgentRecord`'s system-managed preservation
  branch must therefore cover `todosEnabled` explicitly, the same way it
  pins `name`/`ownerUserId` for system rows. Every to-do route and card
  then fails closed for system agents by construction. If the PA ever wants
  to-dos, that is a bootstrap decision plus a read-path decision, taken
  deliberately then.

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
   final step write, and **every step write serializes on
   `pg_advisory_xact_lock(todoId)`** — a bare "same transaction" is not
   race-free (two writers finishing the last two steps can each still see
   the other's step pending; the `plans.ts` count-before-write has exactly
   this weakness, so the lock discipline is adopted, not just the shape). A
   to-do whose steps all terminated with some `failed` **is `completed`,
   with the failures visible** on the card and in the rows — holding it open
   forever would be the dishonest state; whether a failure additionally
   *alerts* anyone is decided in §11.4 (no new alert kind in v1). A run ending with steps still
   `pending` leaves the to-do honestly `open` (or `running` → back to `open`
   when `activeRunId` clears); nothing auto-ticks.
4. Step transitions are guarded, not last-writer-wins: an agent write is a
   conditional update that refuses to overwrite a **human-set terminal
   status** (a person's sign-off or skip stands; the agent's refusal names
   who set it), while a human write may always correct anything — the
   task-board permissiveness, one direction only.

## 3. Executing vs tracking

A to-do is **tracked** by default and **executed** when a run picks it up.
Execution is an ordinary agentic run — no new runner, no suspension:

- **From chat (the main path).** When `todosEnabled` and the run's toolset
  includes the to-do tools, the prompt gains one structural block listing the
  agent's *active templates*, *open instances*, and *its own pending or
  rejected proposal drafts* — names, ids and statuses only, **bounded**
  (newest-first caps with an honest "and N more" line, per the no-silent-caps
  rule), because any member can instantiate and scheduled instances
  accumulate, and an unbounded block would eventually crowd out the
  conversation. Facts from the toolset/DB, never message content — the
  research-routing-block precedent. The model, asked "do the weekly report",
  calls **`todo_start`** (instantiate from template, or adopt an existing
  open instance) and gets the full steps back verbatim; it works through
  them calling **`todo_step_update`** (`{todoId, stepKey, status, note?}`)
  as it goes. Whether the request *means* "run your checklist" is the
  model's judgement; what the checklist *says* is the database's.
  **One active to-do per run**: `todo_start` refuses while the run already
  holds one, matching the singular `metadata.todoRef` contract — a run that
  wants a second checklist finishes the first or leaves it for the next run.
- **From the To-dos tab ("Run now").** The instance needs a thread. The
  caller picks a target channel the agent is bound to and the caller is a
  member of — **deliberately stricter than `schedule_task`**, which accepts
  any visible public channel (`worker/src/run/schedule-tools.ts`
  `visibleChannelWhere`): clicking Run posts into the room *now*, and
  posting into a public room you never joined is not a thing the UI should
  make one click. The server posts a kickoff and creates Run + Task via
  `claimThreadRunOrPend` — the `trigger-run.ts` fire shape. The to-do fire
  preparation lives in `@nessie/workspace-admin` (`agent-todos.ts`), because
  **two fire paths exist and both must use it**: the worker's
  `trigger-run.ts` *and* the API's manual-fire `dispatchAgentTrigger`
  (`api/src/services/trigger-dispatch.ts`), which builds its prompt
  independently today — covering only the worker path would make "Fire now"
  on a to-do schedule silently run without its checklist. The kickoff
  prompt is server-authored from the pinned steps.
- **From a schedule** — §6.
- **Manual tracking.** Humans tick steps from the To-dos tab (and the chat
  card): `POST .../steps/:stepId` with a status + optional note, actor
  recorded. A person and the agent can share one checklist — the agent does
  steps 1–3, a person signs off step 4.

Run integration details:

- `AgentTodo.activeRunId` is claimed with a conditional update (claim
  succeeds → steps are returned; the loser of the race gets a refusal in
  words and **never receives the step list**), and only ever from *inside an
  executing run* — `todo_start`, or the kickoff adoption at run start — never
  at enqueue time, so a run cancelled while still `pending` cannot have
  claimed anything. Release is fused into the worker's `updateRunStatus`
  (the 👀 working-marker precedent) **but that is not sufficient on its
  own**: the API's immediate-cancel branch flips a `pending`/
  `waiting_approval` run terminal with a bare `updateMany`
  (`api/src/services/runs.ts` `requestRunCancellation`) and sweep/reaper
  paths terminalize stuck runs outside the loop, none of which pass through
  `updateRunStatus`. So the release is belt-and-braces: **every reader
  derives liveness** as `activeRunId` set AND the referenced run non-terminal
  (one JOIN), and `todo_start`'s conditional claim treats a stale pointer to
  a terminal run as unclaimed. A dangling id is then harmless by
  construction rather than by every terminal writer remembering.
- **Agent step writes are ownership-checked:** `todo_step_update` requires
  `context.run.id === activeRunId` (live, per the derivation above) and
  refuses in words otherwise — the run that lost a claim race, or whose
  to-do was cancelled under it, cannot write last-writer-wins updates.
  Human ticks are exempt (a shared checklist is the point). And because a
  person may tick steps while a run is mid-flight, `todo_step_update`'s
  `outputPreview` always returns the **current full checklist state**, so
  the agent's view refreshes on every write instead of freezing at
  `todo_start`.
- The to-do tools are **builtins gated by `Agent.todosEnabled`**, checked
  structurally at toolset assembly (like `surfacePolicy`), not new
  `requiresExplicitGrant` keys — this is an owner-configured feature of the
  agent, not a privileged capability. They are not PA-only: any agent with
  to-dos enabled works its own list; `agentId` always comes from the run
  context, never from arguments, so an agent can never touch another agent's
  to-dos.
- **Chat surface (rule zero doorway):** when a run starts a to-do, the
  worker's message chokepoint stamps `metadata.todoRef = { todoId }` on the
  agent's **assistant reply** — never on the trigger-style kickoff, which is
  `role: 'system'` and deliberately excluded from the feed
  (`worker/src/control/trigger-run.ts:347`), where a card would be
  invisible. A `TodoProgressCard` in `ChannelMessageRow` (the
  `runStop`/`workflowRun` precedent — zod-parsed, self-gating) carries
  **only the id in metadata** and fetches all content through the gated API,
  so a viewer who fails the agent gate gets a 404 and the card renders a
  neutral placeholder — it fails closed, never leaking step content to a
  channel-mate the agent predicates would withhold it from. Live updates via
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
| Tick a step manually; cancel an instance | instance creator, org owner, or the agent's steward | task-board permissiveness; humans drag cards backwards |
| Agent writes (`todo_start`, `todo_step_update`, `todo_template_propose`) | run context only — own `agentId`, own org/team | `deep_water_run_update`'s tenancy-from-run-context rule |

**Templates are configuration that is deliberately readable wider than
`systemPrompt`** — worth stating because it looks inconsistent until the
product rule is named. The Designer's edit tab is owner-gated because a
system prompt is the agent's private wiring; a to-do is the opposite: the
whole point of an SOP is that colleagues can see what the agent's checklist
says and watch it being worked (the progress card renders the steps to the
room regardless). "Whoever can see the agent sees its to-dos" is the product
spec, applied to read; *writing* stays owner-gated. Consequence, stated in
the Designer's copy: step instructions are visible to everyone who can see
the agent — never put secrets in them (secrets belong in connectors and the
encrypted store, as everywhere else).

Template editing should eventually open to the agent's **steward**
(`ownerUserId`), but people-and-their-agents phase 3 is explicitly blocked on
that entitlement decision — so v1 matches the Designer's actual gate (org
owner) and widens with the Designer when that decision lands, not before.
Service functions live in `@nessie/workspace-admin` (`agent-todos.ts`) so the
API routes and the worker's builtins call the same code — the provisioning
mirror rule, stated before any tool ships.

**Template saves are version-pinned.** The editor sends the `version` returned
with the template; the update is conditional on that version and a stale save
refuses with `AGENT_TODO_TEMPLATE_CHANGED` rather than replacing a newer edit.

## 5. The agent-recommends flow

The agent can propose both **that** a to-do should exist and **what its steps
should be** — following `kb_publish_request` piece for piece:

1. **Propose.** A new builtin `todo_template_propose`
   (`{name, description?, steps: [{title, instructions}]}`; `safe: false`,
   available to any agent with to-dos enabled) validates the steps against
   the shared schema, assigns stable keys, and writes an
   `AgentTodoTemplate` at `status: draft`, `authorType: agent`,
   `proposedByRunId` set, **plus its `ApprovalRequest` in one transaction**
   (`action: 'agent.todo_template.publish'`, `requesterId = agentId`,
   `context: {templateId, version}`, 7-day expiry)
   and returns "proposed — pending review".
   Two guards the KB precedent does not have:
   - **Disclosure fails closed.** A draft is readable by everyone who can
     see the agent *before* any human reviews it, so a proposal minted from
     a run that consumed restricted sources would launder that content past
     the basis system (approval gates activation, not draft visibility).
     v1 rule: the tool **refuses when the run's `ConsumedSourceSink` holds
     any scoped source**, in words ("this conversation drew on restricted
     material — a person should author this template, or ask me again in a
     clean conversation"). Over-restrictive by design, the search-fails-
     closed posture; refine later if it bites.
   - **A structural proposal cap** — at most 10 pending agent proposals per
     agent (`NESSIE_MAX_PENDING_TODO_PROPOSALS`; the `MAX_ACTIVE_SCHEDULES`
     precedent), refused in words
     beyond it. Same-draft dedupe alone cannot stop *equivalent* re-proposals
     (each call mints a fresh template id); the cap bounds the blast radius
     structurally, and the prompt block's pending/rejected-drafts facts (§3)
     give the model what it needs to not re-propose semantically — which
     stays its judgement, per the no-string-matching rule. *Whether* to propose is
   model-judged (noticing "I do this every week" in any language); the
   proposal itself is this one structural act. The run does not wait —
   there is no suspend/resume, and the proposal doesn't need one.
   **The approval sets `requiredApproverRole: 'owner'`** — a divergence from
   the kb precedent, which sets no role, so there any member passing
   `approvalVisibilityWhere` can resolve
   (`api/src/services/approvals.ts:188` checks the live role *only when the
   field is set*). Activating a template is the same act as authoring one,
   and authoring is owner-gated (§4); without the role the approval route
   would be a member-level side door into an owner-only write. This is also
   what finally gives the dangling `requiredApproverRole` hook a production
   writer.
2. **Review.** The draft renders in the Designer's To-dos tab with a
   "proposed by the agent" badge and on the existing `/approvals` page
   (context-narrowed card + deep link into the To-dos tab, the
   `knowledge.page.publish` rendering shape).
3. **Approve** → a new `runApprovalEffect` case with a zod context schema.
   The staleness guard is **not** read-then-flip (a TOCTOU window would let
   a concurrent edit activate an unreviewed version): activation is one
   atomic conditional update on `{id, version: context.version,
   status: 'draft'}` → `active`, and zero rows updated means "superseded or
   already handled", reported in the resolution note. The effect runs after
   the approval's atomic claim and its failure never un-approves (existing
   architecture, `api/src/services/approvals.ts:247-273`); the crash window
   between claim and effect is recoverable without new machinery because an
   **owner can always activate a draft directly** in the Designer — the
   human-authorship rule doubles as the retry path. Emits
   `agent.todo_template.published` audit.
4. **Edit-before-approve is a first-class path, not a workaround.** Unlike
   the KB flow (where a human edit forces a re-request), a person editing a
   draft template in the Designer *takes authorship*: the save bumps
   `version`, sets `authorType: user`, and may activate directly — human
   authorship needs no review, which is already the rule for
   Designer-authored templates. The dangling approval then dies naturally on
   its staleness guard (resolved as "superseded", never silently).
5. **Rejection** resolves the approval and nothing else — deliberately,
   because `resolveApprovalRequest` invokes effects **only on approve**
   (`approvals.ts:247`), and wiring a rejection side effect would be new
   architecture for no need. The draft stays `draft`, rendered with a
   "rejected" state (derived from its linked approval) in the Designer,
   where the owner reworks, activates, or archives it. The agent learns the
   outcome structurally: the §3 prompt block lists its drafts *with
   status*, so a rejected proposal is a visible fact, not a silent
   disappearance.

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
- **`config.todoTemplateId` gets a named validation chokepoint, because the
  generic config path deliberately is not one.** `AgentTrigger.config` is an
  open `Record<string, unknown>` and `stripServerOwnedTriggerConfig`
  (`packages/workspace-admin/src/trigger-config-identity.ts`) strips only
  the three identity keys — any client can already write arbitrary keys
  through `POST /api/triggers`. So the shared trigger create/update path
  (`trigger-create.ts`) grows one validation: when `todoTemplateId` is
  present, the template must exist, belong to **this trigger's agent**, and
  be `active`, else the write is refused in words. The validation also
  requires **`Agent.todosEnabled`** (a dormant template must not be
  schedulable through the generic trigger API), and trigger create/update
  serializes with the archive/disable 409 guards under one advisory lock on
  the agent — the reference is JSON, not an FK, so without the lock a trigger
  write and an archive race past each other. The fire path re-validates, and
  a missing/archived/feature-disabled template is a **new classified health
  transition, not a free one**: today `queueTriggerRun` records health only
  for `TriggerLaunchOriginError` (`trigger-run.ts:467-471`), so an ordinary
  lookup error would just become a retryable failed delivery and grind
  forever. A config-invalid reason (non-reauthorizable → `status: 'error'`,
  `health_detail` naming the template, exactly-once alert via
  `health_revision`) is part of this phase — the "schedule that stops says
  so" rule, paid for rather than assumed. **This shared fire preparation
  lives in `@nessie/workspace-admin` and is used by BOTH fire paths** — the
  worker's `trigger-run.ts` *and* the API's manual-fire
  `dispatchAgentTrigger` (`api/src/services/trigger-dispatch.ts`), which
  builds its prompt independently today; covering only the worker path would
  make "Fire now" on a to-do schedule silently run without its checklist.
- **Instantiation happens at run adoption, not at fire.** The fire path
  shares `claimThreadRunOrPend` with chat: a busy `(agent, thread)` slot
  pends the fire, several pends can drain into **one** run, and a to-do
  minted eagerly per fire would accumulate instances no run ever adopts. So
  the fire carries `todoTemplateId` through the pending-message provenance
  (`RunThreadPendingMessage` already replays trigger provenance), and the
  run that actually starts materializes the instance — one per distinct
  template among the deliveries it drained, pinned to the template's
  then-current version, kickoff prompt built from the materialized steps
  instead of `config.prompt`. Coalesced same-template fires become one
  instance, honestly (running the same checklist twice back-to-back is
  noise, and the delivery rows still record every fire). Uncoalesced fires
  are each a fresh instance — a Monday checklist half-done on Tuesday stays
  visible as its own honest record; next Monday starts clean — no rollover,
  no auto-cancel; the kickoff names still-open same-template instances as
  structural facts and adoption stays the model's call (§11.3).
- A template cannot be archived, and `todosEnabled` cannot be switched off,
  while any referencing trigger has **`enabled: true`** — the exact
  predicate, not "active": an `enabled` trigger in `needs_reauthorization`
  is one repair click from firing again, so it still counts; a
  `enabled: false` (paused/cancelled) one does not. Reason-coded 409
  (`TODO_TEMPLATE_IN_USE` / `AGENT_TODOS_IN_USE`), the
  `LEDGER_DEEPWATER_ACTIVE_RUNS` precedent, so a schedule never fires into a
  feature that no longer exists.

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
- Non-owners see the tab too, with exactly the §4 entitlements — **templates
  read-only** (visible-and-refuses-in-words on the edit affordances, the
  `connector_*` precedent, never a hidden tab), but the **instance actions
  they are entitled to stay live**: instantiate, Run now, and ticking per
  the §4 table. A member allowed to do something the tab hides would be the
  rule-zero defect in miniature.

## 8. New vs reused

| Need | New | Reused |
|---|---|---|
| Data model | `AgentTodoTemplate` + `AgentTodo` + `AgentTodoStep`, `Agent.todosEnabled`, step schema in `@nessie/schemas` | step-status vocabulary + `sequence` uniqueness (`PlanStep`/`WorkflowStepRun`), version-pinning discipline (`WorkflowRun.graphSnapshot`) |
| Visibility | nothing — routes compose the existing gates | `isAgentAccessibleToActor` mirror pair, `buildAccessibleThreadWhere` for run links; future `Agent.visibility` inherits free |
| Authoring service | `agent-todos.ts` in `@nessie/workspace-admin` | the shared-package pattern; API routes + worker tools call one implementation |
| Execution | `todo_start`, `todo_step_update` builtins; shared to-do fire preparation in `@nessie/workspace-admin` (both trigger fire paths + Run now); `activeRunId` claim + derived liveness | agentic run loop, `claimThreadRunOrPend` + pending-message provenance, `trigger-run.ts` fire shape, run terminal-status fusion (👀-marker precedent), toolset structural gating |
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
4. **Scheduling.** `config.todoTemplateId` validation + both fire paths'
   shared preparation, instantiate-at-adoption through the pending-message
   provenance, the config-invalid health reason, "Repeat on a schedule" in
   the template editor, the in-use 409 guards.

Phase 1 is independently shippable; 3 is independent once 1 exists; **4
depends on 2** — a scheduled checklist without `todo_step_update`, run
adoption, and the progress card could not record deterministic progress, which
is the feature's whole claim. Order is therefore 1 → 2 → {3, 4} in either
order.

## 11. Decisions (previously open questions — all resolved 2026-08-31)

1. **Instance-creation floor: one member-level rule, no narrowing.** Any
   active member who passes the agent gate may instantiate, Run now, and tick
   per the §4 table. Run-now is not narrower than instantiate — the person
   could ask the agent the same thing in chat, and its channel constraint
   (bound + caller membership) already contains where it can post. Two tiers
   of "may start this checklist" would be a distinction no other agent
   interaction draws.
2. **Steward editing rights ride people-and-their-agents phase 3.** Template
   writes are org-owner in v1, exactly the Designer's gate, and widen to
   `ownerUserId` in the same change that widens the Designer — never before,
   never separately. To-dos add no entitlement of their own.
3. **Scheduled instances accumulate; no rollover, no auto-cancel, no
   auto-adopt.** Each uncoalesced fire is a fresh instance and unfinished ones
   stand as honest history. The only assist is structural: when a scheduled
   kickoff finds still-open instances of the same template, their ids and
   ages are included as facts in the kickoff prompt, and whether to finish
   one first (`todo_start` adopting it) or start fresh is the model's
   judgement. Nothing silently cancels or merges a person's half-ticked
   checklist.
4. **Failed steps raise no new alert kind in v1.** The progress card, the
   run's own reply, and the unread state carry the signal; a to-do completing
   with failures is visible wherever the work happened. A dedicated alert is
   added only if real use shows failures going unseen — the alert-kind
   machinery (`UserAlert` + `user_alerts` dedupe) is ready when that day
   comes.
5. **Playbooks convergence is deferred to workflows Stage 2.** The sanctioned
   crossing point is a to-do step that *references* a Playbook via
   `invoke_workflow` when that lands; to-dos grow no typed steps, guards, or
   branching before then, and the Designer's template editor links to the
   workflow designer for work that needs them.
6. **Proposals are new-templates-only in v1.** An agent cannot propose edits
   to an active template; the edit-proposal flow (a step diff through the
   same draft+approval shape) is future work, taken up when proposals prove
   themselves.
7. **Cancel semantics are as specified in §2.2** — creator, org owner, or the
   agent's steward cancels; the run is never touched; the next agent
   step-write refuses in words against live state.

### Pinned bounds (defaults; schema constants unless marked env)

| Bound | Value | Where |
|---|---|---|
| Steps per template | 1–50 | `AgentTodoTemplateStepsSchema` (`@nessie/schemas`) |
| Step title / instructions length | ≤ 200 / ≤ 2,000 chars | same schema |
| Template name / description | ≤ 120 / ≤ 500 chars | same schema |
| Prompt block: active templates listed | 20, newest-first + "and N more" | worker prompt assembly |
| Prompt block: open instances listed | 10, newest-first + "and N more" | worker prompt assembly |
| Prompt block: own proposal drafts listed | 5, newest-first | worker prompt assembly |
| Pending agent proposals per agent | 10 (`NESSIE_MAX_PENDING_TODO_PROPOSALS`, env) | proposal tool |
| Proposal approval expiry | 7 days (`PENDING_APPROVAL_EXPIRY_MS` precedent) | proposal tool |

Schema-shape bounds are constants stated once in
`packages/schemas/src/agent-todos.ts` (the `EMBEDDING_DIMENSIONS` discipline);
only the proposal cap is deployment-tunable, because it is a behavioural
heuristic rather than a contract.

## Cross-model review — kimix and Codex Sol

Both reviewers worked adversarially against the repo; kimix reviewed the first
draft, Sol reviewed the doc with kimix's round folded in. Every claim below
was re-verified against code before adoption.

### Adopted from kimix (verified)

1. **`activeRunId` release cannot ride `updateRunStatus` alone** — the API's
   immediate-cancel flips a `pending` run terminal with a bare `updateMany`
   (`api/src/services/runs.ts:163-169`), and sweeps terminalize outside the
   loop. → claim only inside an executing run + readers derive liveness (§3).
2. **Trigger `config` is client-writable open JSON** — only three
   server-owned keys are stripped, so `todoTemplateId` needs a named
   validation chokepoint (§6).
3. **The trigger kickoff is `role: 'system'`** (`trigger-run.ts:347`) — a
   card stamped there is invisible; cards ride assistant replies (§3).
4. **`resolveApprovalRequest` checks the live role only when
   `requiredApproverRole` is set** and the kb precedent never sets it — the
   proposal approval sets `'owner'` (§5).
5. Step-write races, the mid-run human-tick staleness, the actor-type enum,
   the exact `enabled: true` in-use predicate, the config-readability
   adjudication, cancel semantics, and the per-step-assignee non-goal — all
   folded (§2–§4). **Refuted:** "the `safe:` flag is aspirational" —
   `builtin-kb-tools.ts` sets it on every definition; kimix read the handler
   files, not the definitions.

### Adopted from Sol (verified)

1. **Proposals could launder restricted context into a broadly-readable
   draft** before any review — the disclosure gap was real, not future. →
   `todo_template_propose` fails closed when the run consumed scoped
   sources (§5).
2. **Fire-time instantiation fights the pend/coalesce path** —
   `claimThreadRunOrPend` can drain several fires into one run. →
   instantiate at adoption, one instance per distinct template (§6).
3. **The approve effect's read-then-flip had a TOCTOU window** and a crash
   window after the atomic claim — activation is now a version-pinned CAS,
   with owner-direct activation as the recovery path (§5).
4. **Rejection effects never run** (`approvals.ts:247` — effects fire only on
   approve) → rejection resolves only; the draft stays visible with its
   rejected state, no new effect architecture (§5).
5. **The manual fire path is separate code** (`api/src/services/
   trigger-dispatch.ts` builds its own prompt) → shared fire preparation in
   `@nessie/workspace-admin` used by both paths (§6).
6. **The template-unavailable health transition is new work** — today only
   `TriggerLaunchOriginError` records health (§6). Also folded: relations +
   composite tenant FKs in the schema, `@@unique([todoId, key])`, the
   per-todo advisory lock on step writes, the failed-steps contradiction
   (resolved: all-terminal completes, failures visible), one active to-do
   per run, the bounded prompt block + proposal cap, the phase 4 → 2
   dependency, the Run-now membership rule being deliberately stricter than
   `schedule_task`, the non-owner tab actions wording, and the PA-exclusion
   mechanics (`isAgentAccessibleToActor`'s `systemManaged: false` is the
   real guard; `updateAgentRecord`'s system-managed branch must pin
   `todosEnabled` explicitly).

### Noted, not adopted

- Sol's suggestion of an effect outbox/retry for approval activation —
  declined as new architecture; the version-pinned CAS plus owner-direct
  activation covers the crash window without it.
- kimix's suggestion to index the cross-agent pending-proposal scan —
  deferred; the `/approvals` page already paginates and v1 volume does not
  warrant it.
