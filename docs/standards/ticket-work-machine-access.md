# Ticket work — standing machine access

Part of the ticket-work standard: [ticket-work.md](ticket-work.md) is the
rule for everything else a ticket's work does, and its tags — (T4), (from
T4) — mean what they mean there. This file holds the machine owner's
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
  `binding:<runId>`, the reason's sentence from
  `STANDING_POLICY_REFUSAL_SENTENCES`), and the run goes on with no machine:
  the reach facts say `standing_refused` with the same sentence, and the
  ticket's chip record carries it (`machineRefusal`, from
  `loadTaskTicketWork`, beside a queued record's `queuePosition`) until a
  later wake. None names the machine.
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
- **Nothing free: the record is queued** (`queueTicketWorkInTransaction`) with
  `queued_no_free_machine`, or `queued_machines_offline` when every pool
  machine is offline, its `enqueuedAt`, and a `queuePosition` among the
  policy's queue by ticket priority, then age (`ticketWorkQueuePosition`,
  renumbering the rest). The ticket gets `work_started` and `work_queued`
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
  waiting, a suspension, an end, a confirmation, a limit) enqueues
  `ticket-work.sweep` with a ten-second idempotency bucket
  (`enqueueTicketWorkSweep`). Nothing subscribes to it until the sweep lands
  (T3), and the dequeue is T5's: until then a queued record says "every
  machine is busy" even when the machine that freed it is idle.
- **A pinned machine offline when a wake comes starts no model run**
  (`holdTicketWorkBeforeWake`): the record goes to `waiting_machine` with
  `machine_offline`, keeping its machine's slot, with a `work_paused` row, and
  the delivery is skipped `machine_offline`. Its reconnect wakes it (T5).

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
  title under that owner key.
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
  review's pull request.

## Server-side closes, limits and spend (T4)

- **Session-scoped close requests for the record's sessions**, by the
  ticket's owner key, in the transaction of: a move into an `endOn` column or
  off the board (`ticket_left_flow`: `applyTicketWorkColumnEntry`,
  `applyTicketWorkLeftBoard`, the worker's end-wake settle), a limit
  (`work_limit`), the trigger switched off or deleted (`trigger_changed`), a
  suspension (`policy_suspended`, which also unpins the record) and an end
  (`policy_ended`, a hand-over's parked records included). Never an
  owner-wide close for ticket work. The next heartbeat carries them.
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
  `enforceTicketWorkLimitsInTransaction` is what the sweep calls when it
  lands. Over one, the record fails with `limit_hours` or `limit_cost` —
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
  that nulls the trigger's scope). The sweep's UOA re-check of authors is T3's.

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

## Tests that hold these rules (T4)

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
`worker/test/db/ticket-work-host-output.test.ts`; the reach-facts and kickoff
unit tests; `executor/test/coding-session-bridge.test.ts` (`totalCostUsd`).
