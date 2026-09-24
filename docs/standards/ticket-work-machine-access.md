# Ticket work — standing machine access

Part of the ticket-work standard: [ticket-work.md](ticket-work.md) is the
rule for everything else a ticket's work does, and its tags — (T4), (T5) —
mean what they mean there. This file holds the machine owner's
authority: who may give a trigger's work their machines, what they agree to,
and what the platform does with that consent. The design is
[machine-access.md](../plans/2026-09-23-ticket-driven-agents/machine-access.md);
where it and the code differ, the code and this file win.

## The machine owner's authority is read only by the standing-policy binder (T4)

- **The author is never in the run's actor context.** A `ticket.work` run acts
  as its agent. The policy travels on the bindings the binder makes
  (`executor_bindings.standing_policy_id` and `ticket_work_id`, never beside a
  lease: `executor_bindings_one_authority`), not in `actionContext`, and only
  `bindStandingPolicyExecutor`
  (`packages/executor-manage/src/executor-standing-policy-binding.ts`) and the
  dispatch fence `assertStandingPolicyBindingCurrent`
  (`executor-standing-policy-fence.ts`, called from
  `assertExecutorCommandBindingCurrent`) read the author. No tool, gate or
  disclosure check may treat them as "act as this person".
- **Every wake with an `active` record and a pinned machine is bound afresh**,
  from run setup (`bindTicketWorkMachine`, `worker/src/run/execute/ticket-work-setup.ts`),
  after seven checks, each its own refusal
  (`executor-standing-policy-binding-checks.ts`): `policy_not_live` — the
  policy is `live` and names this trigger, agent and machine;
  `terms_changed` — the live trigger digests to `triggerDigest` and the
  machine to its pinned digests; `author_unavailable` — the origin captured at
  confirm verifies (its team still holds the author), UOA answers live
  (`resolveLiveEntitlementDecision`, failing closed on `denied` and
  `unavailable`, never from a cache), and the author can still edit the board
  (team-admin's `canMemberEditProjectBoards`, handed in with UOA's live role);
  `machine_unavailable` — online, private, paired by the author, the agent's
  assignment and both grants; `channel_unavailable` — the target channel is
  live, standard, public, of the ticket's project, with the agent bound, and
  the run is in the work thread; `not_this_work` — the job acts as the agent
  for this record and every message it consumes is this record's kickoff;
  `limit_reached` — within its limits (and a record over one is stopped
  there). Then a fresh candidate is resolved for the author, pinned to that
  machine, and bound through the ordinary binder with `standing:
  { kickoffMessageId }` in place of the trigger-author check — the grants,
  revision and scope are re-checked under the executor lock, and so are the
  policy and the record — and the bindings name the policy and the record.
- **A refusal is an outcome, never a throw.** It writes
  `executor.run.policy_refused` (`outcome: denied`, the reason) and a
  skipped delivery on the trigger (`source: 'binding'`, deduped
  `binding:<runId>`, its payload `TicketTriggerBindingRefusalPayloadSchema` —
  `{ kind: 'standing_policy_refused', reason, runId, taskId, workId }` — and
  its error message the people's sentence, `standingPolicyRefusalSentence`:
  *"Ran without a machine: the machine was offline or no longer offers its
  coding tools."*), and the run goes on with no machine: the reach facts say
  `standing_refused` with the run's own sentence
  (`STANDING_POLICY_REFUSAL_SENTENCES`), the Triggers page renders the
  delivery with the people's (`ticketDeliveryLine`), and the ticket's chip
  record carries it too (`machineRefusal`, from `loadTaskTicketWork`, beside a
  queued record's `queuePosition`) until a later wake. None names the
  machine.
- **The dispatch fence** re-checks every command a standing binding creates or
  the daemon collects: the policy `live` with this machine in its pool and the
  candidate's author and agent; the record `active`, pinned to this machine
  under this policy; the run in its thread. It replaces the trigger-author
  check — the kickoff is the platform's — and names the owner's context, so a
  policy that ends mid-turn fences its bindings at once.
- **The reach facts of a standing bind** read as `bound`
  (`executor-reach-facts.ts`) with no machine label — the work thread is a
  public room, and the DM-only naming rule never names a machine there — and
  list only the sessions under the ticket's own owner key.
- **(T4) A ticket's coding sessions are their own owner.** The coding-session
  owner carries `contextId: ticket:<policyId>:<taskId>`, hashed into the owner
  key by `executorCodingSessionOwnerKeyInput` and by the daemon alike, so the
  author's own DM sessions with the agent, and every other ticket's, are
  neither listed nor reached, a lease's owner-wide close never touches it, and
  each ticket has its own `maxLiveSessionsPerOwner`. Without a context the key
  is unchanged. The API admits a context only when the binding pins that same
  one: the fence derives it from the binding's policy and record, never from
  the payload.
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
- **(T4) Limits and digests.** Lowering a limit is the one edit of a pinned
  field that does not suspend the policy: the edit moves the policy's
  `pinned_terms` down and recomputes `triggerDigest` in the same transaction
  (`executor.policy.limits_lowered`), so binding check 2 still matches.
  Raising one takes a new prepare and a new card. **(T4)** `dailyUsd` is per
  policy per UTC day, while `AgentTicketWork.costUsd` is a record's lifetime
  total and cannot be split across midnight, so every addition to a record's
  cost also goes to `executor_standing_policy_daily_spend` (primary key
  `(policy_id, day)`, `cost_usd >= 0`), in the same transaction
  (`addTicketWorkCostInTransaction`).

## Standing machine access is one confirmed card (T4)

- **Only the trigger's author prepares it, for their own machines.**
  `prepareStandingPolicy` (`packages/team-admin/src/standing-policy-prepare.ts`)
  acts for the trigger's `config.authorUserId` alone — `loadStandingPolicyTrigger`
  refuses anyone else by name (*"Only Ondrej, who set this trigger up, can set
  up machine access for it… Ask Ondrej to set it up…"*), an organisation
  owner included, because a preparer would learn the author's private machines
  and the work would run as the author. The trigger must be an enabled ticket
  trigger with start-work columns and instructions, on a board the author can
  still edit (`canMemberEditProjectBoards`). Two doors, both answering
  `StandingPolicyRefusal` in plain words: `POST
  /api/triggers/:triggerId/machine-access` (author-only, not the owner-only
  Triggers gate; 400 `MACHINE_ACCESS_REFUSED` with `details.machines`), and
  `executor_standing_policy_prepare`, a `personalAssistantOnly` tool the
  Designer holds through its identity set, accepted only on the requester's
  own interactive turn in their own Designer or Personal Assistant DM
  (`worker/src/run/pa-tools/provisioning-standing-policy.ts`). A designed
  agent, the CTO included, has no prepare tool.
- **Each machine is refused with its reason, or nothing is prepared.**
  `assessStandingPolicyMachine`
  (`packages/executor-manage/src/executor-standing-policy-machines.ts`, reasons
  `StandingPolicyMachineRefusalSchema`): private, paired by the author, still
  administered by them, a live reviewed revision offering the local-apps pair
  and the coding bridge, online at prepare, a signed Claude Code per-turn
  budget at most `ticketUsd` (Codex's is always `null`, so a Codex-only
  machine is refused, and so is a descriptor too old to state it), no
  `bypassPermissions` unless the author chose *"Let the coding agent run any
  command without asking."*, and every allowed root. The Designer's executor
  facts carry `pairedByYou` and `codingSessionsReviewed` and say "ticket work:
  yes / not yet / no" per machine.
- **What is pinned.** The host profile (`StandingPolicyHostProfileSchema`):
  the coding agents a start may use, `allowAnyCommand`, `allowedRootNames`
  (default: the roots every pool machine shares) and per machine its
  permission mode, turn budget, session quota and `mergeCommands`. The terms
  (`StandingPolicyPinnedTermsSchema`, column `pinned_terms`): agent, target
  channel, board, start-work columns, `assignOnPickup`, follow kinds,
  `includeSourceEvents`, end columns, every instructions section verbatim, and
  every limit — the trigger's `wakesPerTicket` and `startsPerDay` and the
  policy's own `ticketHours`, `ticketUsd` and `dailyUsd`
  (`StandingPolicyLimitsSchema`, 4 h, $20 and $60 by default), which live on
  the policy, not the trigger. `triggerDigest` is `standingPolicyTermsDigest`
  of exactly those terms. Each pool row pins the bridge's `configDigest` and
  the revision's `localPolicyDigest`.
- **Prepare writes a card, not access.** A `preparing` policy with its pool,
  and one executor access-change continuation (`kind: 'standing_policy'`) on
  the first machine that pins every machine's `authorizationRevision`. A new
  prepare ends the card still out (`replaced`), expires its continuation and
  closes its card. The card is the one described in
  [agent cards](agent-cards.md) → "A standing policy's card is the one
  composite review", with what changed since the policy it replaces.
- **One confirmation applies everything, or nothing.** The card's Review, or
  the section, confirms through `POST /api/executor-access-changes/:id/confirm`
  with the author's password; its `applyPolicy` is
  `applyExecutorAccessChangeEffects` (`packages/team-admin/src/executor-access-change-effects.ts`),
  which runs `confirmStandingPolicyInTransaction`
  (`standing-policy-confirm.ts`) inside the continuation's own transaction.
  It re-checks the trigger digest, every machine and its digests and
  revision, and the author's session origin, refusing stale on any
  difference; then per machine the agent's private assignment, the
  whole-suite grant and the executor tools in its tool policy; then ends the
  policy it replaces — handing its live records over, their sessions closed
  (`policy_ended`), since the old owner context is never bound again — and
  goes `live` with `confirmedAt` and `authorOrigin`
  (`captureScheduledLaunchOrigin`), queueing every record of the trigger that
  waited for machine access. A failure anywhere rolls all of it back with the
  continuation's claim. `confirmExecutorAccessChange` refuses a
  `standing_policy` change without its service, and the generic prepare
  refuses to make one. A rejected card ends its policy (`person`).
- **Audit, in each transaction:** `executor.policy.prepared` (pool, limits,
  host profile, digest), `executor.policy.confirmed` (digests, pool, limits,
  host profile, the policy it replaced, how many records it queued),
  `executor.policy.suspended` (reason and what changed),
  `executor.policy.ended` (reason and who) and `executor.policy.limits_lowered`.

## A machine is assigned at dispatch, never in run setup (T4)

- **A record that needs a machine is placed in one transaction**
  (`placeTicketWorkOnMachineInTransaction`,
  `packages/executor-manage/src/executor-standing-policy-pool.ts`, called by
  the worker's `placeTicketWorkForWake`, `worker/src/control/ticket-work-machine.ts`):
  a pickup, and a person's move that resumes parked work. It locks the
  trigger's binding policy's pool rows (`FOR UPDATE`), then each pool machine
  under its own advisory lock in id order, because a machine can sit in two
  triggers' pools; the record's previous machine is tried first. The first
  machine that is online (a fresh heartbeat), held by no other record in
  `TICKET_WORK_MACHINE_HOLDING_STATUSES` and below its pinned
  `maxLiveSessionsPerOwner` for this ticket's own owner key in its last
  report takes it: `executorId`, `policyId`, `active`.
- **(T5) A free machine goes to the line first.** A pickup or a resume that
  finds a pool machine free, and that is not the record's own last machine,
  queues instead when queued work of any live policy sharing that machine is
  ahead of it in the one order and could take it — work whose own last
  machine could take it back (online, in its pool, held by nobody) waits for
  that one, as the dequeue decides (`queuedTicketWorkOutranks`) — and enqueues
  the dispatcher; an urgent ticket ahead of the whole line still takes it at
  once. A record that goes to another machine than its last closes the
  sessions it has there (`machine_reassigned`) and forgets them; one left
  waiting for access, unpinned, closes them for the policy's reason.
  Coming back to its own machine, the record's own sessions there never count
  against its quota; on any other, the quota counts the sessions the bridge
  counts as live — never a `closed` or `failed` one.
- **Nothing free: the record is queued** (`queueTicketWorkInTransaction`) with
  `queued_no_free_machine`, or `queued_machines_offline` when every pool
  machine is offline, its `enqueuedAt`, and a `queuePosition` among the
  policy's queue by ticket priority, then age, then id
  (`executor-standing-policy-queue.ts`). **(T5)** Every change to a queue
  renumbers it (`renumberTicketWorkQueueInTransaction`): a record joining,
  placed, parked, ended or handed over, and a queued ticket's priority
  changing — `updateProjectTask` and a board source's apply, which wake
  nothing. A record leaving the queue clears its own place as it leaves.
  Renumbering takes a per-policy lock (`lockTicketWorkQueue`) and never
  waits for a row: it writes only the places that changed, on rows no other
  transaction holds (`FOR UPDATE SKIP LOCKED`), so it closes no cycle with a
  transaction that holds a record and wants the lock; a skipped row gets its
  place from the next renumbering, and the dequeue renumbers every queue it
  reads. The ticket gets `work_started` and `work_queued`
  rows, the chain `ticket.work.started` and `ticket.work.queued`, and the work
  one short unbound wake with reason `queued`, whose text gives its place and
  how many machines are busy or offline — never which — and whose
  instructions are `onQueued`.
- **No policy, or a suspended one:** the record waits for machine access
  (`waiting_machine`, `machine_access_not_set_up` or
  `machine_access_suspended`, pinned to nothing), and its one wake is the
  ordinary pickup wake, unbound, saying so.
- **Confirming, re-confirming and a hand-over queue the waiting records the
  same way** — reason, place, a `work_queued` row, `ticket.work.queued` — and
  every transaction that may free a machine (a record ending, parking or
  waiting, a suspension, an end, a confirmation, a limit, **(T5)** a session
  closing, a machine back online, work moved off one that stayed away)
  enqueues `ticket-work.sweep` with a ten-second idempotency bucket
  (`enqueueTicketWorkSweep`, key `ticket-work.sweep:machines:<bucket>`,
  `machinesOnly`); that sweep runs the machine steps alone and dequeues onto
  the freed machine (below, "The dequeue").
- **A pinned machine offline when a wake comes starts no model run**
  (`holdTicketWorkBeforeWake`): the record goes to `waiting_machine` with
  `machine_offline`, keeping its machine's slot, with a `work_paused` row, and
  the delivery is skipped `machine_offline`. **(T5)** Every later wake while
  the machine stays away skips the same way; one that finds it back resumes
  the work on it first (below, "A machine that goes away").

## A ticket's coding tools are the ticket's own (T4)

A `ticket.work` run the binder bound gets the coding tools of its ticket
(`worker/src/run/ticket-work-coding-sessions.ts`, wrapping the ordinary
`createExecutorCodingSessions` through `buildExecutorToolset`'s `ticketWork`):

- **Coding sessions, and no other program.** The author's card consented to
  Claude Code sessions on these machines — it says *"The agent may drive
  Claude Code sessions on these machines; it gets no other program on
  them."* (`STANDING_POLICY_CODING_ONLY_SENTENCE`) — not to the machine's
  other reviewed programs. So a standing-bound run is offered the
  `coding_session_*` tools alone: the generic `executor_mcp_tools` /
  `executor_mcp_call` pair is not in its toolset whatever the agent's tool
  policy grants, a call to it anyway is refused as correctable, and its reach
  facts say so. On the server, `standingProgramRefusal`
  (`executor-standing-policy-fence.ts`, called from
  `assertExecutorMcpCallPayload` as a command is created and again as the
  daemon collects it) refuses a standing binding's `mcp.tools` listing and any
  `mcp.call` to a server other than the reviewed coding-sessions bridge. The
  binder still pins the local-apps pair as one bundle; the coding tools ride
  its `mcp.call` binding.
- **Its sessions are the record's.** A `sessionId` not in `sessionIds` is
  refused (*"That session is not this ticket's."*); `sessionId` is optional,
  and defaults to the one session the machine's last report lists open under
  the ticket's owner key; none, or more than one, is said. A start whose
  answer was lost is taken back onto the record from the next report by its
  title under that owner key — never one that reports itself closed (T5).
- **A start is the ticket's:** its title is forced to the ticket's own
  (`ticketWorkThreadTitle`), only the pinned coding agents (Claude Code) and
  `allowedRootNames` are offered and accepted — and the API refuses any other
  start on a standing binding before a command exists (`standingStartRefusal`,
  from `assertExecutorMcpCallPayload`) — and the session it returns is
  appended to the record as it answers (`appendTicketWorkSession`).
- **Each tool says what it is for in ticket work** (start, send and wait
  texts from the plan, `ticketWorkCodingDescriptors`), a wait reads for at
  most a minute (`TICKET_WORK_CODING_WAIT_TIMING`), and it gives way when a
  wake for the same record is pending behind the run (`codingWaitRunChecks`'
  `ticketWorkId`).
- **What every answer says lands on the record in the same step**
  (`ticketWorkCodingObserver`,
  `packages/executor-manage/src/ticket-work-session-observations.ts`): the
  cost since the last read, from the status' cumulative `totalCostUsd`
  (`session_costs`); the newest ended turn (`lastObservedTurn`); and a
  review's pull request. **(T5)** It writes under the thread's run slot, the
  lock every wake is written under, and a turn end it sees withdraws the
  same session's turn-ended wakes at or below it still pending in the thread
  (`withdrawSeenSessionWakes`, `worker/src/control/ticket-work-session-withdraw.ts`):
  each delivery is written skipped `no_longer_applies`, its `woken` row
  leaves the thread, and a kickoff left with nothing goes whole, its wake
  given back to `wakesPerTicket`. The agent's own `coding_session_close`
  takes the session off the record and keeps it under
  `lastObservedTurn.closed`, so its close wakes nobody.

## Server-side closes, limits and spend (T4)

- **Session-scoped close requests for the record's sessions**, by the
  ticket's owner key, in the transaction of: a move into an `endOn` column or
  off the board (`ticket_left_flow`: `applyTicketWorkColumnEntry`,
  `applyTicketWorkLeftBoard`, the worker's end-wake settle), a limit
  (`work_limit`), the trigger switched off or deleted (`trigger_changed`), a
  suspension (`policy_suspended`, which also unpins the record) and an end
  (`policy_ended`, a hand-over's parked records included), and **(T5)** work
  that leaves the machine its sessions run on — moved off one that stayed
  away, or placed on another by a resume or the dequeue (`machine_reassigned`,
  on that machine, for when it reconnects) — and queued work cancelled
  because its mover lost the board (`mover_lost_access`). Never an owner-wide
  close for ticket work. The next heartbeat carries them. A record that
  leaves the machine — unpinned or pinned elsewhere — also forgets those
  sessions (`releaseTicketWorkSessionsInTransaction`,
  `ticket-work-session-release.ts`), so no report of that machine wakes it
  for them. A close request is settled after a day
  (`EXECUTOR_CODING_SESSION_CLOSE_TTL_MS`) except `machine_reassigned`, which
  waits for a report of its machine that shows it done however long the
  machine is away.
- **Limits are the policy's** (`executor-standing-policy-limits.ts`):
  `ticketHours` against the record's hours clock (`ticketWorkActiveMs`,
  `ticket-work-clock.ts`), which runs only while the record is `active` with
  no open question, so time queued, waiting for a machine or for access,
  parked, or waiting for a person's answer is never counted — every pool
  transition (assigned, queued, waiting, suspended, offline) syncs it in its
  own transaction; `ticketUsd` against
  `costUsd`, which every coding cost delta and each `ticket.work` run's own
  ledger cost add to (`recordTicketWorkRunCost`, once per run, from
  completion, failure and cancel); `dailyUsd` against the day's spend row.
  They are checked when a wake is decided (`holdTicketWorkBeforeWake`), by the
  binder, and in the heartbeat intake (`reportExecutorHeartbeat`, for records
  active on that machine, so the close rides the same answer);
  and by the sweep for work nobody wakes
  (`enforceTicketWorkLimitsInTransaction`). Over one, the record fails with `limit_hours` or `limit_cost` —
  `dailyUsd` too, with its own sentence, because T1 gave `limit_daily` to the
  trigger's `startsPerDay` — a `work_ended` row, a "Stopped" thread row, and
  its closes; a wake it would have been is skipped with that reason.

## Fences end the policy in their own transaction (T4)

Ending a policy (`endStandingPolicyInTransaction`) cancels its live records
(`machine_access_ended`), closes their sessions by id, and writes
`executor.policy.ended` with the reason and who; a card still out ends too.

- **The machine** (`endStandingPoliciesForExecutorInTransaction`,
  `executor-standing-policy-fences.ts`), at the conversation-lease fences'
  call sites: pause, drain and revoke (`transitionExecutorLifecycleInTransaction`,
  and a pairing closed on the machine, `revokePairingExecutor`); the author's
  place on its roster or the agent's access withdrawn (`access_revoked`, from
  `endLeasesForRevokedAccess` — the agent's own owner-wide close carries no
  ticket context, so this is what reaches a ticket's sessions); a review that
  leaves it without the local-apps pair or a reviewed coding bridge
  (`descriptor_narrowed`; one that keeps both but changes a digest suspends).
- **The board's side** (`packages/team-admin/src/standing-policy-fences.ts`):
  the author no longer able to edit the board (`author_lost_access`: the
  project-member removal route, an organisation role change, UOA no longer
  asserting their team in `reconcileUoaMembershipProjection`) or deactivated
  (`author_deactivated`: `setOrganizationMemberDeactivated`, UOA's
  reconciliation); the agent unbound from the target channel
  (`agent_unbound`, `unbindAgentFromChannel`); the target channel archived,
  deleted or made protected (`target_channel_unavailable`); the project, a
  board or a start-work column deleted (`scope_archived`, before the delete
  that nulls the trigger's scope); and the author no longer listed by UOA
  (`author_left_organization`), found by the sweep, below.

## The sweep's machine half (T4, T5)

`ticket-work.sweep` (T3's periodic job, and every enqueue a transaction that
may free a machine makes) runs `sweepStandingMachineAccess`
(`worker/src/control/ticket-work-sweep-machines.ts`) after its record pages,
each step on its own so one failing never keeps the others from running.
**(T5)** A sweep a transaction enqueued (`machinesOnly`) runs only the last
three — a machine back, gone too long, the dequeue — and none of the record
pages, lost-job recovery or UOA re-checks, which stay the minute's tick's, so
a busy minute never multiplies them:

- **Authors UOA no longer lists** (`endPoliciesOfDepartedAuthors`). UOA has
  no removal feed, so each author of a preparing, live or suspended policy
  is asked again (`resolveLiveEntitlementDecision`, with the identity
  captured at confirmation, the stored link allowed). An answer that does
  not list them — or no identity to ask with — ends every such policy of
  theirs (`author_left_organization`), its records cancelled and its
  sessions closed, with `executor.policy.ended`, in one transaction. An
  outage ends nothing: the binder refuses every wake meanwhile
  (`author_unavailable`), failing closed on its own.
- **Limits on work nobody wakes** (`enforceLimitsOnLiveWork`): every live
  record under a policy, fifty to a transaction, against its hours clock
  and spend, exactly as a wake and the heartbeat intake check them.
- **(T5) A machine back, or gone too long** (`resumeWorkWhoseMachineIsBack`,
  `requeueWorkStrandedOffline`; below, "A machine that goes away").
- **(T5) The dequeue** (`dequeueTicketWork`; below, "The dequeue"), which
  replaced T4's first-free placement in each policy's own queue order.
- **The quiet wake waits for a working session.** T3's quiet wake is not
  sent while one of the ticket's own coding sessions is `working` in its
  machine's last report (`ticketSessionWorking`): the coding agent's turn
  ending wakes the agent instead (T5, below).

## A ticket's coding session wakes its work (T5)

- **The intake is the heartbeat's** (`intakeTicketWorkHeartbeatInTransaction`,
  `packages/executor-manage/src/ticket-work-session-intake.ts`, called from
  `reportExecutorHeartbeat` after the limits, in the transaction that holds
  the machine's connection lock, so two reports of one machine are never
  compared at once). A report speaks only for the machine that signed it: it
  is read for the live records pinned to that machine in its organisation,
  and for each only the sessions listed under the ticket's own owner key
  (`executorCodingSessionOwnerKey` of the machine, the policy's author, the
  agent and `ticket:<policyId>:<taskId>`) — another machine's report naming a
  record's session, or a session under any other owner, wakes and closes
  nothing. It compares the stored report with the new one for the
  sessions a live record names (`sessionIds`) and enqueues
  `ticket-work.session`, idempotent on `session:<id>:<turn>:<status>`, when
  the turn went up and the session is not `starting` or `working` — the turn
  a report shows ended is its `turn`, or the one before while a turn runs, so
  a fast turn inside one report (`waiting_for_input` turn 3, then turn 4)
  wakes once, and a slow one (`working` turn 4, then `waiting_for_input`
  turn 4) too; when it entered `interrupted` or `failed`, with the report's
  categorical `reason`; or when it closed — `closed` in the report, or gone
  from a report that has the field having been in the previous one. A report
  at `EXECUTOR_CODING_SESSION_REPORT_MAXIMUM` rows proves nothing by what it
  leaves out, so there a missing session is unknown, not closed; a report
  without the field, or no report, infers nothing — and is stored with the
  sessions the last report that had the field listed
  (`withLastKnownCodingSessions`), so the next report is compared with what
  was last known and a close in between is still seen; a session no report of
  this machine ever listed is a start the report was taken before, not a
  close. A session first listed with no previous summary counts from the
  turn the agent last saw end (`lastObservedTurn`). The executor still caps
  its list at 32 rows: the plan's "every named session even past the cap" is
  not built.
- **A closed session leaves the record's live set at once** (`array_remove`
  on `session_ids`, never a read-then-write), so the next kickoff's state
  block, the coding tools and teardown's closes never name it, and the
  dispatcher is enqueued: the ticket's session quota has room again.
- **The wake** (`dispatchTicketWorkSession`, `worker/src/control/ticket-work-session-wake.ts`,
  subscribed in `worker-subscriptions-integrations.ts`) goes through the
  ticket-work seam — limits, machine, target channel, `wakesPerTicket` — with
  `session_turn_ended`, `session_interrupted`, `session_failed` or
  `session_closed` and one line (*"the coding session's turn 4 ended"*,
  *"…was interrupted: max_turn_minutes"*), and a kickoff that says what the
  status means for the next step (the plan's glossary: `max_turn_minutes` →
  send "continue", `host_lost` → "continue where you left off", `failed` → a
  new session whose brief says what was done). One delivery per job
  (`source: 'session'`, its payload naming the `session`), skipped
  `no_longer_applies` — and said so on the Triggers page, in words that
  follow the status — when the record is not `active` (parked, queued,
  waiting or ended), when a turn-ended wake's turn or a later one was seen
  to end by a wait or review of the agent's own (`lastObservedTurn`), and
  when a closed session is one the agent closed itself
  (`lastObservedTurn.closed`); an interruption or a failure always wakes. All
  of it is read under the thread's run slot, and a wait that sees the turn
  while its wake still pends behind that run withdraws the wake (above, "A
  ticket's coding tools are the ticket's own"); a trigger off or in error
  skips it `trigger_disabled`.
  Nothing the session said reaches the wake. A failed delivery is retried
  from its payload (`reattemptTicketWorkDelivery`), and a job the queue gave
  up on is dispatched once more by the sweep's lost-job recovery.
- **Every live kickoff with a machine promises it**: *"…and when this
  ticket's coding session ends a turn, is interrupted, fails or closes."*

## A machine that goes away (T5)

- **Back online.** The machine's heartbeat enqueues the sweep while a record
  waits for it (`waiting_machine`, `machine_offline`), and a heartbeat or a
  claim that finds it had gone offline enqueues it when a live queue waits on
  its pools (`enqueueTicketWorkForMachineInTransaction`). The sweep resumes
  such work on it (`resumeTicketWorkOnItsMachineInTransaction`, under the
  policy's row, shared, then the ticket's lock and the thread's run slot —
  so a suspension or an end waits for the resume that read the policy live):
  `active`, its hours clock
  running, a `work_resumed` row with `previousReason: machine_offline`, a
  delivered `machine` delivery and one `machine_back_online` wake bound to
  it — after its limits, as at any wake. Machine access paused meanwhile:
  the work waits for access instead, unpinned, its sessions there closed
  (`policy_suspended`), with no wake. Handed to a policy whose pool does not
  name the machine (a confirmation that replaced it with other machines): it
  is queued for one that does, as below, since the binder would never bind
  it there. A person's wake that finds the machine back resumes the work the
  same way first. Only work of a trigger that is on and not in error counts
  — for the heartbeat's enqueue as for the sweep — so a trigger in error
  never makes every heartbeat enqueue a sweep.
- **Gone too long.** Past the trigger's `waitingMachineHours` (default 24,
  1–168, in the editor beside the limits; not a pinned term) measured from
  the later of the work's newest `machine_offline` pause and the machine's
  last heartbeat, the sweep takes the work off it
  (`requeueStrandedTicketWorkInTransaction`): its sessions there get
  `machine_reassigned` closes on that machine and leave the record, it is
  unpinned and queued under its policy as of when it started (ahead of
  tickets that never began), with a `work_queued` row whose
  `previousReason` is `machine_offline` and `ticket.work.queued`
  (`requeuedFrom`). The dequeue then places it on another machine with a
  wake that says its session is gone and a new one's brief must say what was
  done. With a one-machine pool it simply stays queued.
- **What it reads as.** The chip says *"Paused: the machine is offline since
  14:32. Work resumes when it reconnects."* (`machineOfflineSince`, the
  machine's last heartbeat, never its name), its history *"resumed the work:
  its machine is back online"* and *"queued the work for another machine,
  because its machine stayed offline"*; the Machine access section *"paused:
  Studio is offline since 14:32"* (the label only for its author and
  administrators).

## The dequeue (T5)

`dequeueTicketWork` (`worker/src/control/ticket-work-dequeue.ts`), the sweep's
last machine step and so the pool dispatcher every freeing transaction wakes:

- **Policies first.** Each live policy with queued work and its trigger on is
  checked against what its author confirmed (`standingPolicyDigestCheck`): a
  trigger whose terms moved, or a pool machine whose newest revision is
  active with digests other than the pinned ones (or no reviewed bridge),
  suspends it (`trigger_changed`, `descriptor_changed`) exactly as the doors
  that change them do, and none of its records is placed or cancelled — they
  wait for a new confirmation, as a suspension's queued records do. A pool
  machine whose newest revision awaits review, or was disabled, suspends
  nothing: the review door settles the policy when the revision is reviewed,
  and until then the dequeue places none of the policy's work on that
  machine.
- **The queue belongs to the machine.** For each machine of those pools, in
  id order, the queued records of every live policy whose pool includes it
  are read in one order: a record that last worked on this machine first
  (its sessions are there, and never count against its quota there), then
  priority, then age, then id. A record that last worked on another machine
  of its pool waits for that one only while it could take it back — online,
  in its pool, reviewed, held by no other work; otherwise it takes this one
  rather than starve, and its sessions on the old machine are closed
  (`machine_reassigned`) and forgotten.
- **Each placement re-checks the record** under the locks every wake of it
  takes, after the policy's own row (`dequeueOnto`: the policy row shared, so
  a suspension or an end in flight is read, never raced; then the ticket, the
  thread's run slot, and — inside `placeTicketWorkOnExecutorInTransaction`,
  which reads the policy live only under that row — the pool and the
  machine): still `queued` under the same policy; its ticket still in a
  start-work column, else cancelled `left_flow`; the person whose move
  started it still a live member who can edit the board
  (`canMemberEditProjectBoards`), else cancelled `mover_lost_access`. A
  cancel writes `work_ended`, a stop row in the thread and closes any
  sessions for its own reason (`ticket_left_flow`, `mover_lost_access`); the
  next record is tried. Placed: `active` with a `work_resumed`
  row, `ticket.work.started` (`dequeued: true`), a delivered `dequeue`
  delivery and one `dequeued` wake, *"a machine is free; you are bound to
  it"*. A machine another record holds, or offline, takes nobody this round;
  one at this ticket's own session quota lets the next record try.
- **Never two records on one machine.** Two sweeps racing serialise on the
  ticket and the machine's lock; the loser re-reads the record placed, or
  the machine held. `agent_ticket_work_one_per_executor` holds whatever else
  writes.

## What the screens show (T4)

Every screen names a machine only to its author and the people who
administer it; everyone else reads states and counts.

- **The trigger's Machine access section** (`MachineAccessSection`, on a
  ticket trigger's page; `GET /api/triggers/:triggerId/machine-access`, for
  owners and the author — anyone else is "not found"): the state (not set
  up, awaiting confirmation, live, suspended with its reason, ended with its
  reason and by whom) in one sentence, the policy's limits, that the agent
  drives Claude Code sessions and no other program, every live ticket of the
  trigger with its place (working — on which machine, for those who may
  know — queued with its position, paused for an offline machine, waiting
  for access, parked), and the last wakes in the words the deliveries say
  them. The author gets **Set up machine access…**
  (`MachineAccessSetupDialog`, reading `GET …/machine-access/machines`: their
  own private machines, each refused with its reason when no choice can fix
  it, and re-checked in the form as they change the "run any command" tick,
  `ticketUsd` against each machine's per-turn budget, and the coding folders
  every chosen machine shares), which prepares the one card through the
  author-only route and shows it in the section, where **Review and
  confirm** opens the same access-change review the chat card opens, with
  the password. The author, or an administrator of one of its machines, gets
  **End** (`POST /api/standing-policies/:policyId/end`, reason `person`).
  Anyone else reads *"Only Ondrej can set this up: the work would run on
  their own machines, as them."* The bell item T6 raises for a trigger an
  agent set up opens this section (`#machine-access`).
- **The executor page's Standing access panel** (`ExecutorStandingAccessPanel`,
  private machines only; `GET /api/executors/:executorId/standing-policies`,
  for the machine's administrators): each policy not yet ended whose pool
  names the machine — its trigger, agent, author, state, the tickets working
  there now — with End. **(T5)** The row of the policy the machine is held
  under names the ticket holding it (`holdingTicket`, from
  `loadExecutorHoldingTicket`: working, or paused until it reconnects),
  linked to its board for a reader who can read its project and *"A ticket
  you cannot open"* for anyone else.
- **A ticket's own coding session on the executor page** names its agent,
  its ticket (a link, only for a reader who can read its project) and *"ticket
  work under Ondrej's standing access"*: the reported session is joined to
  the work record that lists its id, when the record's owner key for this
  machine is the session's (`executor-coding-session-tickets.ts`).
- **The ticket's chip** says where the work stands with its machine —
  *"queued: position 2"*, *"paused: machine offline"*, *"waiting for machine
  access"*, *"stopped"* at an hours or spend limit — and a wake the binder
  ran without a machine as its plain sentence (`machineRefusal`); its history
  lines say what each pause, resume and queueing was for.
- **The Designer's proposal card** for a ticket-driven agent has a "Runs on"
  row — the machines by name only to the person who paired them, otherwise
  "a machine its owner confirms" — and says one machine-access confirmation
  follows; its persona ends the setup order with that one card.

## Host output stays on the ticket (T4)

A `ticket.work` run is stamped with its work thread's channel as the launch
conversation (`launchConversationScope`), which admits host output to its
project's board; it is narrower than that. Once a local program has answered
the run, every writing builtin but `ticket_comment_add`, `ticket_move` and
`ticket_transition` refuses before it runs (`ticketWorkHostOutputRefusal`,
from `executeBuiltinTool`), and `assertProjectWriteDestination` admits only a
comment on the run's own ticket (`destination: { kind: 'ticket_comment' }`),
with `TICKET_WORK_HOST_OUTPUT_REFUSAL`. The run's replies stay in its work
thread.

## Done means merged (T4)

The first review in a `ticket.work` run that returns a pull request — by its
branch, or by URL — records `pullRequestUrl`, `lastPrState`, `lastChecks`
(`{ passed, failed, pending }` from `gh`'s conclusions) and `prSeenAt`; every
later review asks after that URL (`session_review`'s `pullRequest`, filled by
the worker), so a merge whose branch the coding agent deleted is still read.
The kickoff's state block says *"Pull request: <url>, MERGED, checks 14
passed (15:20 UTC)."* (`ticket-work-kickoff-machine.ts`, with the machine,
the hours and spend and the ticket's session), and a move into a done column
ends the record `merged` when the recorded state is `MERGED`.

## Audit (T4)

`executor.run.policy_bound` (policy, record, TaskEvent, mover and origin,
machine, bindings, digests), `executor.run.policy_refused`,
`ticket.work.started`, `ticket.work.queued`, `ticket.work.ended`
(`writeTicketWorkAudit`, from `endTicketWork` for every end), and
`executor.coding_session.started`, `.closed` and `.sent` tagged with the
ticket, the policy and the owner context — a send with the events that woke
its run and who wrote each (the kickoff keeps their `source` and `by`).

## Tests that hold these rules (T4, T5)

`packages/team-admin/test/standing-policy-binding-db.test.ts` (a bind for the
author naming the policy and the record, each check refusing on its own with
its audit row and delivery, the fence naming the context, refusing another
program and the generic catalog walk, and fencing after an end, the
heartbeat carrying the close, the intake stopping a ticket past its hours);
`worker/src/run/executor-toolset-coding.test.ts` (a standing-bound run offered
the coding tools and no generic pair); `standing-policy-fences-db.test.ts` (every fence);
`worker/test/db/standing-policy-dispatch.test.ts` (two pickups on two
machines and a third queued, an offline machine at wake, a wake past spend,
`ticket_left_flow` and `merged`);
`worker/test/db/ticket-work-coding-tools.test.ts` (the ticket's session,
title, agent, roots, cost, turn, pull request by URL after the branch is gone,
send audit, lost-start reconciliation);
`worker/test/db/ticket-work-host-output.test.ts`;
`worker/test/db/ticket-work-sweep-machines.test.ts` (a queued ticket taking a
freed machine with a `dequeued` wake and an idle sweep writing nothing, work
past its hours stopped with its closes, an author the organisation no longer
lists losing their access, a quiet wake waiting on a working session); the reach-facts and kickoff
unit tests; `executor/test/coding-session-bridge.test.ts` (`totalCostUsd`).

**(T5)** `packages/executor-manage/test/ticket-work-session-intake.test.ts`
(the intake's decision over two reports: a fast turn once, a slow one at its
end, interrupted and failed with their reason, a missing session closed but
unknown at the row cap, nothing from a report without the field);
`worker/test/db/ticket-work-session-wakes.test.ts` (signed heartbeats through
the subscriber: a fast turn inside one report waking once and a replayed job
nothing, a turn the agent already saw skipped with its row, interrupted and
failed, a closed session leaving the live set, a report without the field,
a parked record skipped, the wake budget, a trigger in error waking nothing,
and a dead session job recovered);
`worker/test/db/ticket-work-dequeue.test.ts` (priority then age across two
policies sharing a machine, positions renumbered, a priority change re-sorting
and waking nothing, a ticket out of its column and a mover off the board
cancelled with their reasons, a drifted trigger suspending its policy, a
record going back to its own machine once it is free, a new pickup not
jumping the line, two racing dequeues putting one record on the machine and
the index refusing a second);
`worker/test/db/ticket-work-dequeue-own-machine.test.ts` (a record whose
machine went offline, or is held by other work, taking another free one with
its old sessions closed `machine_reassigned` and forgotten; back on its own
machine at its own quota; a quota counting only live sessions);
`worker/test/db/ticket-work-dequeue-guards.test.ts` (a machine whose identical
revision awaits review placing nothing and suspending nothing, then placing
once reviewed; a mover's cancel closing its sessions `mover_lost_access`; a
placement waiting for a suspension in flight and reading it; a
`machine_reassigned` close outliving the day's TTL; an event's sweep running
the machine steps alone, and the heartbeat enqueuing it only for work of a
trigger that is on); `worker/test/db/ticket-work-session-scope.test.ts`
(another machine's report, or another owner's session, waking and closing
nothing; a report without the field between two hiding no close);
`worker/test/db/ticket-work-session-withdraw.test.ts` (a turn the agent's own
wait read while its wake pended withdrawn with the wake given back, a folded
kickoff keeping its other events, an interruption waking however far the
agent read, and a session the agent closed waking nobody even from a racing
report); `worker/test/db/ticket-work-machine-back.test.ts` (no run while the
machine is away, the heartbeat's sweep and one `machine_back_online` wake, a
wake that finds it back, `waitingMachineHours` moving the work to the other
machine with its old session's `machine_reassigned` close riding that
machine's next heartbeat, work handed to a pool without its machine queued
for one that has it, and what the chip, the section and the executor page
read); `api/test/standing-policy-routes.test.ts` (the holding ticket);
the admin's `ticket-work-machine-states`, `machine-access-presentation`,
`executor-standing-access` and `ticket-trigger-form` tests; and the
task-dialog (21, 28–30), agent-triggers (the waiting-hours field, the page's
facts and deliveries, the paused ticket) and executor-detail (the holding
ticket) suites.
