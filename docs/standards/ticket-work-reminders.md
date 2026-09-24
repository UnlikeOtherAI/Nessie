# Ticket work — reminders, the quiet wake and the sweep (T3)

Authoritative standard, a chapter of [ticket work](ticket-work.md): that file
holds who starts ticket work, whose authority it runs under and who ends it;
this one holds what wakes live work when nothing else will — the reminders an
agent sets itself with `check_back_in`, the open question that stops the
platform from waking work while a person owes an answer, the hours clock, the
quiet wake, and the periodic `ticket-work.sweep`. The design is
[ticket-work.md](../plans/2026-09-23-ticket-driven-agents/ticket-work.md) of the
ticket-driven agents plan; where it and the code differ, the code and this file
win. Every rule here shipped in T3.

## The rules

- **`check_back_in { minutes, note }`** (`CHECK_BACK_IN_TOOL_DEFINITION`,
  handler `worker/src/run/pa-tools/check-back-in.ts`, rules
  `setAgentReminder` in `packages/team-admin/src/agent-reminders.ts`) is on
  for every agent, a `ticket.work` run included. `minutes` is an integer
  schema so the dispatcher's coercion turns "15" into 15; anything else
  outside 5–1440 is refused with the range. It is an `agent_reminders` row,
  never a `schedule_task` trigger, and whose it is comes from the run: a
  `ticket.work` run's belongs to its record, any other to its conversation.
- **In ticket work** a record holds one pending reminder; a new one replaces
  it (`replaced`) under the record's row lock. It fires as the record's
  `reminder` wake through the work seam — a `ticket.work` run counted against
  `wakesPerTicket`, one delivery (`source: reminder`, deduped on
  `reminder:<id>`, its thread row carrying the agent's own note) — and
  ends with the record (`work_ended`). **Parked work takes no reminder**: the
  move that parks a record cancels its pending one (`work_parked`), one that
  comes due on a parked record is cancelled rather than fired, and
  `check_back_in` on a parked ticket is refused — its work waits for the
  people reviewing it, and a person moving it back wakes the agent. The chip's
  Cancel is `DELETE /api/tasks/:taskId/work/reminders/:reminderId`, for a
  board editor only (403 `TICKET_WORK_REMINDER_READ_ONLY` for another reader);
  a cancel writes a `reminder_cancelled` row in the work thread naming who
  (*"Reminder cancelled: Ondrej cancelled the agent's reminder"*) and an audit
  row (`trigger.reminder_cancelled`).
- **Outside ticket work** it wakes the agent in the same conversation **as
  itself**: no effective user, not interactive, purpose `agent.reminder`
  (`AGENT_REMINDER_PURPOSE`, in `DRAINS_ALONE_PURPOSES`, so it never batches
  with a person's message and never re-arms their identity). It is refused in
  a system conversation (a Personal Assistant, Agent Designer or other system
  agent's DM) and while the run speaks for a person in a shared room; at most
  3 of the agent's reminders wait in one conversation and it sets 24 a UTC
  day (`AGENT_REMINDER_CAPS`). One that comes due where the agent can no
  longer wake is cancelled `undeliverable`. A reminder is not a person asking,
  so it never rides a standing send grant (`send-authorization.ts`,
  [Google Workspace](google-workspace.md)).
  **Known gap (T3):** a pending reminder outside ticket work has no screen
  and no Cancel yet. Setting one is visible as the tool call in the run's
  thought process, and its fire as the agent's reply in that conversation,
  but nothing lists what is still pending. The obvious home, the agent
  page's Triggers tab, is read by the agent's managers, and a reminder's note
  is written for its own conversation, whose audience can be narrower; a
  screen therefore needs that conversation's read rule
  (`buildViewerThreadWhere`) and Cancel for those who may manage the agent.
  Until it ships, the caps bound what can be pending: 3 in one conversation,
  24 set a day.
- **Delivery.** The scheduler tick that fires scheduled triggers
  (`worker-sweeps.ts`) calls `sweepDueAgentReminders`
  (`worker/src/control/agent-reminder-fire.ts`); each reminder is claimed
  `FOR UPDATE SKIP LOCKED` inside the transaction that delivers it. **Ticket
  work takes its locks in one order: the ticket (`lockTicketForWork`), the
  thread's run slot (`lockThreadRunSlot`), the work record, a reminder** — a
  pickup takes the ticket then the slot; every wake (`wakeTicketWork`) takes
  the ticket when it settles a move, then the slot, before it writes the
  record; a reminder's claim and a quiet wake's take the slot, then the record,
  then the reminder; teardown takes the ticket then the record, and ending a
  record cancels its reminders after it. A lock taken out of that order can
  deadlock against a wake (`worker/test/db/ticket-work-locks.test.ts`). A
  wake that throws leaves a failed, retryable delivery
  (`reattemptTicketWorkDelivery`) and the reminder fired.
- **The open question** is structural: `ticket_comment_add`'s `awaitsAnswer`
  stamps `awaitsAnswer: true` on the `comment_added` event and sets the
  agent's live records' `awaitingAnswerAt` (`applyTicketWorkAgentComment`,
  in the comment's transaction). **Any comment but an agent's answers it, in
  its own transaction** — a person's, whoever they are, or one a connected
  board brings in (`answerTicketWorkQuestions`) — and names the records it
  answered on its `comment_added` (`answeredWorkIds`), so the dispatcher wakes
  them for it even when their trigger does not follow comments, under the
  origin rule as ever: a board editor's answer wakes the work, anyone else's
  wakes nothing but brings the quiet wake back. A person's thread message or
  move that wakes the record closes it too, and so does a later agent comment
  that asks nothing; a reminder and a quiet wake answer nothing. The kickoff
  says what an answer wakes from the trigger's own follow kinds, and tells the
  agent to set `check_back_in` as well, in case nobody answers.
- **The hours clock.** `activeMs` runs only while a record is `active` with no
  open question: `clockStartedAt` is when it last started, and every
  transition — start, park, resume, end, question opened or closed — folds
  the elapsed time in (`syncTicketWorkClock`,
  `packages/executor-manage/src/ticket-work-clock.ts`, beside the record
  transitions that end work, so a fence ending a policy stops the clock in
  its own transaction). Parked work pauses it too, and so does every machine
  transition that leaves the record anything but `active` — queued, waiting
  for its machine or for access (T4). **(T4)** `ticketHours` is enforced
  against it ([ticket-work-machine-access.md](ticket-work-machine-access.md)).
- **The quiet wake** (`quietWakeMinutes`, default 30): an `active` record
  with no pending reminder, no open question, no run in flight and nothing for
  that long — measured from the later of its last wake and the end of the
  agent's newest run in the work thread — gets a `quiet` wake, *"nothing else
  is scheduled"*, counted, one
  delivery deduped on `quiet:<workId>:<the wake it followed>` and naming that
  wake (`followedWakeAt`), whose claim re-reads all of that — and that no wake
  came since — under the thread's run slot. A retried quiet delivery runs the
  same claim and is settled `no_longer_applies` when it fails. **(T4)** Nor
  is it sent while one of the ticket's own coding sessions is `working`, as
  its machine last reported. Queued, parked
  and waiting-machine records never get one.
- **`ticket-work.sweep`** (`worker/src/control/ticket-work-sweep.ts`) is one
  job a minute, idempotent by its bucket (`enqueueTicketWorkSweep`, started by
  `startTicketWorkSweep`, subscribed beside the ticket dispatch). It reads
  every live record, a page at a time in id order, so no status can crowd
  another out of a window; it sends the
  quiet wakes (`decideTicketWorkSweep`), ends work a lowered `wakesPerTicket`
  left over its wakes (`limit_wakes`, with its `work_ended` row and stop row;
  `startsPerDay` is decided at each pickup, so no live record is over it), and
  recovers a lost job: a `trigger.ticket.dispatch` or
  `ticket-work.thread-message` job the queue dead-lettered in the last day is
  dispatched once more (`recoverLostTicketJobs`) — each dispatcher decides at
  most once per (trigger, event), so a person's move whose worker died still
  starts its work. Once is a claim, not luck: the sweep whose conditional
  update appends `[recovered by ticket-work.sweep]` to the job's own error
  dispatches it, and one that finds the mark skips it. It becomes the pool
  dispatcher in T4 and T5.

## Tests that hold these rules

- `worker/test/db/ticket-work-reminders.test.ts`: coercion, the range
  refusal, replacement, a reminder fired as a counted `ticket.work` wake and
  cancelled with its record, parking cancelling it and a parked ticket
  refusing one, and outside ticket work the wake as the agent,
  `undeliverable`, the system-conversation and presence refusals and both caps.
- `worker/test/db/ticket-work-sweep.test.ts`: the quiet wake only for active
  work with nothing scheduled, measured from the end of the last run; the open
  question pausing it and the clock until a person answers; a lowered limit
  ended; a lost pickup job recovered once, its error kept; one sweep job a
  minute; a quiet retry after a question or a later wake settled; and every
  page of live work read. `worker/test/ticket-work-sweep-decision.test.ts`
  holds the sweep's decision over plain facts.
- `worker/test/db/ticket-work-questions.test.ts`: a board editor's answer
  waking work whose trigger does not follow comments, and a non-editor's
  answer closing the question and bringing the quiet wake back;
  `worker/test/ticket-trigger-decision.test.ts` the decision behind it.
- `worker/test/db/ticket-work-locks.test.ts`: a wake waiting for the run slot
  before it writes the record, so a reminder's claim holding the slot never
  deadlocks against it.
- `worker/test/check-back-in-tool.test.ts`: the tool default-on, withheld
  from no `ticket.work` run, and coerced; the drain-alone test for
  `agent.reminder` (`packages/db/test/thread-serialization-ticket-work.test.ts`);
  `api/test/ticket-work-view-routes.test.ts`'s Cancel, its thread row and its
  audit row; `packages/team-admin/test/trigger-ticket-config-db.test.ts`'s
  quiet wake resolution; `packages/team-admin/test/global-agent-catalogue.test.ts`'s
  Designer facts; and the browser shots (task-dialog 19, agent-triggers'
  quiet wake).
