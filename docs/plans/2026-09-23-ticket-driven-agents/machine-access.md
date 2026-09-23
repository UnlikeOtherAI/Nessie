# Standing machine access

Today only a person binds an executor to a run: by launching it or by holding
a conversation lease. A ticket moved by a colleague at 03:00 has neither. The
standing policy is the third way. The machines' owner confirms it once, it
names exactly what they agreed to, and every wake is bound afresh against it.
It applies only to the local-apps pair (`mcp.tools` + `mcp.call`).

## The policy

Two tables, both in T0:

- `executor_standing_policies`:
  - identity: `id`, `organizationId`, `authorUserId`, `triggerId` (`onDelete:
    SetNull`), `agentId`;
  - state: `status` (`preparing`, `live`, `suspended`, `ended`), with
    `suspendedReason` and `endedReason`, each from a closed vocabulary with a
    CHECK;
  - what was agreed: the pinned host profile, `triggerDigest`, and
    `authorOrigin` (organisation, team, `uoaIdentity`, captured at confirm
    with `ScheduledTriggerLaunchOriginSchema`);
  - history: `confirmedAt`, `endedAt`, `endedByUserId`, `createdAt`.
- `executor_standing_policy_executors(policy_id, executor_id, position,
  descriptor_config_digest, local_policy_digest)`: the pool, one or two rows
  with foreign keys. A JSON array cannot hold a foreign key.

Every pool machine must be **private**, and its **pairing owner** must be the
author. The author must be a live member of the project who can edit the
board. These are the coding-sessions rule, unchanged.

Per trigger, at most one policy is `live` or `suspended` and at most one is
`preparing`, each a partial unique index. A confirm ends the policy it
replaces in its own transaction, and a new prepare ends the card it replaces.

## The host profile

A session started under a policy runs as the author, with the author's files,
git, SSH and coding-agent login. Its steering text comes from the board's
editors. So the policy pins a reviewed **unattended host profile**, which the
card shows and every start checks:

- **Permission mode.** Claude `bypassPermissions` and Codex
  `bypassApprovalsAndSandbox` / `approveForMe` are refused unless the author
  ticks a separate option. It is worded *"Let the coding agent run any command
  without asking."*
- **Roots.** `allowedRootNames` is pinned. A `coding_session_start` with any
  other root is refused on the server.
- **Budget.** `maxBudgetUsd` per turn is required. T4 adds `maxBudgetUsd`
  and `maxLiveSessionsPerOwner` to the signed codingSessions facts, so the
  server can check both.
- **Merge ability.** The card reads the pinned descriptor's `allowedTools`.
  It says whether `Bash(git push:*)`, `Bash(gh pr create:*)`,
  `Bash(gh pr checks:*)` and `Bash(gh pr merge:*)` are allowed. When they are
  not, it warns *"This machine cannot merge; tickets will stop at an open pull
  request."*

## What is pinned

At confirmation the policy stores `triggerDigest`, a digest of the trigger's
security-relevant fields:

- agent, board, pickup columns, follow kinds and `endOn`;
- `assignOnPickup`, target channel and every instructions section;
- the limits.

The pool rows store each machine's `codingSessions` config digest and
`localPolicyDigest`.

- **A trigger edit that changes a pinned field** suspends the policy in the
  same transaction (`suspendedReason: trigger_changed`). This holds whoever
  saves it, the author included. Lowering a limit is the one exception. The
  editor warns before saving: *"Saving pauses Ondrej's machine access until
  they re-confirm."* The author gets a fresh card that shows the diff.
  `agent_trigger_update` answers the same way.
- **A descriptor review that changes a pinned digest** suspends it
  (`descriptor_changed`).
- **A suspended policy binds nothing.** Pickups still run, unbound, with
  `stateReason: machine_access_suspended` on the chip.

## Prepare and confirm

- **Who may prepare:**
  - the author from the UI, in the trigger's Machine access section; or
  - an interactive run whose requester is the author, in the author's **own**
    Designer or PA DM.

  Nobody else, and no unattended run. The CTO has no prepare tool. When asked,
  it says *"Ask Ondrej to set up machine access for this trigger, from its
  Machine access section or with the Agent Designer."* A preparer who is not
  the author would learn which private machines the author has.
- **One composite card per policy.** It applies, in one confirmed
  transaction with a single fresh verification (the `ExecutorAccessChange`
  continuation with a password re-proof), for each pool machine: the private
  assignment of the agent, the whole-suite grant and the executor
  logical-tool enablement in the agent's tool policy. Then it applies the
  policy itself. Two machines therefore mean one card, not five.
- **Prepare refuses per machine**, with a reason: not private, paired by
  someone else, no reviewed coding-sessions bridge, or offline. For that, the
  Designer's executor facts gain `pairedByYou` and `codingSessionsReviewed`.
  It then proposes only machines that qualify, and says why the others do not.
- **The card goes to the author's home DM.** It is never shown in a project
  room. In plain words it shows:
  - the machines;
  - the host profile and the merge warning;
  - the board and its start-work columns;
  - who can start work: *"Anyone who can edit this board (7 people) can make
    Claude run commands on these machines as you, with your git and
    coding-agent login."*;
  - the audience: project members, organisation owners and people on the
    ticket;
  - the limits;
  - that merges happen under the author's GitHub identity;
  - the instructions, verbatim.
- **Changing the pool or raising a limit** takes a new prepare and a new card.

## Binding at each wake

For every `ticket.work` wake that has an active record with a pinned
executor, `bindStandingPolicyExecutor(run, work)` runs. It lives in
`packages/executor-manage/src/executor-standing-policy-binding.ts`, and its
dispatch fence sits beside `assertExecutorCommandBindingCurrent` in a new
module. It checks:

1. The policy is `live` and names this trigger, agent and executor.
2. The trigger digest and the executor's descriptor digests still match.
3. The author is re-resolved live with UOA, failing closed and never from a
   cache. The author must not be deactivated, and must still be a project
   member who can edit the board. `authorOrigin` still verifies.
4. The executor is online, not paused or revoked, and still private to the
   author. The agent's assignment and grant still hold.
5. The target channel is still live, ordinary, public and in the project,
   with the agent bound.
6. Every message the run consumes is a `ticket.work` kickoff for this work
   record.
7. The limits allow it.

Only then does it resolve a fresh candidate pinned to that executor, with the
author as the person, and bind it with `standingPolicyId`. Run setup records
a binding outcome of the new reach kind **`standing`**, so the reach facts
describe the machine tools. Today `loadExecutorReachFacts` returns nothing
without a lease. Each refusal writes `executor.run.policy_refused` and a
delivery row, and the run continues unbound. Its reason is in the facts and
on the chip.

## Session isolation

Today a coding session's owner key is `sha256(executorId|agentId|actorUserId)`.
That is the same key the author's own DM sessions with the agent use. A ticket
run could then list, read and send into those sessions. A lease ending would
close every ticket session on the machine, and the quota of 3 would be
shared.

- **Owner context (T4, every OS):** the owner gains `contextId`. It is
  `ticket:<policyId>:<taskId>` for ticket work, and absent for launches and
  leases. `executorCodingSessionOwnerKeyInput` and the daemon's `_meta`
  derivation both hash it. A lease-end close then cannot reach ticket
  sessions, and each ticket has its own quota.
- **Worker filter (T4, defence in depth):** in `ticket.work` runs the
  `coding_session_*` tools refuse a `sessionId` not in the work record: *"That
  session is not this ticket's."* `sessionId` is optional and defaults to the
  ticket's single live session, so a weak model never copies a UUID.
- **Titles:** start's `title` is forced to "<ticket key> <ticket title>".
  The returned `sessionId` is appended to the record in the same step. An
  unknown outcome is reconciled from the next report by title and owner key.
- **Ticket-mode tool descriptions** are picked in run setup by purpose:
  - **start:** *Start the coding agent for this ticket. Put the goal, the
    ticket id and link, the acceptance criteria and the pull-request and merge
    rule in the task. Then post one short ticket comment and end your turn.
    Nessie wakes you here when its turn ends.*
  - **send:** *Give the coding agent new information or a correction, then end
    your turn.*
  - **wait:** *Read what the session said at the end of its last turn. It
    returns at once. Do not use it to watch work in progress.*

  The ticket-mode wait window is at most about 60 s. `personWrote` in
  `codingWaitRunChecks` also returns true when a `ticket.work` kickoff for the
  same record is pending.

## Server-side closes

Sessions are closed by the server, never through the model.

- Session-scoped `executorCodingSessionCloseRequest` rows are written for
  the record's `sessionIds`, in the same transaction as:
  - a ticket leaving the flow;
  - the record failing on a limit, checked in the heartbeat intake against
    `costUsd` and `activeMs`;
  - the policy ending or being suspended, through any fence;
  - the trigger being deleted, disabled or changed.
- T4 adds the close reasons `ticket_left_flow`, `policy_ended` and
  `work_limit` to `EXECUTOR_CODING_SESSION_CLOSE_REASONS` and to its CHECK.
  It records them in `host-coding-sessions.md`.
- A test ends a policy mid-turn and sees `codingSessionClose` on the next
  heartbeat.

## Fences

The policy ends in the same transaction as each of these, reusing the
`endExecutorConversationLeasesInTransaction` call sites:

- the executor is paused or revoked, or loses private access;
- descriptor narrowing;
- the author is removed from the project, or loses board-edit rights;
- `uoa-roles` deactivation;
- the agent is unbound from the target channel;
- the target channel is archived, made non-public or leaves the project;
- the project, board or pickup column is archived;
- the trigger is disabled or deleted.

UOA has no removal feed, so two more checks cover the author leaving the
organisation. Binding re-checks UOA live (above). `ticket-work.sweep` ends
policies whose author UOA no longer lists, and closes their sessions. The
policy also ends when its author or an executor admin presses End: on the
executor page, or in the trigger's Machine access section.

## Disclosure

- A `ticket.work` run is stamped with `launchConversationScope(thread's
  channel)`. The target channel is required to be live, ordinary and public in
  the project. This is the existing rule that admits host output on to that
  project's board (`ticket-context.ts`).
- It is narrower than that. In a `ticket.work` run, host-output-bearing writes
  are admitted only to **that ticket's comments and its work thread**. The
  run can hold other tools, but Claude's output cannot be posted into another
  channel or ticket.
- The reach fact for a standing bind uses the existing DM-only naming rule
  (`executor-reach-facts.ts`), so the machine's label never appears in the
  thread.

## Done means merged

Claude Code on these machines is told by its CLAUDE.md to delete merged
branches and worktrees. `session_review` finds pull requests only through
branches and worktrees still on disk. So a successful merge would make the
review come back empty.

- The first time a review in a `ticket.work` run returns a pull request, the
  worker records `pullRequestUrl`, `lastPrState`, `lastChecks` and `prSeenAt`
  on the record.
- `session_review` gains an optional `pullRequest` URL argument. This is an
  executor change, and runs `gh pr view <url> --json
  url,state,mergeable,statusCheckRollup`. In `ticket.work` runs the worker
  fills it in from the record.
- The state block then says *"Pull request: <url>, MERGED, checks 14 passed
  (15:20)."* The agent moves the ticket to Done when the state is MERGED, and
  teardown records `stateReason: merged`.

## Audit

Rows are written inside their transactions:

- The policy: `executor.policy.prepared`, `executor.policy.confirmed` (with
  digests, pool, limits and host profile), `executor.policy.suspended` and
  `executor.policy.ended` (with the reason and who ended it).
- Binding: `executor.run.policy_bound` (the policy, the work record, the
  TaskEvent, the mover and their origin, the executor, the bindings and the
  pinned digests) and `executor.run.policy_refused`, which is its own row,
  like `carry_refused`.
- The work record: `ticket.work.started`, `ticket.work.queued` and
  `ticket.work.ended`.
- Coding sessions: start and close, tagged with the ticket and the policy
  context.
- Each `coding_session_send` in a `ticket.work` run records which comment or
  event it forwarded and who wrote it. A merge is then traceable to the
  member who asked for it, and the brief carries the requester's name into
  the pull request body.

## Amendments

These ship in T4.

1. **Binding**, in `docs/executor-protocol/overview.md`: *"…or, for the
   local-apps pair, a standing policy its author (the pairing owner of every
   executor it names) confirmed with fresh verification, for runs of that
   policy's own trigger on one ticket's work. The work must have been started
   by a person's move. The trigger and host configuration must still match
   what was confirmed. The run must consume only that work's system kickoffs.
   Each such run is bound afresh, and every check runs again."*
2. **Leases**, in `conversation-leases.md`: *"nothing a system, workflow or
   agent posts carries a lease"* stays true. A new sentence says the standing
   policy is a separate, confirmed path and links here.
3. **Disclosure**, in `disclosure-boundaries.md`: *"an agent cannot bind an
   executor on its own, so the consent is always a person's"* gains: *"for a
   standing policy, the author's confirmation is that consent, and host
   output is admitted only to the ticket's comments and its work thread."*
4. **Coding-session owner**, in `host-coding-sessions.md` and the local-apps
   coding-sessions chapter: the owner is the launch, lease **or policy**
   actor, with the policy context.
5. **Two locks**, in `global-agents.md`: a ticket-work run acts as the agent,
   never as a reconstructed requester. The standing policy's author is read
   only by the binder.
6. **Budgets**, in `tech-and-run-budgets.md`: the ticket and policy limits,
   and the run-limit ceiling for `ticket.work`.
