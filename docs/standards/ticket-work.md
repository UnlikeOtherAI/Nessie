# Ticket work — who starts it, whose authority it runs under, who ends it

Authoritative standard. `AGENTS.md` → "Architecture" carries the one-line
summary and points here; **this file is the rule.** The design, the four
reviews every rule answers, and the PR order are in
[docs/plans/2026-09-23-ticket-driven-agents/overview.md](../plans/2026-09-23-ticket-driven-agents/overview.md);
where that plan and the code differ, the code and this file win.

A person moves a ticket into a start-work column; an agent a team set up picks
it up, and later, on a machine its owner confirmed once, has a local coding
agent do the work. One work record per ticket carries every later wake. The
platform owns that record's state: the agent is told the state in every wake,
and is never asked to manage it.

## What is shipped

Each rule is tagged with the PR that first enforces it in code:

- **(T0)** shipped with this file: the schema with its CHECKs and partial
  unique indexes, the Zod vocabularies, the queue payload shapes, the
  TaskEvent origin shape, the `ticket.work` purpose and its empty
  `isProjectDelegatedRun` arm, and the refusals that keep the two new trigger
  types uncreatable.
- **(from T1)**, **(from T3)**, **(from T4)**, **(from T5)** are rules the
  design fixes now and a later PR builds. Until that PR lands no code path
  exists that could break them, because nothing can create a `ticket_changed`
  or `document_changed` trigger (below).

The PR that ships a rule changes its tag here in the same change. A tag that
still says "from T*n*" after T*n* merged is a false statement about the code.

## Nothing is half-exposed (T0)

- `ticket_changed` and `document_changed` are in `AgentTriggerType` (Prisma)
  and `AgentTriggerTypeSchema` (`packages/schemas/src/lifecycle.ts`) before
  anything may create one. They are listed in `UNRELEASED_TRIGGER_TYPES`
  (`packages/team-admin/src/trigger-type-availability.ts`), and every
  agent-trigger create surface refuses them with
  `unreleasedTriggerTypeRefusal`'s one sentence:
  `POST /api/agents/:agentId/triggers` answers 400
  `TRIGGER_TYPE_UNAVAILABLE`, `agent_trigger_create` throws it, and
  `createAgentTrigger` returns null before touching the database.
- **Both types are agent-only, permanently.** Workflow installations are
  gated by `WORKFLOW_TRIGGER_TYPES` (manual, scheduled, webhook, event,
  interval), not by the release list: `POST
  /api/workflow-installations/:id/triggers` answers 400
  `TRIGGER_TYPE_UNAVAILABLE` with `workflowTriggerTypeRefusal`'s sentence,
  `workflow_trigger_create` throws it, and `createWorkflowTrigger` returns
  null. Each new type wakes an agent bound to its target channel, through a
  work record and `ticket.work` runs, and a workflow has none of these, so
  releasing a type for agents never opens it there. A new trigger type is
  agent-only until it is added to that list deliberately.
- Nothing that lists trigger types to a person or a model names them: the
  Designer's list is built from `RELEASED_TRIGGER_TYPES`,
  `workflow_trigger_create` offers exactly `WORKFLOW_TRIGGER_TYPES`, and the
  admin's `TriggerTypePicker` offers the five released types. The picker
  serves the agent and the workflow editors alike, so when T1 adds
  `ticket_changed` to it, it offers it only for an agent target. The
  `agent-triggers` browser suite pins the picker;
  `admin/test/trigger-type-unreleased.test.tsx` pins the labels and the edit
  refusal.
- Taking a type off `UNRELEASED_TRIGGER_TYPES` is what releases it for
  agents. That happens in the PR that ships the type's typed configuration,
  dispatch and editor (T1 for `ticket_changed`, T2 for `document_changed`),
  never earlier: a row nobody can configure and that never fires is worse
  than a refusal.

## A ticket or document trigger is found by its scope

- **(T0)** `agent_triggers.scope_project_id` and `scope_board_id` exist for
  the two new types only; every existing type leaves both null. Both keys are
  `ON DELETE SET NULL`, so deleting the board or project leaves the trigger
  row behind, unscoped.
- **(from T1)** The dispatcher looks triggers up by these columns, never by
  loading every trigger in the organisation and matching JSON in memory. A
  `ticket_changed` or `document_changed` trigger whose scope is null matches
  **nothing** — never every board — and shows a health reason on the
  Triggers page.

## Only a board editor's own move starts work; board editors, and an opted-in board source, steer it

- **Origin is stamped by the layer that authenticated the call, never by the
  caller.** The shape is T0: `TaskEventOriginSchema`
  (`packages/schemas/src/task-events.ts`) is an allowlist, like
  `PERSON_MESSAGE_AUTHORSHIP` — `session` (a route authenticated by a person's
  own browser or app session cookie, and nothing else), `token { keyId }` (API
  keys and the MCP surface), `agent { agentId, runId }` (worker ticket tools,
  which always run inside a run), `source { boardSourceId }` (inbound board
  sync) and `system` (everything else, including migrations and platform
  teardown). `ColumnEnteredTaskEventPayloadSchema` and
  `PriorityChangedTaskEventPayloadSchema` refuse an author `by` that
  disagrees with the origin — a `session` or `token` origin must name its
  member's user id, an `agent` origin `agent:<agentId>` or the member its run
  acted for, a `source` origin only `source:<boardSourceId>` (what
  `board-source-apply.ts` writes) — and refuse an event that changes nothing.
  The writers that stamp it, and the two events themselves, arrive from T1;
  until then no `TaskEvent` carries an origin.
- **(from T1) A pickup fires only for a `session`-origin event whose author
  can edit the board when the event is written**: a `column_entered` into a
  start-work column from outside the pickup set, or a `created` straight into
  one (both wake with reason `pickup`). An agent's move, a token's move, a
  source sync, the platform and an agent's `ticket_create` into the column
  start nothing, and the ticket says so. Tests pin each of those as starting
  nothing.
- **(from T1) A follow wake fires for a `session`-origin event by a person who
  can edit the board and — only when the trigger sets
  `follow.includeSourceEvents` — for a `source`-origin event. Nothing else
  wakes it, and a source event never picks up work.** Text from anyone but a
  board editor — agents, sources (opted in or not), external provider users,
  people who cannot edit the board — reaches the agent only as quoted,
  attributed, untrusted content, which it is told never to forward to the
  coding agent as an instruction. Each follow kind wakes with its own reason:
  comment `ticket_commented`, description `ticket_description_changed`,
  priority `ticket_priority_changed`, labels `ticket_labels_changed`,
  assignee `ticket_assignee_changed`, moved `ticket_moved`, and
  `thread_message` and `document_changed` by those names.
- **(from T1) Only board editors write in a work thread**, checked live by the
  message route. A person's message there starts no ordinary run: it becomes a
  `thread_message` follow wake, and the message is stamped
  `metadata.ticketWorkSteer = true`.

## A `ticket.work` run acts as the agent, never as a person

- **(T0) Every `ticket.work` kickoff drains alone.** `TICKET_WORK_PURPOSE`
  (`packages/schemas/src/ticket-work.ts`) is in `DRAINS_ALONE_PURPOSES`
  (`packages/db/src/thread-serialization.ts`): a pended wake becomes its own
  follow-up run and is never folded into a batch with people's messages, so no
  person's message is consumed under the agent's authority.
  `packages/db/test/thread-serialization-ticket-work.test.ts` pins it.
- **(from T1) Pending wakes for the same work record coalesce when they are
  enqueued, not when they drain.** At most one pending `ticket.work` row
  exists per work record: a wake for a record that already has one folds its
  event into that row's kickoff instead of adding a second row, so the one
  run that drains lists every event in order (*"Since your last run: Ondrej
  commented …; priority high → urgent; session turn 3 ended."*) and counts
  once against `wakesPerTicket`. Draining alone is unchanged: the drain still
  takes one row per run. `RunThreadPendingMessage` has no work-record key
  today, so T1 adds one (a `workId` column, or a typed field of the stored
  actor context) and pins the fold beside the drain-alone test, which pins
  one wake per run.
- **(from T1) The actor is the agent**: `actorType: 'agent'`,
  `effectiveUserId: null`, `interactive: false`, purpose `ticket.work` — the
  way event triggers already run (`worker/src/control/trigger-origin.ts`).
  `effectiveUserId` is read across the codebase as "act as this person", so
  the run **never reconstructs one**: not the mover, not the trigger's creator
  (`createdByUserId` is authorship and grants nothing), not the machine owner.
  Tools that need a person refuse, and a test pins each: knowledge reads of a
  private space, `schedule_task`, mailbox tools, identity tools and every
  setup verb.
- **(T0) `isProjectDelegatedRun` decides a `ticket.work` run by its own arm,
  first, and that arm admits nothing** (`worker/src/run/execute/run-setup.ts`).
  So the run can never be lent project tools through a person-started arm
  (`interactive`, `agent.peer_delegation`, `channel.policy`), whatever its
  actor context says; `worker/test/pa-tools-ticket-activity.test.ts` pins it
  for user and agent actors, interactive or not. **(from T1)** T1 replaces
  that `false` with the admission: the agent's live binding to a channel of
  the ticket's project and its tool policy. Writes go through an agent task
  actor recorded as `agent:<id>` with `runId` (`taskEventBy`,
  `packages/team-admin/src/task-access.ts`), never through
  `requireActingUserId`.
- **(from T1) The run signs with the ledger as event triggers do, with no
  user identity.** A deployment that refuses unsigned agent runs sets the
  record's `stateReason` to `identity_unverifiable`, which the chip shows,
  and raises the trigger's health banner.
- **(from T1)** `ticket.work` run limits are clamped to a platform ceiling in
  `worker/src/run/run-budget.ts`, whatever the agent's own `runLimits` say.

## The machine owner's authority is read only by the standing-policy binder (from T4)

- The author of a standing policy is never in the run's actor context. It
  travels as `actionContext.standingPolicy = { policyId, authorUserId }`, and
  only `bindStandingPolicyExecutor`
  (`packages/executor-manage/src/executor-standing-policy-binding.ts`), its
  provenance arm and the dispatch fence beside
  `assertExecutorCommandBindingCurrent` read it. No tool, gate or disclosure
  check may treat it as "act as this person".
- Every wake with an active record is bound afresh and every check runs again:
  the policy is `live` and names this trigger, agent and executor; the trigger
  and descriptor digests still match; the author is re-resolved live with UOA,
  failing closed and never from a cache; the machine is online and still
  private to the author; the target channel is still live, ordinary and public
  in the project; the run consumes only this work record's kickoffs; the limits
  allow it. A refusal writes `executor.run.policy_refused` and the run
  continues unbound.
- In a `ticket.work` run, host-output-bearing writes are admitted only to that
  ticket's comments and its work thread, and the machine is named only to its
  owner and executor admins, never to the project audience.
- **(T0) The policy's shape is enforced by the database.**
  `executor_standing_policies_confirmed_known` requires a `live` or
  `suspended` policy to carry `confirmed_at` and `author_origin`;
  `suspended_reason` is set exactly while suspended, and `ended_at` /
  `ended_reason` exactly once ended. The pool,
  `executor_standing_policy_executors`, has one row per machine (composite
  primary key, unique `(policy_id, position)`, `position` 0 or 1), because a
  JSON array cannot hold a foreign key.
- **(T0) One binding policy and one outstanding card per trigger.**
  `executor_standing_policies_one_binding` allows one `live` or `suspended`
  policy per `trigger_id`, and `executor_standing_policies_one_preparing` one
  `preparing` card. So the dispatcher and the binder always find exactly one
  policy for a trigger; a confirm ends the policy it replaces (`replaced`) in
  its own transaction before it goes live; and a new prepare ends the card it
  replaces first, so a stale card can never be confirmed. A policy whose
  trigger was deleted (`trigger_id` null) blocks nothing.
- **(T0) The pool's executor key cascades.** No product path hard-deletes an
  executor: revoking one is a status change and a fence that ends its
  policies first (from T4). The one hard delete is the organisation's own,
  which removes its executors and its policies in one statement, and a
  `RESTRICT` or `NO ACTION` key on the pool refuses that delete whenever a
  pool exists. A test pins the organisation delete.
- **(from T4) Limits and digests.** Lowering a limit is the one edit of a
  pinned field that does not suspend the policy: the edit recomputes
  `triggerDigest` in the same transaction, so binding check 2 still matches.
  Raising one takes a new prepare and a new card. `dailyUsd` is per policy per
  day, while `AgentTicketWork.costUsd` is a record's lifetime total and
  cannot be split across midnight, so T4 adds a per-policy daily spend ledger
  (policy, day, cost, unique on the pair) with its migration.

## One live record per (trigger, ticket), one record per machine (T0)

Five partial unique indexes in
`api/prisma/migrations/20260923220000_ticket_work_contracts/migration.sql`
hold these, so no read-then-write race can break them:

- `agent_ticket_work_one_live`: one live record (`queued`, `active`, `parked`
  or `waiting_machine`) per `(trigger_id, task_id)`. A ticket re-entering a
  pickup column while its record is live, `parked` included, is a
  `ticket_moved` follow on that record, never a second pickup (from T1).
- `agent_ticket_work_one_per_executor`: one record holds each `executor_id` —
  the `active` one, or the `waiting_machine` one waiting for that machine to
  reconnect (`TICKET_WORK_MACHINE_HOLDING_STATUSES`). A dequeue onto a machine
  that just came back therefore cannot take the slot before the ticket that
  was mid-work there resumes, and the pool dispatcher's "free" means no
  record in either status (from T4 and T5). A `parked` or `queued` record may
  still name an executor without holding it. `policyId` / `executorId` are
  written by the dispatcher, never by run setup.
- `agent_reminders_one_pending_per_work`: one pending reminder per work
  record; a new `check_back_in` replaces it (from T3).
- `executor_standing_policies_one_binding` and
  `executor_standing_policies_one_preparing`: above.

Prisma cannot express a partial index, so these exist only in migration SQL,
and a generated migration that drops them is wrong.

`agent_ticket_work_ended_known` requires `ended_at` and `ended_reason` exactly
when a record is terminal. `triggerId` and `policyId` are `onDelete: SetNull`,
so a record and its audit outlive a deleted trigger or policy; the trigger
delete service ends live records first (from T1). `active_ms` is a `BIGINT`
(Prisma `BigInt`), because an `INTEGER` of milliseconds overflows at about 596
hours.

## Teardown, limits and session closes are the platform's

Session teardown never depends on the model: a run cannot bind once its policy
has ended, and when the agent itself moves a ticket to Done, the loop guard
suppresses its own wake. So each of these happens **in the transaction that
causes it**:

- **(from T1) Entering an `endOn` column**, whoever moved the ticket, the
  agent included: the record goes to `done` (`stateReason: merged` when a
  merged pull request is on record) or `cancelled`, its reminders are
  cancelled, its machine is freed and the pool dispatcher is enqueued, all
  inside the move transaction. The agent then gets one machine-less
  `ticket_moved` wake, only to comment. A review-category column outside
  `endOn` parks the record instead.
- **(from T1) Disabling or deleting the trigger** ends every live record with
  `trigger_disabled`. **(from T4)** It also ends the trigger's policy, with
  `trigger_disabled` or `trigger_deleted`, so re-enabling a trigger takes a
  fresh confirmation.
- **(from T4) Sessions are closed by the server.** Session-scoped
  `executorCodingSessionCloseRequest` rows for the record's `sessionIds` are
  written in the same transaction as the ticket leaving the flow
  (`ticket_left_flow`), a limit (`work_limit`), a policy ending or suspending
  (`policy_ended`), or the trigger changing. T4 adds those reasons to
  `EXECUTOR_CODING_SESSION_CLOSE_REASONS` and its CHECK.
- **(from T4) Limits are enforced by the platform.** A record over
  `wakesPerTicket`, `ticketHours`, `ticketUsd`, `startsPerDay` or `dailyUsd`
  goes to `failed` with its `limit_*` reason and its sessions get close
  requests; the ticket says how to continue.
- **(from T4) The policy ends in the same transaction as each fence**, reusing
  the `endExecutorConversationLeasesInTransaction` call sites. The target
  channel being archived, made non-public or leaving the project is one of
  them (`target_channel_unavailable`): the audience the author agreed to no
  longer reads the work. UOA has no removal feed, so the binder and
  `ticket-work.sweep` re-check the author with UOA and end the policy when
  UOA no longer lists them.

## The vocabularies live in two places that change together (T0)

- `packages/schemas/src/ticket-work.ts` holds every closed list:
  `TicketWorkStatusSchema` with `TICKET_WORK_LIVE_STATUSES`,
  `TICKET_WORK_TERMINAL_STATUSES` and `TICKET_WORK_MACHINE_HOLDING_STATUSES`,
  `TicketWorkStateReasonSchema`, `TicketWorkWakeReasonSchema`,
  `TicketWorkPullRequestStateSchema` (`OPEN`, `CLOSED`, `MERGED`, as
  `gh pr view` spells them), `ExecutorStandingPolicyStatusSchema` and its
  suspended and ended reasons, and `AgentReminderStatusSchema` with
  `AgentReminderCancelledReasonSchema`.
- Each list is also a CHECK in the migration, and the status lists are also
  the partial indexes' `WHERE`s. Two tests fail when any of them disagree:
  `api/test/ticket-work-contracts-migration.test.ts` reads every migration in
  the order `migrate deploy` applies them and compares each constraint's
  **latest** definition (a later drop without a re-add fails it), and
  `api/test/ticket-work-contracts-postgres.test.ts` reads `pg_constraint` and
  `pg_indexes` from the migrated database. Adding or renaming a value is one
  change with two edits: the Zod list, and a **new** migration that drops and
  re-adds that CHECK (and the index, for a status). An applied migration is
  never edited.
- Wake reasons are configuration vocabulary the trigger's instructions are
  sectioned by (`onPickup`, `onSessionTurnEnded`, …). No code decides what the
  agent does from one.
- The queue topics and their payload schemas are in
  `packages/schemas/src/jobs.ts`: `TRIGGER_TICKET_DISPATCH_TOPIC` (from T1),
  `TRIGGER_DOCUMENT_DISPATCH_TOPIC` (from T2), `TICKET_WORK_SWEEP_TOPIC` (from
  T3, with an optional tick `bucket`), `TICKET_WORK_DISPATCH_TOPIC` (the pool
  dispatcher's job for an executor that may have come free, from T5) and
  `TICKET_WORK_SESSION_TOPIC` (from T5, whose `status` is only one that wakes:
  `waiting_for_input`, `interrupted`, `failed` or `closed`). Nothing
  subscribes to them yet; each handler parses its payload with its schema
  when it lands.

## Tests that hold these rules

- `api/test/ticket-work-contracts-migration.test.ts` and
  `api/test/ticket-work-contracts-postgres.test.ts`: the vocabularies against
  the latest SQL and against the migrated database, and every CHECK and
  partial index against real rows.
- The upgrade path is CI's Upgrade Path job: the baseline fixture, then
  `migrate deploy` from HEAD, then `api/scripts/upgrade-smoke.mjs`. The repo
  has no down migrations; this one is purely additive, and a failed apply
  rolls back as one transaction
  ([docs/deployment/upgrade-paths.md](../deployment/upgrade-paths.md)).
- `packages/db/test/thread-serialization-ticket-work.test.ts`: a wake drains
  alone, as the agent.
- `worker/test/pa-tools-ticket-activity.test.ts`: a `ticket.work` run is not
  project-delegated.
- `packages/schemas/src/__tests__/task-events.test.ts` and
  `packages/schemas/src/__tests__/ticket-work-jobs.test.ts`: the origin and
  payload shapes.
- `packages/team-admin/test/trigger-type-availability.test.ts`,
  `api/test/trigger-type-unreleased-routes.test.ts`,
  `worker/test/trigger-type-unreleased-tools.test.ts` and
  `admin/test/trigger-type-unreleased.test.tsx`: the unreleased types are
  refused on every agent surface, and both types on every workflow surface.
- `pnpm --filter @nessie/admin test:e2e:agent-triggers`: the real Triggers
  editor offers the released types and neither new one, at 1280 and 390 px.
  T1 extends it over each `ticket_changed` configuration state.
