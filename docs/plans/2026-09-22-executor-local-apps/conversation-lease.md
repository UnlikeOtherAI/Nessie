# PR 2 — The conversation lease: a person's own follow-ups keep the executor

Back to [overview](overview.md).

Today executor tools exist only in the one run a person launched; every
follow-up, continuation or restart has none, so each executor session is one
fire-and-forget prompt. PR 2 lets **the person who launched local apps** keep
talking to the agent in **that conversation** and have the agent keep its
reach — and nobody and nothing else.

## 1. The lease

New table `executor_conversation_leases` (one migration, with its CHECKs):

| column | notes |
|---|---|
| `id` uuid pk | |
| `organization_id`, `executor_id`, `agent_id`, `actor_user_id` | FKs; `actor_user_id` is the launching person |
| `thread_id`, `root_message_id` | the launch message is the conversation root the lease covers |
| `launch_run_id` | the run the launch created |
| `operation_keys text[]` | CHECK: exactly `{mcp.tools, mcp.call}` (the same pattern as `20260922190000_executor_availability_known_operation_keys`) |
| `created_at`, `last_used_at` | |
| `idle_expires_at` | `last_used_at + 2 h`, bumped on every carry and every executor command |
| `absolute_expires_at` | `created_at + 12 h`; relaunching creates a new lease |
| `ended_at`, `ended_reason`, `ended_by_user_id` | CHECK `ended_reason IN ('person','access_revoked','executor_paused','executor_revoked','descriptor_narrowed','expired','replaced')` |

Partial unique index: one live lease per `(thread_id, root_message_id, agent_id,
actor_user_id)` where `ended_at IS NULL`. `executor_bindings` gains a nullable
`lease_id` FK. `launchExecutorRun` creates the lease in its transaction when
the bundle is the local-apps pair (ending a previous live lease for the same
key with `replaced`).

## 2. Who may carry it — structurally

Run setup calls `carryForwardExecutorBindings(db, { runId, job })`
(`@nessie/executor-manage`, extracted together with the task-set precedent in
`worker/src/task-sets/search.ts` so there is one helper, not two). It binds
the new run **only when every one of these holds**, and otherwise binds
nothing and returns a reason:

1. The run has no bindings yet (a re-driven job is a no-op, never a conflict).
2. The job's `actorContext.actor` is a `user` whose id equals the lease's
   `actor_user_id`, it is not a channel-policy authorizer, and any
   `effectiveUserId` is the same person.
3. The run is interactive (a live requester, the predicate in
   [global-agents.md](../../standards/global-agents.md)).
4. The trigger message is authored by that person **through the person
   composer path**. `api/src/services/message-create.ts` stamps
   `metadata.authorship = 'person'` on messages a signed-in person posts from
   a client; nothing else sets it. Relayed posts (`delegatedByAgentId`),
   workflow sends, inbound email, integrations, trigger fires and
   system-authored messages never carry it. This is an allowlist, not a list
   of exclusions to keep in sync.
5. For a drained batch, **every** message in it satisfies 4 (the drain passes
   the batch's message ids; a mixed batch carries nothing and says so).
6. For Continue, Restart and approval resume, the job's actor (the presser,
   per `run-policy-replay.ts`) satisfies 2; the replayed trigger satisfies 4.
7. The new run's conversation root equals the lease's `root_message_id` —
   replies in the launch's reply thread, or the same agent conversation. A
   top-level post elsewhere in the channel starts no carried run.
8. The lease is live (not ended, not past either expiry) and the agent is the
   lease's agent.

Then it re-resolves a **fresh** candidate pinned to the lease's executor for
that person and agent (`resolveExecutorAvailabilityCandidates` with the
internal `executorId` pin) and binds it with `bindExecutorCandidateBundleInTransaction`,
setting `lease_id` — so every normal check runs again: person actor, grants,
whole-suite, capability revision, scope, the agent's channel binding.
Refusals are `ExecutorError`s caught here; run setup never throws for them.

Dispatch re-checks the lease: `assertExecutorCommandBindingCurrent` treats a
binding whose lease is ended or expired as fenced.

## 3. Ending it

- **The person** presses End on their lease (below). An executor admin may end
  any lease on their executor.
- **In the same transaction as every transition that already fences sessions**:
  the agent's executor access revoked or narrowed, the executor paused or
  revoked, a descriptor review that drops `mcp.*`.
- **Expiry** is evaluated lazily (carry and dispatch) and swept by the
  existing executor maintenance job.

Ending a lease also asks the machine to close that owner's coding sessions
(PR 3a/3b); in PR 2 it only stops future reach.

## 4. Seeing it

- `GET /api/executor-leases?threadId=` returns **only the viewer's own** live
  leases: agent, executor label, launched at, expires at. Everyone else gets
  an empty list — a private executor's name is never shown to a channel.
- `POST /api/executor-leases/:id/end` (holder or executor admin).
- Realtime `executor.lease.changed` to the holder only.
- Admin: a compact indicator beside the composer's "Run on executor" control,
  rendered for the holder only — "Minis · local apps · until 21:40 · End" —
  that never adds a line to the composer at rest. The executor detail page
  lists the executor's live leases (agent, conversation, person, last used)
  with End, for executor admins.
- Fixture e2e `admin/e2e/executor-lease/` pins: holder sees the indicator,
  another member does not, End posts and clears it.

## 5. What the agent is told

The run's system facts (`worker/src/run/execute/prompt.ts`, outside the
byte-stable cache anchor) state one of:

- bound: "This turn you can use programs on the person's machine through
  `executor_mcp_tools` / `executor_mcp_call` (servers: kelpie, coding-sessions).
  The person who started this session can keep using it in this conversation
  until 21:40 or until they end it."
- not bound, lease exists, refused: one line per reason — "Machine tools only
  come with messages from the person who started the session", "The session
  ended", "The machine is offline or its policy changed; ask the person to
  start local apps again from the composer".
- not bound, the agent holds an executor grant, no lease: "You have no machine
  tools this turn. A person starts them from the composer: Run on executor →
  Local apps on this machine."

The executor's own name appears only in DMs; in a channel the facts name the
servers, not the machine.

The base agent prompt gains one rule: *"Report only what your tool calls
returned. Never say you started, ran or finished something you did not."*

## 6. Audit

`executor.lease.created` (launch), `executor.run.carried` (lease id,
predecessor run, new run, binding ids, trigger message id, actor),
`executor.lease.ended` (reason, by whom), all in the audit chain beside
`executor.run.launched`.

## 7. The protocol text

New chapter `docs/executor-protocol/conversation-leases.md`, linked from the
overview's table of contents, and the binding paragraph in
`docs/executor-protocol/overview.md` becomes: "Before the worker adds an
executor logical schema to a model request, a human must bind one opaque
candidate to the exact run — either by launching it, or, for the local-apps
pair only, by a later message of their own in the same conversation while
their lease is live, under the structural definition in
[conversation-leases.md](../../executor-protocol/conversation-leases.md). Each
such run is bound afresh and every check runs again." The executor
integration plan gets a pointer.

## 8. Tests (real database, `api/test` / `packages/executor-manage/test`)

- The holder's reply carries; the holder's top-level post elsewhere does not.
- Another member's reply, Continue pressed by another member, Restart pressed
  by another member: nothing carried, reason recorded.
- A drained batch with one message from another member: nothing carried.
- An agent-relayed post authored as the holder (`delegatedByAgentId`), a
  workflow send and a trigger fire: nothing carried.
- A re-driven job with existing bindings: no conflict, no second binding.
- Access revoked, executor paused, descriptor narrowed, End pressed, both
  expiries: lease ended or refused, and a dispatch on an already-carried
  binding is fenced.
- Audit rows for create, carry and end.
