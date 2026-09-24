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
  at the start of run setup, before any tool is resolved
  (`prepareTicketWorkRun`, `worker/src/run/execute/ticket-work-standing-gate.ts`,
  through `bindTicketWorkMachine` in `ticket-work-setup.ts`), after seven
  checks, each its own refusal (`executor-standing-policy-binding-checks.ts`):
  `policy_not_live` — the policy is `live` and names this trigger, agent and
  machine; `terms_changed` — the live trigger and agent digest to
  `triggerDigest` and the machine to its pinned digests (an agent whose
  definition changed also suspends the policy, `agent_changed`), and
  `ticket_not_in_flow` — the ticket still renders on the pinned board, in a
  column that does not end its work (team-admin's `ticketInWorkFlow`, handed
  in); `author_unavailable` — the origin captured at
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
  A re-driven job whose earlier attempt bound runs every check again: its
  bindings are reused only while the checks hold (`already_bound`), and a
  refusal takes their policy off them, so the dispatch fence refuses them.
- **A refusal is an outcome, never a throw** — an unexpected error once the
  record is read is one too (`bind_failed`). It writes
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
  public room, and the DM-only naming rule never names a machine there — name
  it *"the ticket owner's machine"*, offer only the pinned coding agent and
  folders, and list only the sessions under the ticket's own owner key.
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
  machine is refused, and so is a descriptor too old to state it or its
  `unaskedCommands`), Claude Code able to run any command without asking —
  `bypassPermissions`, or a Bash rule the machine signs as
  `unaskedCommands: 'any'` — only when the author chose *"Let the coding agent
  run any command without asking."*, and every allowed root. The Designer's
  executor facts carry `pairedByYou`, `codingSessionsReviewed` and
  `ticketWorkBlocker` and say "ticket work: yes / not yet / no" per machine:
  *yes* needs a signed Claude Code `maxBudgetUsd` from an executor new enough
  to sign what this check reads.
- **What is pinned.** The host profile (`StandingPolicyHostProfileSchema`):
  the coding agents a start may use, `allowAnyCommand`, `allowedRootNames`
  (default: the roots every pool machine shares) and per machine its
  permission mode, turn budget, session quota and `mergeCommands`. The terms
  (`StandingPolicyPinnedTermsSchema`, column `pinned_terms`): the agent and
  its definition (`agent`: a digest over its system prompt, role, the
  published versions of its core documents, provider, model, subscription,
  local binding, routing, execution and delegation modes, tool policy with
  every explicit grant, and its connector grants, with the provider and model
  kept for the card — `loadStandingPolicyAgentPin`,
  `executor-standing-policy-agent.ts`), target channel, board, start-work
  columns, `assignOnPickup`, follow kinds, `includeSourceEvents`, end columns,
  every instructions section verbatim, `quietWakeMinutes`, and every limit — the trigger's `wakesPerTicket` and `startsPerDay` and the
  policy's own `ticketHours`, `ticketUsd` and `dailyUsd`
  (`StandingPolicyLimitsSchema`, 4 h, $20 and $60 by default), which live on
  the policy, not the trigger. `triggerDigest` is `standingPolicyTermsDigest`
  of exactly those terms. Each pool row pins the bridge's `configDigest` and
  the revision's `localPolicyDigest`. The confirmation pins the agent again
  once it has turned the executor tools on in its tool policy, since that is
  its own doing. A limit sent as a string (`"20"`) is the number it says
  (`z.coerce`, and the worker's argument coercion reaches nested objects).
- **An edit of the agent suspends the policy** (`agent_changed`), in the
  transaction that makes it, whoever saves it:
  `updateAgentRecord` (the record, and the core-document writes that always
  precede it), `mutateAgentToolPolicyInTransaction` (the tool policy and the
  MCP grants synchronized with it), and the API's `createGrant` /
  `deleteGrant` for an agent's connector grant
  (`suspendStandingPoliciesForAgentChangeInTransaction`). Anything that
  changes the definition outside those — a core document published elsewhere,
  a row written directly — is caught by the binder's digest, which suspends
  it then. A rename changes nothing pinned.
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
  triggers' pools, then reads the policy again (a suspension or an end that
  took the same locks first is seen). The first machine that is online (a
  fresh heartbeat), held by no other record in
  `TICKET_WORK_MACHINE_HOLDING_STATUSES` and below its pinned
  `maxLiveSessionsPerOwner` for this ticket's own owner key in its last
  report takes it: `executorId`, `policyId`, `active`.
- **Returning work belongs on its own machine** (`homeMachineOf`): the one it
  holds, else the one its newest coding session was started on
  (`session_origins`), while that machine is in the pool. It takes that
  machine — its own open sessions never make it busy — or queues for it, ahead
  of new tickets in the queue order, and moves to another only once its own
  has left the pool or been removed.
- **A spent day queues** (`queued_daily_limit`): once the policy's spend
  this UTC day reaches `dailyUsd`, a pickup or a dequeue assigns nothing and
  the record is queued, with a wake that says it starts after 00:00 UTC.
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
  (`enqueueTicketWorkSweep`); the sweep then places queued work on the freed
  machine (below, "The sweep's machine half").
- **A pinned machine offline when a wake comes starts no model run**
  (`holdTicketWorkBeforeWake`): the record goes to `waiting_machine` with
  `machine_offline`, keeping its machine's slot, with a `work_paused` row, and
  the delivery is skipped `machine_offline`. Its reconnect wakes it (T5). The
  sweep pauses the same way an `active` record whose machine stopped
  heartbeating while nothing woke it (below).

## A ticket's coding tools are the ticket's own (T4)

A `ticket.work` run the binder bound gets the coding tools of its ticket
(`worker/src/run/ticket-work-coding-sessions.ts`, wrapping the ordinary
`createExecutorCodingSessions` through `buildExecutorToolset`'s `ticketWork`):

- **Coding sessions, and no other program.** The author's card consented to
  Claude Code sessions on these machines — it says *"The agent may drive
  Claude Code sessions on these machines; it gets no other program on
  them."* (`STANDING_POLICY_CODING_ONLY_SENTENCE`) — not to the machine's
  other reviewed programs. So a standing-bound run is offered the
  `coding_session_*` tools alone — never the interactive terminal's
  `terminal_session_*` tools, which are refused if called, and its answers
  carry no session viewer link (`viewPath`), since its thread is a project
  room: the generic `executor_mcp_tools` /
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
  and defaults to the ticket's one live session; none, or more than one, is
  said. A recorded session is **live unless a report the machine took after it
  was recorded says otherwise** (`liveTicketWorkSessions`,
  `ticket-work-session-origins.ts`, against `localMcpObservedAt`): the
  machine reports on its heartbeat, so a session started a moment ago is in no
  report yet. So a start while the ticket has a live session is refused
  (*"This ticket already has a coding session; use coding_session_send."*),
  and the kickoff's session line uses the same rule. A start whose answer was
  lost is taken back onto the record from the next report by its title under
  that owner key.
- **Each session remembers its machine** (`session_origins`,
  `{ executorId, policyId, startedAt }` per session, written with
  `sessionIds` by `appendTicketWorkSession`): it is live only on that
  machine, and closed there under its own policy's owner context.
- **A start is the ticket's:** its title is forced to the ticket's own
  (`ticketWorkThreadTitle`), only the pinned coding agents (Claude Code) and
  `allowedRootNames` are offered and accepted — and the API refuses any other
  start on a standing binding before a command exists (`standingStartRefusal`,
  from `assertExecutorMcpCallPayload`) — and the session it returns is
  appended to the record as it answers (`appendTicketWorkSession`).
- **Each tool says what it is for in ticket work** (start, send, wait, list
  and review texts, `ticketWorkCodingDescriptors`); a start or a send answers
  *"… end your turn: Nessie wakes you here when the session's turn ends"*,
  never "call coding_session_wait" (`presentCodingCall`'s `ticket`); a wait
  returns within a minute (`TICKET_WORK_CODING_WAIT_TIMING`) and gives way
  when a wake for the same record is pending behind the run
  (`codingWaitRunChecks`' `ticketWorkId`); the list is answered from the
  policy's pins — Claude Code, the pinned folders, this ticket's live
  sessions — without asking the machine; and a review's `pullRequest` is the
  record's alone: the model's argument is dropped.
- **What every answer says lands on the record in the same step**
  (`ticketWorkCodingObserver`,
  `packages/executor-manage/src/ticket-work-session-observations.ts`): the
  cost since the last read, from the cumulative `totalCostUsd` a send, a
  status read or a review carries (`session_costs`); the newest ended turn
  (`lastObservedTurn`); and a review's pull request.

## Server-side closes, limits and spend (T4)

- **Session-scoped close requests for the record's sessions**, by the
  ticket's owner key, in the transaction of: a move into an `endOn` column or
  off the board (`ticket_left_flow`: `applyTicketWorkColumnEntry`,
  `applyTicketWorkLeftBoard`, the worker's end-wake settle), a limit
  (`work_limit`), the trigger switched off or deleted (`trigger_changed`), a
  suspension (`policy_suspended`, which also unpins the record) and an end
  (`policy_ended`, a hand-over's parked records included). Each session is
  closed on the machine it was started on, under the policy it was started
  under (`session_origins`), whichever machine the record holds now. Never an
  owner-wide close for ticket work. The next heartbeat carries them. A
  suspension and an end take the policy's pool locks first, as a placement
  does.
- **The heartbeat charges each ticket for its sessions**
  (`recordTicketWorkHeartbeatCostsInTransaction`,
  `ticket-work-heartbeat-costs.ts`, from `reportExecutorHeartbeat`): every
  session in the machine's report carries its `totalCostUsd`, and a ticket's
  sessions on that machine — under its own owner key there — add what they
  cost since they were last counted to `costUsd` and the day, whether or not
  a run reads the session. `session_costs` keeps each session's newest total,
  so this and the worker's reading of a coding answer never count the same
  dollars twice.
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
  active on that machine and every record it just charged, so the close
  rides the same answer); and by the sweep for work nobody wakes
  (`enforceTicketWorkLimitsInTransaction`). Over one, the record fails with
  `limit_hours` or `limit_cost` — `dailyUsd` too, with its own sentence,
  because T1 gave `limit_daily` to the trigger's `startsPerDay` — a
  `work_ended` row, a "Stopped" thread row, and its closes; a wake it would
  have been is skipped with that reason. **The day's spend fails only work
  that is running** (`active`): queued, parked and waiting work that did not
  spend it waits, and is queued with `queued_daily_limit` when it would
  start. A coding review is only an answer like any other: it carries a cost,
  and ends nothing by itself.

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

## The sweep's machine half (T4)

`ticket-work.sweep` (T3's periodic job, and every enqueue a transaction that
may free a machine makes) runs `sweepStandingMachineAccess`
(`worker/src/control/ticket-work-sweep-machines.ts`) after its record pages,
each step on its own so one failing never keeps the others from running:

- **Authors UOA no longer lists** (`endPoliciesOfDepartedAuthors`). UOA has
  no removal feed, so each author of a preparing, live or suspended policy
  is asked again (`resolveLiveEntitlementDecision`) with the identity
  captured at confirmation, and — when that no longer answers, a new token
  version or another active team — once more through their current stored
  link. Only a definite "not a member" ends every such policy of theirs
  (`author_left_organization`), its records cancelled and its sessions
  closed, with `executor.policy.ended`, in one transaction: UOA's own answer
  through a live link, or a local organisation that no longer lists them. An
  outage, or no identity left to ask with, ends nothing: the binder refuses
  every wake meanwhile (`author_unavailable`), failing closed on its own.
- **Work on a machine that went silent** (`pauseWorkOnSilentMachines`): an
  `active` record whose machine is offline or has not heartbeated inside the
  freshness window waits for it (`waiting_machine`, `machine_offline`), its
  hours clock paused, with a `work_paused` row, under the ticket and
  thread-slot locks every wake takes (`holdTicketWorkBeforeWake`).
- **Limits on work nobody wakes** (`enforceLimitsOnLiveWork`): every live
  record under a policy, fifty to a transaction, against its hours clock
  and spend, exactly as a wake and the heartbeat intake check them.
- **The dispatcher's backstop** (`dispatchQueuedTicketWork`): each live
  policy's queued records, by queue position then age, are placed on its
  pool one at a time until one finds no free machine. Each placement takes
  the locks every wake of the record takes, in the one order — the ticket,
  the thread's run slot, then the pool and the record — and re-reads the
  record still `queued`. Placed, the record is `active` with a
  `work_resumed` row, `ticket.work.started` (`dequeued: true`), a delivered
  `dequeue` delivery (event type `dequeued`) and one `dequeued` wake; not
  placed, every write the attempt made rolls back, so an idle sweep writes
  nothing, and the next record is still tried — returning work waits for its
  own machine while a newer ticket may take another. This is a simple first-free assignment in each policy's own
  queue order; the dequeue by priority and age across every policy that
  shares a machine, and its re-checks of the ticket, the mover and the
  digests, are T5's.
- **The quiet wake waits for a working session.** T3's quiet wake is not
  sent while one of the ticket's own coding sessions is `working` in the last
  report of a machine still heard from (`ticketSessionWorking`, which reads
  nothing from a silent machine): the coding agent's turn ending wakes the
  agent instead (T5).

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
  agent set up opens this section (`#machine-access`). The author reaches
  the page even when they are not an owner: `GET /api/triggers/:triggerId`
  and its `/history` answer an owner, or the ticket trigger's author while
  they can still edit its board (`trigger-readable.ts`), and the page is
  read-only for them apart from this section. A card prepared and left
  unconfirmed says where it is after a reload — the conversation with the
  Agent Designer, with a link, or this page, with **Prepare it again…**
  (`cardLocation`).
- **The trigger editor warns before a save pauses access**: when a live
  policy pins a field the form changed, above Save: *"Saving pauses Ondrej's
  machine access until they re-confirm."* `PUT /api/triggers/:triggerId`
  answers what the save did (`machineAccess`: `limits_lowered`, or
  `suspended` with the author and the fields), and the page says it.
- **The executor page's Standing access panel** (`ExecutorStandingAccessPanel`,
  private machines only; `GET /api/executors/:executorId/standing-policies`,
  for the machine's administrators): each policy not yet ended whose pool
  names the machine — its trigger, agent, author, state, the tickets working
  there now — with End.
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
- **The confirmation card** names the agent and its model, says that editing
  it (its instructions, model, tools or connectors) pauses the access, which
  machines let Claude Code run any command without asking, the quiet wake,
  whether a mirrored board's own events wake work, how many waiting tickets
  start on confirm, and that anyone who can edit the board — *"N people today,
  and anyone added to the project later"* — can start work.
- **The Designer's proposal card** for a ticket-driven agent has a "Runs on"
  row — the machines by name only to the person who paired them, otherwise
  "a machine its owner confirms" — and says one machine-access confirmation
  follows; its persona ends the setup order with that one card.

## Host output stays on the ticket (T4)

- **A standing run reaches nothing outside Nessie.** A `ticket.work` run is
  *standing* when its policy bound it a machine this turn, or when its record
  has ever held a coding session (`prepareTicketWorkRun`,
  `worker/src/run/execute/ticket-work-standing-gate.ts`). It is not offered
  — and `authorizeToolExecution` refuses (`ticketWorkStandingRefusal`,
  reason `ticket_work_standing`) — `http_fetch`, `web_fetch`, `web_search`,
  the browser tools, `dashboard_source_probe`, `delegate`, `spawn_subtask`,
  `agent_peer_delegate`, and every MCP connector tool: its MCP toolset is
  empty (`withoutMcpTools`), and any name that is neither a builtin nor one
  of its coding tools is refused at the gate.
- **A record that has held a session is stamped with host output at setup**,
  before any tool reads the machine again this turn: its kickoff, thread and
  pull request already carry what the machine answered.
- **After host output only the ticket takes it.** The run is stamped with its
  work thread's channel as the launch conversation
  (`launchConversationScope`), which admits host output to its project's
  board; it is narrower than that. Every writing builtin but
  `ticket_comment_add`, `ticket_move`, `ticket_transition` and
  `check_back_in` refuses before it runs (`ticketWorkHostOutputRefusal`,
  from `executeBuiltinTool`); the three ticket writes are refused at the gate
  for any ticket but the run's own; and `assertProjectWriteDestination`
  admits only a comment on the run's own ticket (`destination: { kind:
  'ticket_comment' }`), with `TICKET_WORK_HOST_OUTPUT_REFUSAL`. The coding
  session tools are the machine's own, and the run's replies stay in its
  work thread.
- **A document change reaches ticket work as what changed, never as
  instructions**: the document trigger's own instructions stay with its
  review threads, because a standing run runs on the ticket trigger's pinned
  instructions ([document-triggers.md](document-triggers.md)).

## Done means merged (T4)

The first review in a `ticket.work` run that returns a pull request — by its
branch, or by URL — records `pullRequestUrl`, `lastPrState`, `lastChecks`
(`{ passed, failed, pending }` from `gh`'s conclusions) and `prSeenAt`; every
later review asks after that URL (`session_review`'s `pullRequest`, filled by
the worker from the record and never from the model), so a merge whose branch
the coding agent deleted is still read. The kickoff tells the agent to run
`coding_session_review` before it moves the ticket to Done, and, when the
ticket's earlier session was closed (a hand-over after a re-confirm, say), to
brief a new one with what was already done.
The kickoff's state block says *"Pull request: <url>, MERGED, checks 14
passed (15:20 UTC)."* (`ticket-work-kickoff-machine.ts`, with the machine,
the hours and spend and the ticket's session), and a move into a done column
ends the record `merged` when the recorded state is `MERGED`.

## Audit (T4)

`executor.run.policy_bound` (policy, record, TaskEvent, mover and the origin
its move recorded, machine, bindings, digests), `executor.run.policy_refused`,
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
`packages/team-admin/test/standing-policy-review-db.test.ts` (an agent edit
suspending the policy field by field and behind the edit paths, a ticket out
of its flow, a re-driven job re-checked and fenced, `bind_failed`, the
mover's origin, the heartbeat's cost intake, each session closed on its own
machine, returning work waiting for its own machine, a spent day queueing,
unasked commands needing the tick); `packages/executor-manage/test/ticket-work-session-origins.test.ts`
(the live rule); `worker/src/run/execute/ticket-work-standing-gate.test.ts`
(the standing gate, its withheld tools, own-ticket writes, the host-output
stamp); `worker/src/run/executor-toolset-coding.test.ts` and
`executor-toolset.test.ts` (a standing-bound run offered the coding tools and
no generic pair, and nothing without its scope); `standing-policy-fences-db.test.ts` (every fence);
`worker/test/db/standing-policy-dispatch.test.ts` (two pickups on two
machines and a third queued, an offline machine at wake, a wake past spend,
`ticket_left_flow` and `merged`);
`worker/test/db/ticket-work-coding-tools.test.ts` (the ticket's session,
title, agent, roots, a session live before the machine reports it and a
second start refused, "end your turn", the list from the pins, cost, turn,
pull request by URL after the branch is gone and never from the model, send
audit, lost-start reconciliation);
`worker/test/db/ticket-work-host-output.test.ts`;
`worker/test/db/ticket-work-sweep-machines.test.ts` (a queued ticket taking a
freed machine with a `dequeued` wake and an idle sweep writing nothing, work
past its hours stopped with its closes, an author the organisation no longer
lists losing their access and one asked again through their link, work on a
silent machine paused, a quiet wake waiting on a working session of a
machine still heard from); the reach-facts and kickoff unit tests;
`executor/test/coding-session-bridge.test.ts`, `coding-session-teardown.test.ts`
(`totalCostUsd` in answers and reports) and
`coding-session-merge-commands.test.ts` (`unaskedCommands`).
