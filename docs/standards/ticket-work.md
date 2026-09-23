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
  TaskEvent origin shape, the `ticket.work` purpose, and the refusal that
  keeps the two new trigger types uncreatable.
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
  (`packages/team-admin/src/trigger-type-availability.ts`), and every create
  surface refuses them with `unreleasedTriggerTypeRefusal`'s one sentence:
  `POST /api/agents/:agentId/triggers` and
  `POST /api/workflow-installations/:id/triggers` answer 400
  `TRIGGER_TYPE_UNAVAILABLE`, `agent_trigger_create` and
  `workflow_trigger_create` throw it, and `createAgentTrigger` /
  `createWorkflowTrigger` return null before touching the database.
- Nothing that lists trigger types to a person or a model names them: the
  Designer's list is built from `RELEASED_TRIGGER_TYPES`, and the admin's
  `TriggerTypePicker` offers the five released types. The `agent-triggers`
  browser suite pins the picker; `admin/test/trigger-type-unreleased.test.tsx`
  pins the labels and the edit refusal.
- Taking a type off `UNRELEASED_TRIGGER_TYPES` is what releases it. That
  happens in the PR that ships the type's typed configuration, dispatch and
  editor (T1 for `ticket_changed`, T2 for `document_changed`), never earlier:
  a row nobody can configure and that never fires is worse than a refusal.

## Only a board editor's own move starts work, and only board editors steer it

- **Origin is stamped by the layer that authenticated the call, never by the
  caller.** The shape is T0: `TaskEventOriginSchema`
  (`packages/schemas/src/task-events.ts`) is an allowlist, like
  `PERSON_MESSAGE_AUTHORSHIP` — `session` (a route authenticated by a person's
  own browser or app session cookie, and nothing else), `token { keyId }` (API
  keys and the MCP surface), `agent { agentId, runId? }` (worker ticket tools),
  `source { boardSourceId }` (inbound board sync) and `system` (everything
  else, including migrations and platform teardown).
  `ColumnEnteredTaskEventPayloadSchema` and
  `PriorityChangedTaskEventPayloadSchema` refuse a `session` or `token` origin
  that does not name its member as a user id in `by`, and refuse an event that
  changes nothing. The writers that stamp it, and the two events themselves,
  arrive from T1; until then no `TaskEvent` carries an origin.
- **(from T1) A pickup fires only for a `session`-origin event whose author
  can edit the board when the event is written**: a `column_entered` into a
  start-work column from outside the pickup set, or a `created` straight into
  one. An agent's move, a token's move, a source sync, the platform and an
  agent's `ticket_create` into the column start nothing, and the ticket says
  so. Tests pin each of those as starting nothing.
- **(from T1) The people who can steer work are exactly the people who can
  start it.** A follow wake fires only for a `session`-origin event by a person
  who can edit the board. Anyone else's text — agents, sources, external
  provider users, people who cannot edit the board — reaches the agent only as
  quoted, attributed, untrusted content, which it is told never to forward to
  the coding agent as an instruction. Source events can wake a follow only
  when the trigger opts in with `follow.includeSourceEvents`; they never pick
  up work.
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
- **(from T1) The actor is the agent**: `actorType: 'agent'`,
  `effectiveUserId: null`, `interactive: false`, purpose `ticket.work` — the
  way event triggers already run (`worker/src/control/trigger-origin.ts`).
  `effectiveUserId` is read across the codebase as "act as this person", so
  the run **never reconstructs one**: not the mover, not the trigger's creator
  (`createdByUserId` is authorship and grants nothing), not the machine owner.
  Tools that need a person refuse, and a test pins each: knowledge reads of a
  private space, `schedule_task`, mailbox tools, identity tools and every
  setup verb.
- **(from T1) Ticket tools are admitted by a `ticket.work` arm of
  `isProjectDelegatedRun`** (`worker/src/run/execute/run-setup.ts`), against
  the agent's live binding to a channel of the ticket's project and its tool
  policy. Writes go through an agent task actor recorded as `agent:<id>` with
  `runId` (`taskEventBy`, `packages/team-admin/src/task-access.ts`), never
  through `requireActingUserId`. Today the function admits only
  `actorType: 'user'` runs, so a `ticket.work` run gets no project tools.
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

## One live record per (trigger, ticket), one active record per machine (T0)

Three partial unique indexes in
`api/prisma/migrations/20260923220000_ticket_work_contracts/migration.sql`
hold these, so no read-then-write race can break them:

- `agent_ticket_work_one_live`: one live record (`queued`, `active`, `parked`
  or `waiting_machine`) per `(trigger_id, task_id)`. A ticket re-entering a
  pickup column while its record is live, `parked` included, is a
  `ticket_moved` follow on that record, never a second pickup (from T1).
- `agent_ticket_work_one_active_per_executor`: one `active` record per
  `executor_id`. The pool dispatcher (from T4) assigns under that index, and
  `policyId` / `executorId` are written by the dispatcher, never by run setup.
- `agent_reminders_one_pending_per_work`: one pending reminder per work
  record; a new `check_back_in` replaces it (from T3).

Prisma cannot express a partial index, so these exist only in the migration
SQL, and a generated migration that drops them is wrong.

`agent_ticket_work_ended_known` requires `ended_at` and `ended_reason` exactly
when a record is terminal. `triggerId` and `policyId` are `onDelete: SetNull`,
so a record and its audit outlive a deleted trigger or policy; the trigger
delete service ends live records first (from T1).

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
  `trigger_disabled`.
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
  the `endExecutorConversationLeasesInTransaction` call sites. UOA has no
  removal feed, so the binder and `ticket-work.sweep` re-check the author with
  UOA and end the policy when UOA no longer lists them.

## The vocabularies live in two places that change together (T0)

- `packages/schemas/src/ticket-work.ts` holds every closed list:
  `TicketWorkStatusSchema` with `TICKET_WORK_LIVE_STATUSES` and
  `TICKET_WORK_TERMINAL_STATUSES`, `TicketWorkStateReasonSchema`,
  `TicketWorkWakeReasonSchema`, `ExecutorStandingPolicyStatusSchema` and its
  suspended and ended reasons, and `AgentReminderStatusSchema` with
  `AgentReminderCancelledReasonSchema`.
- Each list is also a CHECK in the migration, and the live list is also
  `agent_ticket_work_one_live`'s `WHERE`.
  `api/test/ticket-work-contracts-migration.test.ts` reads the SQL and fails
  when any of them disagree. Adding or renaming a value is one change with two
  edits: the Zod list, and a **new** migration that drops and re-adds that
  CHECK (and the index, for a live status). An applied migration is never
  edited.
- Wake reasons are configuration vocabulary the trigger's instructions are
  sectioned by (`onPickup`, `onSessionTurnEnded`, …). No code decides what the
  agent does from one.
- The queue topics and their payload schemas are in
  `packages/schemas/src/jobs.ts`: `TRIGGER_TICKET_DISPATCH_TOPIC` (from T1),
  `TRIGGER_DOCUMENT_DISPATCH_TOPIC` (from T2), `TICKET_WORK_SWEEP_TOPIC` (from
  T3) and `TICKET_WORK_SESSION_TOPIC` (from T5). Nothing subscribes to them
  yet; each handler parses its payload with its schema when it lands.

## Tests that hold these rules

- `api/test/ticket-work-contracts-migration.test.ts` and
  `api/test/ticket-work-contracts-postgres.test.ts`: the vocabularies against
  the SQL, and every CHECK and partial index against real rows.
- `packages/db/test/thread-serialization-ticket-work.test.ts`: a wake drains
  alone, as the agent.
- `packages/schemas/src/__tests__/task-events.test.ts` and
  `packages/schemas/src/__tests__/ticket-work-jobs.test.ts`: the origin and
  payload shapes.
- `packages/team-admin/test/trigger-type-availability.test.ts`,
  `api/test/trigger-type-unreleased-routes.test.ts`,
  `worker/test/trigger-type-unreleased-tools.test.ts` and
  `admin/test/trigger-type-unreleased.test.tsx`: the unreleased types are
  refused everywhere.
- `pnpm --filter @nessie/admin test:e2e:agent-triggers`: the real Triggers
  editor offers the released types and neither new one, at 1280 and 390 px.
  T1 extends it over each `ticket_changed` configuration state.
