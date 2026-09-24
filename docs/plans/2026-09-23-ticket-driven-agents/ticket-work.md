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
| `stateReason` | Closed vocabulary with a CHECK: `queued_no_free_machine`, `queued_machines_offline`, `machine_access_not_set_up`, `machine_access_suspended`, `machine_access_ended`, `machine_offline`, `limit_wakes`, `limit_hours`, `limit_cost`, `limit_daily`, `left_flow`, `merged`, `mover_lost_access`, `trigger_disabled`, `identity_unverifiable` |
| `policyId?`, `executorId?` | Set by the pool dispatcher, never by run setup. A partial unique index on `executor_id WHERE status IN ('active', 'waiting_machine')` enforces one ticket per machine, so a record waiting for its pinned machine keeps the slot. One waiting for machine access is unpinned, and holds none |
| `startedByUserId`, `startedByEventId` | The person whose move started it, and the TaskEvent |
| `queuePosition?`, `enqueuedAt?` | The queue is ordered by ticket priority, then `enqueuedAt` |
| `sessionIds[]`, `lastObservedTurn` (JSON per session) | Written by the worker in the same step as `coding_session_start` returns |
| `pullRequestUrl?`, `lastPrState?`, `lastChecks?`, `prSeenAt?` | See [Done means merged](machine-access.md#done-means-merged) |
| `wakeCount`, `activeMs`, `costUsd`, `lastWakeAt`, `lastWakeReason` | Limits and the chip. `activeMs` (a `BIGINT`) pauses while the record is `queued` or `waiting_machine`, and while an open question waits for a person (see [Quiet wake](#quiet-wake-and-the-sweep-t3)) |
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
   `ticket_description_changed`, `ticket_priority_changed`,
   `ticket_labels_changed`, `ticket_assignee_changed`, `ticket_moved`,
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
  record to `parked`. The sessions stay and the machine slot is freed, and
  the same transaction enqueues the pool dispatcher so a queued ticket can
  take the slot. Re-entering a pickup column (under the origin rule) resumes
  the record. If its machine is now busy, the record queues ahead of new
  tickets for that machine.
- **Disabling or deleting the trigger** ends every live record with
  `stateReason: trigger_disabled`, the same way. Its sessions get close
  requests with reason `trigger_changed`.
- **Machine access suspended** (any `suspendedReason`) moves every `active`
  record of that policy to `waiting_machine`, with `stateReason:
  machine_access_suspended`, in the suspending transaction, and unpins its
  executor. That frees the machine slot, pauses the hours clock and stops
  quiet wakes. Its sessions get
  close requests with reason `policy_suspended`. When the author re-confirms,
  the confirming transaction moves those records back to `queued` and
  enqueues the dispatcher, which resumes them with a `dequeued` wake. `queued`
  and `waiting_machine` records keep their state and only wait.
- **Machine access ended** cancels every live record of that policy with
  `stateReason: machine_access_ended`, in the ending transaction. Their
  sessions get close requests with reason `policy_ended`. The ticket activity
  says *"Machine access ended. Set it up again, then move the ticket out of
  and back into In progress to restart."*
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
  when an `active` record has no working session, no pending reminder, no
  open question and no wake for that long, the platform sends a `quiet` wake
  with the detail *"nothing else is scheduled."* It counts against the wake
  budget. Records that are `queued`, `parked` or `waiting_machine` never get
  quiet wakes.
- **An open question** is structural, never guessed from text. The ticket
  comment tool gains `awaitsAnswer: boolean`, which stamps the comment's
  metadata. While the latest agent comment on a live record awaits an answer
  and no person event has come since, quiet wakes stop and the hours clock is
  paused. The next person event, whether a comment, a thread message or a
  move, ends the wait and wakes the record as a follow. The facts say: *"Set
  awaitsAnswer when your comment asks the people on the ticket something;
  you will be woken when one of them answers."*
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

- **Executor** (every OS): the signed session summary gains `turn` and
  `lastTurnEndedAt`, and `listAll` emits them — shipped early, in T4, beside
  the other executor facts. The report always includes every session a live
  work record names, even past the newest-first cap of 32 rows (T5).
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
- **As built (T5).** The rules are in
  `docs/standards/ticket-work-machine-access.md` → "A ticket's coding session
  wakes its work". Where the code went another way than the text above:
  - The executor was not changed: the report still stops at 32 rows, and at
    that cap a missing session is unknown rather than closed. A session
    counts as missing only after a report of this machine listed it, so a
    start the report was taken before is never read as a close.
  - The turn a report shows ended is its `turn`, or the one before while a
    turn is `starting` or `working`, so a slow turn wakes when it ends and a
    fast one once. A session present with status `closed` wakes as closed
    too, and every closed session leaves the record's `sessionIds` in the
    heartbeat's transaction.
  - A report is read only for the records pinned to the machine that sent
    it, and only for the sessions under each ticket's own owner key. A
    report without the field is stored with the sessions last known, so a
    close between two reports that have it is still seen.
  - The skip at or below `lastObservedTurn` applies to a turn end
    (`waiting_for_input`) alone: an interruption or a failure always wakes.
    It is checked when the job runs, and again by the agent's own read: a
    wait that sees the turn while its wake still pends behind the run
    withdraws it, the wake given back when nothing else is in the kickoff.
    The skip for a record that is not `active` applies to every status, and
    a session the agent closed itself wakes nobody; each skip writes its
    delivery (`no_longer_applies`). The wake itself never writes
    `lastObservedTurn`: only the agent's own reads do.

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
- **Dequeue** (T5) fires when:
  - a record ends, parks or moves to `waiting_machine`;
  - a session closes;
  - a machine comes online;
  - machine access is re-confirmed;
  - the sweep runs.

  Every such transaction enqueues `ticket-work.sweep` with a short
  idempotency window, so the dispatcher is one idempotent job. The periodic
  sweep, every 60 s, is only the backstop. The dispatcher picks, across every
  policy whose
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
- **A machine that stays offline.** After `waitingMachineHours` (a trigger
  option, default 24), the sweep un-pins the record and returns it to
  `queued`, so another pool machine can take it. The ticket activity says so.
  The dead machine's sessions keep their close requests, which run when it
  reconnects. The new session's brief has to say what was already done; the
  state block carries the pull request, if there is one. With a one-machine
  pool the record simply stays queued, and the chip shows *"waiting for a
  machine"*.
- **As built (T5).** The rules are in
  `docs/standards/ticket-work-machine-access.md` → "A machine that goes away"
  and "The dequeue". Where the code went another way than the text above:
  - A digest that no longer matches at dequeue **suspends** the policy
    (`trigger_changed` or `descriptor_changed`), as the doors that change a
    digest do; its queued records wait for a new confirmation instead of
    being cancelled one by one. The ticket's column (`left_flow`) and its
    mover (`mover_lost_access`) are the record's own re-checks and cancel it.
  - A record that last worked on a machine goes first on that machine, and
    waits for it only while that machine could take it back (online, in the
    pool, held by no other work); otherwise it takes another free machine
    rather than starve, and its sessions on the old one are closed
    (`machine_reassigned`). Its own sessions never count against its quota
    on its own machine. A pickup or a resume that finds a free machine
    queues instead when queued work that could take it is ahead of it. A
    machine whose newest revision awaits review takes no work and suspends
    nothing: its review settles the policy. This one rule replaced T4's
    "waits for its own machine until that machine leaves the pool" (a lead's
    decision), and the record's own machine is T4's `homeMachineOf` (the one
    it holds, else its newest session's).
  - The ticket's work lock is `FOR NO KEY UPDATE`, so a pickup, a resume and
    every wake of live work read their policy under its row's shared lock
    without a cycle with an end that writes the ticket's history.
  - A session the work lets go of — it left the machine, or the agent closed
    it — leaves `session_ids` but keeps its `session_origins` entry: it is
    closed on its own machine and charged by the heartbeat until the machine
    stops reporting it.
  - Positions stay per policy (the chip's "position 2" is the place in its
    own trigger's queue); the dequeue's order is across policies.
  - Every wake while the machine is away starts no run (`machine_offline`),
    not only the first; a wake that finds it back resumes the work first.
    The heartbeat enqueues the sweep, which sends the `machine_back_online`
    wake, rather than a job of its own.
  - `waitingMachineHours` counts from the later of the newest
    `machine_offline` pause and the machine's last heartbeat. The sessions
    left behind get a close reason of their own, `machine_reassigned`, and
    leave the record; unlike every other close request, it is not expired
    after a day, and waits for the machine's report.

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
| `ticketHours` | 4 | `activeMs`; paused while `queued` or `waiting_machine`, and while an open question (`awaitsAnswer`) waits for a person |
| `ticketUsd` | 20 | Coding cost deltas from every status read and review the worker makes, plus the Nessie run cost. Checked at every wake, in the heartbeat intake and in the sweep. A turn already running is bounded by the host profile's required per-turn `maxBudgetUsd`, so a ticket can overshoot `ticketUsd` by at most one turn's budget. The card refuses a `maxBudgetUsd` above `ticketUsd` |
| `startsPerDay` | 20 | Pickups per trigger per day |
| `dailyUsd` | 60 | Per policy per day |
