# Ticket work: the record, the thread, the wakes

A pickup creates one work record. Every later wake for that ticket goes
through that record. The platform owns the record's state. The agent is told
the state; it is never asked to manage it.

## The work record

`agent_ticket_work` (T0 creates it; T1 writes it):

| Column | Notes |
|---|---|
| `id`, `organizationId`, `triggerId`, `agentId`, `taskId`, `projectId` | `triggerId` is `onDelete: SetNull`, so the record and its audit outlive a deleted trigger. The trigger delete service ends the record first |
| `threadId` | The ticket's work thread (see below) |
| `status` | `queued`, `active`, `parked`, `waiting_machine`, `done`, `cancelled` or `failed`, with a CHECK |
| `stateReason` | Closed vocabulary with a CHECK: `queued_no_free_machine`, `queued_machines_offline`, `machine_access_not_set_up`, `machine_access_suspended`, `machine_access_ended`, `machine_offline`, `limit_wakes`, `limit_hours`, `limit_cost`, `limit_daily`, `left_flow`, `merged`, `mover_lost_access`, `trigger_disabled` |
| `policyId?`, `executorId?` | Set by the pool dispatcher, never by run setup. A partial unique index on `executor_id WHERE status = 'active'` enforces one ticket per machine |
| `startedByUserId`, `startedByEventId` | The person whose move started it, and the TaskEvent |
| `queuePosition?`, `enqueuedAt?` | The queue is ordered by ticket priority, then `enqueuedAt` |
| `sessionIds[]`, `lastObservedTurn` (JSON per session) | Written by the worker in the same step as `coding_session_start` returns |
| `pullRequestUrl?`, `lastPrState?`, `lastChecks?`, `prSeenAt?` | See [Done means merged](machine-access.md#done-means-merged) |
| `wakeCount`, `activeMs`, `costUsd`, `lastWakeAt`, `lastWakeReason` | Limits and the chip. `activeMs` pauses while the record is `waiting_machine` or waiting on a person |
| `startedAt`, `endedAt`, `endedReason`, `endedBy` | |

There is at most one live record (`queued`, `active`, `parked` or
`waiting_machine`) per `(triggerId, taskId)`, enforced by a partial unique
index.

## The work thread

- There is **one thread per (trigger, ticket)**, reused when a ticket comes
  back after it ended. It is created in the trigger's target channel with
  thread metadata `{ taskId, triggerId }` and `title` "<ticket key>
  <ticket title>". The code lives in a new team-admin file, not
  `agent-conversations.ts`, which is on the size allowlist.
- In the channel's conversation list, ticket threads fold under a
  **Tickets** group on the agent's entry, so twenty tickets do not flood it.
  The agent-conversations suite pins the fold.
- **Only people who can edit the board write in a work thread.** The message
  route checks this live. Anyone else sees a read-only composer that says
  *"Comment on the ticket to give the agent more information."*
- A person's message in the thread starts no ordinary run. It becomes a
  follow wake with reason `thread_message`, quoting the message and its
  author. The message is stamped `metadata.ticketWorkSteer = true`. A
  `ticket.work` run's conversation context contains only the agent's own
  messages, stamped person messages and the rendered wake blocks.

## Authority of a `ticket.work` run

This is the rule the reviews forced. `effectiveUserId` is read by about 70
files as "act as this person" (knowledge reads, mailbox gates,
`schedule_task`, `requireActingUserId`). So a ticket-work run **has no
effective user**.

- The actor is the agent (`actorType: 'agent'`), with `effectiveUserId:
  null` and `interactive: false`, and purpose `ticket.work`. This matches how
  event triggers already run: `trigger-origin.ts` returns `userId: null` for
  every type except the schedules.
- **Ticket tools** are admitted in `run-setup.ts` by a `ticket.work` arm of
  `isProjectDelegatedRun`. The agent must be bound to a channel of the
  ticket's project, re-read live, and its tool policy must grant each tool.
  Writes go through an **agent task actor**: the seam at `task-access.ts`,
  with no person behind it, recorded as `agent:<id>` with `runId`. It is
  never routed through `requireActingUserId`. The agent's project access is
  its live binding, and a missing binding refuses with *"<agent> is no
  longer in a channel of this project."*
- Tools that need a person refuse, and a test pins each refusal: knowledge
  reads of a private space, `schedule_task`, mailbox tools, identity tools,
  and every setup verb.
- The machine owner's authority is **not** in the actor context. It lives in
  `actionContext.standingPolicy = { policyId, authorUserId }`. Only the
  standing-policy binder, the binder's provenance arm and the dispatch fence
  read it ([machine-access.md](machine-access.md#binding-at-each-wake)).
- Ledger: the run signs as the event triggers do today, with no user
  identity. A signing deployment that refuses unsigned agent runs shows
  `identity_unverifiable` on the chip and the trigger's health banner.
- Every `ticket.work` kickoff **drains alone** (`DRAINS_ALONE_PURPOSES`). A
  person's message is never consumed by a bound run. Pending kickoffs for the
  **same** work record coalesce into one run, whose kickoff lists every event
  in order: *"Since your last run: Ondrej commented …; priority high → urgent;
  session turn 3 ended."*
- Run limits for `ticket.work` runs are clamped to a platform ceiling
  (`run-budget.ts`), whatever the agent's own `runLimits` say.

## What every wake says

Kickoffs are `system` messages, and `loadConversation` drops them from later
context. So each kickoff is rebuilt from the work record and carries the same
three blocks, whatever the reason. A weak model then never has to remember
the plan or the state.

1. **Why you were woken**: one reason code and a one-line detail. The codes
   are `pickup`, `dequeued`, `queued`, `ticket_commented`,
   `ticket_description_changed`, `ticket_priority_changed`, `ticket_moved`,
   `thread_message`, `document_changed`, `session_turn_ended`,
   `session_interrupted`, `session_failed`, `session_closed`, `reminder`,
   `quiet`, `machine_back_online`. They are configuration vocabulary, not
   behaviour.
2. **State.** For example: *Ticket NES-142 "Fix login redirect" (id …),
   board Engineering, column In progress (in_progress), priority high.
   Columns: Review … (review), Done … (done). Work: started 14:05, 1 h 12 min
   of 4 h, wake 5 of 30, coding cost $3.10 of $20 (as last seen). Machine:
   bound for this run. Coding session for this ticket: … waiting_for_input,
   turn 2; no other session belongs to this ticket. Pull request: <url> OPEN,
   checks 12 passed / 0 failed / 1 pending (14:58). Pending reminder: none.
   After this run you are woken when the session's turn ends, the ticket
   changes, or a reminder you set fires.*
3. **Instructions**: the trigger's `general` section, then the section that
   matches the reason.

Content rules:

- A description change carries a bounded line diff (the shared line diff from
  T2; T1 carries the new text). A comment carries its full text and author.
- Text from anyone other than a person who can edit the board is framed as
  quoted, attributed third-party content and marked untrusted. That covers
  agents, sources, external provider users, and people who cannot edit the
  board. The agent is told never to forward it to the coding agent as an
  instruction.
- A glossary for the session states is part of the facts. *interrupted,
  max_turn_minutes*: the coding agent hit its per-turn limit and can resume,
  so send it "continue". *interrupted, host_lost*: the machine restarted, so
  send "continue where you left off". *failed*: the session cannot continue,
  so start a new one whose brief says what was already done. *permission
  denials*: only the machine's owner can allow them, so comment on the ticket
  naming the denied action and stop.

## Teardown is the platform's

Session teardown never depends on the model. If a policy has ended, a run
cannot bind, so the model could not close anything anyway. When the agent
itself moves a ticket to Done, the loop guard would suppress its own wake.

- **Entering an `endOn` column** (by category or id) sets the record to
  `done` (done category, with `stateReason: merged` when a merged pull request
  is on record) or `cancelled`. This happens inside the move transaction,
  whoever moved the ticket. The same transaction writes session-scoped close
  requests for every recorded session (reason `ticket_left_flow`), cancels
  the record's reminders, frees the machine and enqueues the pool dispatcher.
  The agent then gets one machine-less `ticket_moved` wake, only to comment.
- **Entering a review-category column** that is not in `endOn` sets the
  record to `parked`. The sessions stay and the machine slot is freed.
  Re-entering a pickup column resumes the record. If its machine is now
  busy, the record queues ahead of new tickets for that machine.
- **Disabling or deleting the trigger** ends every live record with reason
  `trigger_disabled`, the same way.
- **A limit** is enforced by the platform, never the model. The record goes
  to `failed` with the limit's reason, and its sessions get close requests
  (reason `work_limit`). The ticket activity shows *"Stopped: 30 wakes used.
  Move the ticket out of and back into In progress to continue."* The chip
  shows the same.

## Reminders: `check_back_in` (T3)

For "check back in 15, 30, 50 minutes", as a one-off.

- **Tool:** `check_back_in { minutes: integer 5–1440, note }`. Values out of
  range are refused with a message that states the range, and the integer
  schema lets the existing coercion turn "15" into 15. Its description: *Wake
  me in this thread after `minutes`. Use it when you are waiting for
  something that will not wake you, such as CI or a person's answer. It
  replaces this ticket's pending reminder.*
- **Its own row**, `agent_reminders { id, agentId, threadId, workId?, dueAt,
  note, createdByRunId, status pending|fired|cancelled, firedAt,
  cancelledReason }`. It is not `schedule_task`: those rows run as their
  creator, count against the creator's 25-schedule cap, and fire without the
  `ticket.work` purpose.
- **In ticket work**, there is one pending reminder per work record, and a
  new one replaces it. It fires as a `ticket.work` wake with reason
  `reminder`, so the policy is re-checked at bind. It counts against the wake
  budget and is cancelled with the record. The chip shows *"checking back at
  14:35: waiting for CI"* with Cancel, for people who can edit the board.
- **Outside ticket work**, it wakes the agent with no effective user and
  `interactive: false` in the same thread. It is refused in a system channel
  (a Designer or PA DM), because that would re-arm a person's identity. There
  are at most 3 pending per thread and 24 per agent per day.
- **Delivery.** The scheduler tick that fires scheduled triggers also claims
  due reminders (`FOR UPDATE SKIP LOCKED`).

## Quiet wake and the sweep (T3)

CI finishes without an event. A weak model may forget to set a reminder.
The ticket would then sit in In progress forever.

- **`quietWakeMinutes`** (a trigger option, default 30, shown in the editor):
  when a live record has no working session, no pending reminder and no wake
  for that long, the platform sends a `quiet` wake with the detail *"nothing
  else is scheduled."* It counts against the wake budget.
- **`ticket-work.sweep`** is one periodic job. It fires quiet wakes, ends
  records over their limits, dequeues when a machine is free, re-checks
  policies (see [machine-access.md](machine-access.md#fences)), and recovers a
  queued record whose job was lost.

## Session wakes (T5)

A turn that ends on the coding agent wakes the ticket's agent. The heartbeat
cannot compute that today:

- The session summary has no turn number.
- `session_list_all` skips closed sessions.
- A fast "merge now" turn goes `waiting_for_input` → `working` →
  `waiting_for_input` inside one report, so the status looks unchanged.

The fix:

- **Executor** (every OS; T5): the signed session summary gains `turn` and
  `lastTurnEndedAt`, and `listAll` emits them. The report always includes
  every session a live work record names, even past the newest-first cap of
  32 rows.
- **Intake** is in the existing heartbeat transaction, which already holds
  `lockExecutorConnection`, in a helper in a new file. It compares the previous
  and new `codingSessions` for sessions named by live work records. It enqueues
  `ticket-work.session` with idempotency `session:<id>:<turn>:<status>` when:
  - the turn went up and the status is not `starting` or `working`; or
  - the status entered `interrupted` or `failed`; or
  - a named session is missing from a report that has the field, which
    counts as closed. A missing field infers nothing.
- **No double handling.** When a wait or review in a `ticket.work` run sees a
  turn end, it stores `lastObservedTurn`. At drain, a session wake at or
  below that turn is skipped (a delivery row records the skip).
- v1 relies on the existing 120 s probe. An immediate executor-side refresh
  on status change is a follow-up.

## The pool queue (T4 assigns, T5 dequeues)

Machines are shared across triggers, so the queue belongs to the machine,
not to one policy.

- **Assignment happens at dispatch, in one transaction.** It locks the
  policy's pool rows (`FOR UPDATE`) and picks the first pool executor that is
  online, has no `active` record (the partial unique index holds) and has
  fewer live sessions than its signed `maxLiveSessionsPerOwner`. It then
  writes `executorId` and sets the record to `active`. Run setup only binds
  the executor that is already pinned.
- **Nothing free.** The record goes to `queued` with a position and a reason:
  `queued_no_free_machine` or `queued_machines_offline`. Its first run is one
  short **unbound** `queued` wake with facts like *"queued: position 1; both
  machines busy with NES-140 and NES-141; you will be woken when one frees."*
  The agent's own `onQueued` instructions decide what it comments. No machine
  is named to the project audience (see below).
- **Dequeue** (T5) fires when a record ends, a session closes, a machine comes
  online, or the sweep runs. The dispatcher picks, across every policy whose
  pool includes the free machine, the highest-priority, oldest queued record.
  At dequeue it re-checks everything:
  - the ticket is still in a pickup column;
  - the mover is still a live member who can edit the board;
  - the policy is live and its digests match.

  Otherwise the record is cancelled with a ticket activity row. A priority
  change on a queued ticket re-sorts the queue and wakes nothing.
- **Machine offline mid-work.** When the pinned executor is offline at wake
  time, the wake starts **no model run**. The record goes to
  `waiting_machine`, and the ticket activity shows *"Paused: the machine is
  offline since 14:32; work resumes when it reconnects."* The next online
  heartbeat enqueues a `machine_back_online` wake. The hours clock is paused
  meanwhile.

## What the project sees

Everything the mover needs is on the ticket, readable by the project audience
(decision 4). None of it names the machine: a private executor's label is
not the room's to see.

- **The work chip** in the ticket dialog shows *"CTO · working · started
  14:05"*, *"queued: position 2"*, *"paused: machine offline"*, *"stopped:
  30 wakes used"* or *"waiting for machine access"*. It also shows the last
  wake and its reason, and the pending reminder. It links to the work thread
  for people who can open it; for anyone else it shows no link. The
  task-dialog suite pins it.
- **The board card** (`KanbanCard`) shows a compact version: the agent's
  avatar with a state dot.
- **The column** shows a read-only badge, *"Moving here starts work: CTO"*,
  to everyone. The badge is on the column header. "Start work with an agent…"
  is offered in the column menu only to people who can create triggers.
- **Wake rows in the thread.** Each wake renders as a compact, non-model
  event row: *"Woken: Ondrej commented"*, *"Woken: the coding session's turn
  ended"*, *"Woken: reminder, waiting for CI"*. It is a `system` message with
  `metadata.ticketWorkEvent`, which the read model admits as an event row.
  The agent's `coding_session_send` stays visible in the thought process, so
  a person can check that a relay happened.
- **Ticket activity** gains `work_started`, `work_queued`, `work_paused`,
  `work_resumed` and `work_ended` rows, each with its reason.
- The machine is named only to its owner and to executor admins: on the
  executor page and in the trigger's Machine access section.

## Limits

These are defaults, editable in the trigger editor within platform ceilings:

| Limit | Default | Counted by |
|---|---|---|
| `wakesPerTicket` | 30 | Every model run for the record, including queued, quiet and reminder wakes |
| `ticketHours` | 4 | `activeMs`; paused while `waiting_machine`, or while the last agent comment asked a question and no wake followed |
| `ticketUsd` | 20 | Coding cost deltas from every status read and review the worker makes, plus the Nessie run cost |
| `startsPerDay` | 20 | Pickups per trigger per day |
| `dailyUsd` | 60 | Per policy per day |
