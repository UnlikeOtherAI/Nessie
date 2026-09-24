# Ticket work — standing machine access

Part of the ticket-work standard: [ticket-work.md](ticket-work.md) is the
rule for everything else a ticket's work does, and its tags — (T4), (from
T4) — mean what they mean there. This file holds the machine owner's
authority: who may give a trigger's work their machines, what they agree to,
and what the platform does with that consent. The design is
[machine-access.md](../plans/2026-09-23-ticket-driven-agents/machine-access.md);
where it and the code differ, the code and this file win.

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
- **(T4) A ticket's coding sessions are their own owner.** The coding-session
  owner carries `contextId: ticket:<policyId>:<taskId>`, hashed into the owner
  key by `executorCodingSessionOwnerKeyInput` and by the daemon alike, so the
  author's own DM sessions with the agent, and every other ticket's, are
  neither listed nor reached, a lease's owner-wide close never touches it, and
  each ticket has its own `maxLiveSessionsPerOwner`. Without a context the key
  is unchanged. The API admits a context only when the binding pins that same
  one; the binder that pins it is from T4.
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
  Raising one takes a new prepare and a new card. **(from T4)** `dailyUsd` is
  per policy per day, while `AgentTicketWork.costUsd` is a record's lifetime
  total and cannot be split across midnight, so T4 adds a per-policy daily
  spend ledger (policy, day, cost, unique on the pair) with its migration.

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
