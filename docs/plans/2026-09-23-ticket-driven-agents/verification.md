# Verification: PRs, tests, and the live run

Each PR lands green through the 10 required CI jobs. Any PR that touches the
admin shell, the board or the documents browser also gets a Browser Suites
run (`gh workflow run browser-suites.yml --ref <branch>`). Every UI change is
screenshotted headless against the worktree's own admin port.

## PR scope and tests

### T0: contracts

Scope:

- `AgentTriggerType` gains `ticket_changed` and `document_changed`, in
  Prisma and in `packages/schemas/src/lifecycle.ts`.
- The `TICKET_WORK_PURPOSE` constant, its entry in `DRAINS_ALONE_PURPOSES`,
  and the empty `ticket.work` arm of `isProjectDelegatedRun`, returning false
  until T1.
- Tables with CHECKs and partial unique indexes: `agent_ticket_work`,
  `executor_standing_policies`, `executor_standing_policy_executors` and
  `agent_reminders`, plus the trigger scope columns.
- Queue payload schemas for `trigger.ticket.dispatch`, `ticket-work.session`,
  `ticket-work.sweep` and `trigger.document.dispatch`.
- The TaskEvent origin shape.
- `docs/standards/ticket-work.md` and its `AGENTS.md` routing sentence.
- The `agent-triggers` browser fixture scaffold. Its three edits (vite input,
  the browser-suites env, the turbo build env) land once, here.

The migration's timestamp sorts after every migration on 3b's branch, so
the two can land in either order.

Tests: migration up/down on the upgrade path; CHECK and partial-index
behaviour.

### T1: ticket triggers

Tests (DB):

- Origin stamping per route (session, token, MCP, agent, source).
- A pickup fires only on a session move by a board editor. An agent move, a
  token move and an agent's create each start nothing.
- Follow kinds each wake. An event authored by an agent or a source does not.
- Re-entry is a follow and never a second pickup.
- `endOn` teardown runs inside the move transaction, including when the
  agent itself made the move.
- A `ticket.work` run acts as the agent, and ticket writes are recorded as
  `agent:<id>`. `kb_page_read` on a private space, `schedule_task` and a
  mailbox tool are each refused.
- A batch that mixes a kickoff and a person message gives no bound
  consumption.
- A thread message from a board editor becomes a follow. One from anyone
  else is refused by the route.
- Delivery rows exist for every skip.
- Webhook prompts are unchanged.
- Field-level config refusals; resolution by name and by category.
- Agent watcher rows migrate to disabled triggers.

Browser: the `agent-triggers` fixture drives the editor over each config
state. Task-dialog shots show the chip in each state. The board card dot and
the column badge. The agent-conversations suite shows the Tickets fold. The
agent-proposal-card suite shows the new rows.

Live check (no machines): move a ticket. The agent comments on it, and the
chip and the thread appear.

### T2: document trigger

Tests: the version hook on every writer, and none on copy or migration; the
quiet-window coalescing; the diff tool's gates and sink records; a ticket
document routed to its work thread; access lost pauses with a health reason.
Browser: the Finder doorway and the row badge.

### T3: reminders and the sweep

Tests: range refusal and coercion; replacement within a ticket; the caps
outside tickets; refusal in system channels; a reminder wake is `ticket.work`
and cancelled with the record; the quiet wake fires only when nothing else is
scheduled; the sweep recovers a lost queued job. Browser: the chip's reminder
row with Cancel.

### T4: machine access (needs 3b on `main`)

It starts with the two pieces that change 3b's code: the coding-session
owner `contextId` (key derivation in `packages/schemas` and in the executor
daemon, on every OS) and the close reasons `ticket_left_flow`,
`policy_ended` and `work_limit`.

Tests (DB):

- Owner-key vectors with and without context, the same on Windows, macOS
  and Linux. A lease-end close leaves a context-owned session untouched.
- Prepare is refused outside the author's own DM and for a non-author.
- The composite card applies assignment, grant, tool enablement and the
  policy atomically under one re-proof.
- Every binding check refuses on its own, with an audit row.
- A digest change on each pinned field suspends. Lowering a limit does not.
- A descriptor review suspends.
- Each fence ends the policy in its transaction.
- A policy ended mid-turn produces `codingSessionClose` on the next
  heartbeat.
- A foreign `sessionId` is refused.
- The pull request is recorded, and `session_review` with a URL works after
  the branch is deleted (executor test on every OS).
- The host-output destination narrowing holds.
- Pool assignment under concurrency: two pickups a second apart get two
  machines, and a third is queued.

Browser: the Machine access section in every state; the executor page's
Standing access panel; the card render.

### T5: session wakes and dequeue

Tests:

- Turn numbers in the report (executor, every OS).
- The intake fires on a fast turn inside one report, on interrupted, on
  failed, and on a missing session. A missing field infers nothing.
- Dedupe with `lastObservedTurn`.
- Dequeue across policies follows priority, then age, and re-checks the
  ticket, the mover and the policy.
- Waiting-machine and back-online.

### T6: project operator

Tests:

- The arm is admitted only on a live-requester run, and refused on trigger,
  scheduled and ticket-work runs.
- Each verb acts as the requester and is refused beyond their rights.
- Workflow tools are flagged, and the migration grants them explicitly.
- A trigger the agent creates shows "Machine access: not set up" and raises
  the attention item.

## The live acceptance run

It is done **as a developer, through the UI only**, on a fresh database.
Nothing is seeded or configured behind the UI's back. The model is
`meta/muse-spark-1.3-contributor` through a 24 h Ledger key minted for the
run and revoked at the end. The machines are this PC and the Mac, each paired
as a private executor with a reviewed coding-sessions configuration that
allows push, PR creation, checks and merge. GUI apps open in small windows,
and nothing is left running that the run did not start.

1. Bootstrap the owner account. Create a team and the project "Nessie".
2. In the Designer DM, ask for the CTO in one message, the example above.
   Check four things:
   - The proposal card shows "Starts work when" and "Runs on".
   - There is no new channel unless asked.
   - The trigger is created with resolved columns shown as links.
   - One machine-access card arrives, lists both machines, the host profile
     and who can start work, and applies under one re-proof.
3. Create three small real tickets on the Nessie board.
4. Move ticket 1 to In progress. The chip reads "working". A Claude Code
   session starts on one machine with a brief. The CTO ends its turn, and the
   next wake follows the session's turn end.
5. Move ticket 2. It goes to the other machine. Move ticket 3: it queues, the
   CTO comments per its instructions, and the chip shows the position.
6. Mid-work on ticket 1, add a comment with new information. A follow wake
   row appears, the CTO sends it to Claude, and the send is visible in the
   thought process.
7. Edit ticket 1's spec document. A `document_changed` wake lands in its
   thread and is relayed.
8. Watch a stalled wait: the CTO sets `check_back_in`, the chip shows it,
   and it fires.
9. Ticket 1's PR merges green. The CTO moves the ticket to Done, the
   sessions close and ticket 3 dequeues onto the freed machine.
10. Negative checks:
    - An agent's move starts nothing.
    - A second account that cannot edit the board cannot write in the work
      thread.
    - Editing the trigger's instructions suspends machine access until it is
      re-confirmed.
11. End: end the policy on the executor page and confirm the sessions close.
    Revoke the Ledger key, stop the servers and daemons, and write
    `docs/testing/ticket-driven-agents-<date>.md` with every hiccup, its time
    and its evidence.

Pass criteria:

- The CTO never edits code itself.
- Each ticket has one session, a brief with a goal and acceptance criteria,
  and a recorded pull request before Done.
- No run is aborted by timing, and nothing is stopped by the loop detector.
- Every wake has a visible reason on the ticket or in the thread.
