# Conversation leases

Back to the [executor protocol overview](overview.md).

A person who launches **local apps** (`mcp.tools` + `mcp.call`) for an agent
keeps that reach in the same conversation: their own later messages there bind
the agent to the same machine again, until they end it or it runs out. Nobody
else's messages do, and nothing a system, workflow or agent posts does. Before
the lease, every follow-up, continuation and restart ran with no executor tools,
so each executor session was one fire-and-forget prompt. A ticket's work under
standing machine access is not a lease either: it is a separate path, the
machine owner's one confirmation for one trigger's work, bound afresh at every
wake ([ticket-work-machine-access.md](../standards/ticket-work-machine-access.md)).

The lease never stretches a binding across runs. Each carried run is bound
**afresh**, by the same fenced binder a launch uses, and every check runs again.
What the lease adds is the structural answer to one question: *did the person
who launched this start this run?* The plan that introduced it is
[conversation-lease.md](../plans/2026-09-22-executor-local-apps/conversation-lease.md).

## 1. The lease

`launchExecutorRun` (`api/src/services/executor-run-launch.ts`) opens one in the
launch transaction, through `createExecutorConversationLeaseInTransaction`
(`@nessie/executor-manage`), **only when the bundle is exactly the local-apps
pair**. Browser, connected-browser, coding and command bundles never open one
and never carry: no second run inherits their session
([full-actuation §7](../plans/2026-08-31-executor-full-actuation.md)).

| column | meaning |
|---|---|
| `organization_id`, `executor_id`, `agent_id`, `actor_user_id` | the machine, the agent, and the launching person — the holder |
| `thread_id`, `root_message_id` | the conversation: the launch message is the root the lease covers |
| `launch_run_id` | the run the launch created |
| `operation_keys` | CHECK: exactly `{mcp.tools, mcp.call}`, and never NULL (every array operator is NULL on a NULL array, which a CHECK would pass) |
| `created_at`, `last_used_at` | |
| `idle_expires_at` | `last_used_at + 2 h`, moved on every carry and every executor command sent under the lease |
| `absolute_expires_at` | `created_at + 12 h`; it never moves, and launching again creates a new lease |
| `ended_at`, `ended_reason`, `ended_by_user_id` | CHECK: `ended_reason` is one of the reasons in §3, and is set exactly when `ended_at` is |

The partial unique index `executor_conversation_leases_one_live` allows one
live lease per `(thread_id, root_message_id, agent_id, actor_user_id)`. A new
launch for the same key ends the old lease with `replaced` in its own
transaction. `executor_bindings.lease_id` is a nullable foreign key: the
launch's own bindings and every carried binding name their lease, and a lease
row cannot be deleted while a binding still points at it, because a binding
whose lease vanished would dispatch as though nothing had ever bounded it.

## 2. Who may carry it

Run setup calls `carryForwardExecutorBindings(db, { runId, job })`
(`packages/executor-manage/src/executor-lease-carry.ts`) immediately before
`buildExecutorToolset`. It binds the new run **only when every one of these
holds**, and otherwise binds nothing and returns a reason:

1. The run has no bindings yet (a re-driven job is a no-op, never a conflict).
2. The job's `actorContext.actor` is a `user` whose id equals the lease's
   `actor_user_id`, it is not a channel-policy authorizer, and any
   `effectiveUserId` is the same person.
3. The run is interactive (a live requester, the predicate in
   [global-agents.md](../standards/global-agents.md)).
4. The trigger message is authored by that person **through the person
   composer path**. `api/src/services/message-create.ts` stamps
   `metadata.authorship = 'person'` on messages a signed-in person posts from
   a client; nothing else sets it. Relayed posts (`delegatedByAgentId`),
   workflow sends, inbound email, integrations, trigger fires and
   system-authored messages never carry it. This is an allowlist, not a list
   of exclusions to keep in sync.
5. For a drained batch, **every** message in it satisfies 4 and 7 (the drain
   passes the batch's message ids; a mixed batch carries nothing and says so).
6. For Continue and Restart the job's actor is the presser (per
   `run-policy-replay.ts`) and satisfies 2. A card answer or an approval
   resumes as the **parked run's own actor**, whoever pressed, so every
   continuation must also name its presser — the job's `resumedByUserId`,
   which only `resumeSuspendedRun` sets, from the server-side press — and that
   must be the holder. The replayed trigger satisfies 4 in every case.
7. The new run's conversation root equals the lease's `root_message_id` —
   replies in the launch's reply thread, or the same agent conversation. A
   top-level post elsewhere in the channel starts no carried run.
8. The lease is live (not ended, not past either expiry) and the agent is the
   lease's agent.

Then it re-resolves a **fresh** candidate pinned to the lease's executor for
that person and agent and binds it, setting `lease_id`, so every normal check
runs again: person actor, grants, whole-suite, capability revision, scope, the
agent's channel binding. `bindPinnedExecutorLocalApps` is the one
implementation — `resolveExecutorAvailabilityCandidates` with the internal
`executorId` pin, consumed through `bindExecutorCandidateBundleInTransaction` —
and task-set search binds its processor's machine through the same function.
Refusals are `ExecutorError`s caught there; run setup never throws for them.
The carry runs on every agent's every turn, so run setup also catches anything
else it throws — a lost database connection — logs it, and goes on with the
bindings the run already has and no reach facts, rather than failing a turn
that never needed the machine.

How the code holds the conditions that are easy to get wrong:

- **The person marker (4).** `createThreadMessage` writes
  `metadata.authorship = 'person'` (`PERSON_MESSAGE_AUTHORSHIP` in
  `@nessie/schemas`) only when its caller asks, and exactly two callers ask:
  the composer route `POST /api/threads/:threadId/messages`, which accepts
  session tokens only, and an agent conversation's opening line. Web, desktop,
  iOS and Android all post through that route. A client cannot supply the
  marker — the request body drops unknown keys — and
  `createSystemAuthoredMessage` removes it from any metadata passed on. The
  launch message is the one message that carries without it: the lease itself,
  written in the same transaction by that person's launch, attests it.
- **The batch (5).** When a run picks up messages that queued while another was
  running, the drain in `packages/db/src/thread-serialization.ts` lists every
  one of their ids in the job's `batchMessageIds`. The drain batches the
  agent's whole container thread across reply roots, so outside a conversation
  with the agent each batched message must also sit in the lease's reply
  thread: the holder's own top-level post elsewhere in the room would otherwise
  ride along into a carried run.
- **The press (6).** `resumeSuspendedRun` (`api/src/services/run-resume-core.ts`)
  takes a required `resumedByUserId` and stamps it on the continuation's job:
  the Continue presser, the card's respondent, the approval's resolver. Only a
  uuid is stamped; a continuation with none — the worker's own auto-continue,
  which is not interactive anyway — is nobody's press and carries nothing.
- **The conversation (7).** In a thread that is a conversation with this agent,
  the whole thread is the conversation; anywhere else the new run's root is its
  trigger's `rootMessageId`, or the trigger itself.

Each refusal is returned as an `ExecutorLeaseRefusalReason`, and none of them
names the machine:

| reason | conditions |
|---|---|
| `actor_not_holder` | 2 and 6 — someone else acts, or pressed the Continue, Restart, card answer or approval |
| `not_interactive` | 3 |
| `trigger_not_person` | 4, including a replayed trigger |
| `batch_not_person` | 5 — a batched message that is not the holder's own, or not in this conversation |
| `lease_ended` | 8 — ended, or past either window (an expiry found here is recorded) |
| `executor_unavailable` | the fresh resolution or binding was refused, or the agent is no longer in the room |

**A refusal of a live lease is recorded.** It is written to the audit chain as
`executor.run.carry_refused` (§6), so whoever asks why a follow-up lost machine
tools, or whether someone else tried to reach a holder's lease, has a row to
read. A lease that has ended is recorded once, by its end, and not again by
every later turn in its conversation — nor by the turn that was resolving
when a pause or an End reached it: liveness is read again, under the
executor lock, before the row is written. Writing the row can never fail the
run.

**Dispatch checks again.** `assertExecutorCommandBindingCurrent` treats a
binding whose lease has ended or run out as fenced, so a carried run that
outlives its lease sends nothing more.

## 3. Ending it

Every end is written in the same transaction as the fence that causes it, under
the executor's advisory lock — the lock binding, dispatch and every management
change already take — so "is this lease live?" is answered coherently with the
transition that ends it.

| what happens | `ended_reason` | where |
|---|---|---|
| The holder, or someone who manages the executor, presses End | `person` | `endExecutorConversationLease`, `POST /api/executor-leases/:leaseId/end` |
| The executor is paused | `executor_paused` | `executor-lifecycle.ts` — resuming ends nothing and brings no lease back |
| The executor is drained | `executor_drained` | `executor-lifecycle.ts` |
| The executor is revoked | `executor_revoked` | `executor-lifecycle.ts` |
| The machine pairs again, a pairing is cancelled or rejected on the machine, or a pairing code expires — each revokes the executor row | `executor_revoked`, by the system actor `executor-pairing` | `revokePairingExecutor` (`executor-code-proof.ts`); only pairing again can reach a row that ever connected, and `POST /api/executor-pairing/start` tells those holders after commit |
| A whole-suite deny, a deny of `mcp.tools` or `mcp.call`, or removal from a private executor's roster | `access_revoked` | `executor-access-mutations.ts` |
| A descriptor review leaves the machine without both `mcp.*` keys | `descriptor_narrowed` | `reviewExecutorDescriptorInTransaction` |
| The same person launches local apps again for the same agent and conversation | `replaced` | `createExecutorConversationLeaseInTransaction` |
| The idle or absolute window passes | `expired` | lazily at carry and dispatch; recorded by the worker's `executor-lease-expiry` sweep (`expireExecutorConversationLeases`, every five minutes) |

Anyone else pressing End, and any id that is not a lease, gets 404
`EXECUTOR_NOT_FOUND`. A review that keeps both keys leaves the leases alone:
their existing bindings are fenced by the revision check, and the next carry
binds the new revision afresh.

Every end also asks the machine to close the holder's coding sessions on it,
in the same transaction (`endExecutorConversationLeasesInTransaction` writes
an `executor_coding_session_close_requests` row the next heartbeat carries as
`codingSessionClose`) — unless that person still holds another live lease for
the same agent on the machine: sessions belong to the owner (executor, agent,
person), not to one conversation, and the other conversation may be driving
them. A fence says which it was (`access_revoked`, `executor_paused`,
`executor_revoked`); every other end — a drain's included, so a drain closes
each live holder's sessions, a turn in flight among them — reads
`lease_ended`. A fence says so even when it also finds one of the holder's
leases already past its window: that lease is recorded `expired`, but the
owner's one request names the fence and who pressed it. A new lease for the
same owner withdraws that owner's open
`lease_ended` request, so a relaunch — `replaced` — keeps the sessions it
would otherwise have closed; a fence's request stands, since the authority
those sessions ran under ended, and so does the pairing owner's own Close on
one session from the executor page. Only a private executor's pairing owner
can own a session, and only a machine that ever offered the bridge can hold
one, so no other lease end asks for anything
([host-coding-sessions.md](host-coding-sessions.md)).

## 4. Who can see it

The lease exists for its holder and for the people who manage the machine, and
for nobody else.

- The holder sees their own live leases in a thread — agent, executor label,
  launched at, expires at — as a chip in the toolbar of the composer whose
  messages would carry the lease, and of no other: a chip beside a composer
  that does not carry would promise reach the agent will not have. Inside a
  conversation with the agent the record says `wholeThread` and the chip sits
  beside **Run on executor** in the main composer. A launch in an ordinary room
  carries only in its own reply thread, so its chip is in that reply panel's
  composer and the room's composer shows nothing. Every other reader gets an
  empty list, so a shared room never learns that a lease or a private executor
  exists.
- The executor's administrators see its live leases on the executor page's
  **Activity** tab, with End. The agent's name and the conversation's label are
  shown only where their ordinary visibility rules already would.
- Every change is announced as `executor.lease.changed {leaseId, threadId}` on
  the holder's own realtime scope, and nowhere else.

The routes, their exact records and the admin surfaces are in
[management.md](management.md) → "Conversation leases: seeing and ending them".

## 5. What the agent is told

Run setup turns the carry's outcome, the run's own bindings and the agent's
grants into one system fact (`loadExecutorReachFacts` and
`buildExecutorReachBlock` in `worker/src/run/execute/executor-reach-facts.ts`).
It rides in its own system message **after the clock**, outside the byte-stable
cache anchor: a carried lease moves its window on every run, so these are the
most volatile system text there is. A DeepWater handoff turn carries none, so
its server-authored prompt stays byte-identical. The fact is one of:

- **Bound.** Said only when the built toolset really holds both
  `executor_mcp_tools` and `executor_mcp_call`, never merely because bindings
  exist: "This turn you can use programs on the person's machine through
  `executor_mcp_tools` / `executor_mcp_call` (servers: kelpie). The person
  can keep using this machine in this conversation until 2026-09-23 21:40 UTC
  or until they end it." The servers are the ones the bound revision's
  reviewed policy names, less the coding bridge (the reserved name and the one
  its reviewed facts give), which the pair never reaches; the second sentence
  appears only under a live lease, and says "this machine" because beside
  coding sessions "this session" would read as one of them. When the toolset
  also holds the first-class coding tools
  ([host-coding-sessions.md](host-coding-sessions.md) → "The agent's tools"),
  a sentence names them: "You can have a coding agent on that machine (Claude
  Code, in the folders nessie) do coding work through the `coding_session_*`
  tools: you brief it, follow it, and review what it changed; you never write
  the code yourself." It goes on to list the open sessions this agent holds
  there for the person — at most five, from the local-MCP report the
  machine's last heartbeat carried and filtered by their owner key — or says
  they hold none; a report that listed no sessions at all adds nothing.
  Sessions belong to an owner, not to a lease, so these are the person's
  sessions with this agent on that machine, wherever they began. So a title,
  the first line of a task the person may have written in another
  conversation, is listed only in their own DM, the one place the machine's
  label is also named, and a block that lists one stamps the run's
  disclosure basis with the launch conversation as a coding tool's answer
  does; anywhere else a session is its id and status alone. A machine that
  names only the bridge is told as the coding sentence alone.
  Terminal availability is checked independently from the structured coding
  tools. A terminal-only executor is still bound and its prompt names
  `terminal_session_start`, `terminal_session_read`, `terminal_session_write`
  and `coding_session_close`, with the configured starting folders. It must
  never receive the offline/no-machine-tools sentence merely because it does
  not offer Claude Code or Codex. This applies to both launch and carried turns.
- **A lease exists and did not carry.** "You have no machine tools this turn."
  and one line for the refusal reason — for example "Machine tools only come
  with messages from the person who started the session", "The session ended",
  "The machine is offline or its policy changed; ask the person to start local
  apps again from the composer". A run whose bindings were made under a lease
  that has since ended is told the session ended, and one whose toolset dropped
  a carried pair is told the machine is unavailable.
- **The agent is granted local apps and nothing binds them.** "You have no
  machine tools this turn. A person starts them from the composer: Run on
  executor → Local apps on this machine." Said only when the agent holds both
  keys `allowed` on one executor that is not revoked; any other bundle bound to
  the run says nothing about local apps.

**The executor's own name appears only in a DM that nobody but the person
reads** — a `dm` channel with no other human member. Anywhere else the fact
names the servers, never the machine, because a private executor's label is
not the room's to see. The base prompt carries the rule every one of these
facts depends on: *"Report only what your tool calls returned. Never say you
started, ran or finished something you did not."*

## 6. Audit

Four actions join `executor.run.launched` in the audit chain. The first three
are written inside the transaction they record; a refused carry binds nothing,
so its row is written on its own and outcome `denied`, with the refusal reason:

| action | resource | metadata |
|---|---|---|
| `executor.lease.created` | the lease | agent, executor, launch run, launch bindings, root message, thread |
| `executor.run.carried` | the new run | lease, predecessor run, new run, binding ids, trigger message, holder, agent |
| `executor.run.carry_refused` | the new run | lease, reason, holder, the press behind a continuation (`resumedByUserId`), trigger message, agent, executor — never its label |
| `executor.lease.ended` | the lease | reason, who ended it, holder, agent, executor, thread |

The predecessor of a carried run is the run it continues or restarts, otherwise
the lease's newest earlier bound run, otherwise the launch run. An expiry is
recorded with the system actor `executor-lease-expiry`, since no person ended
it.

## 7. Verifying

```bash
DATABASE_URL=… pnpm --filter @nessie/executor-manage test
DATABASE_URL=… pnpm --filter @nessie/api exec node --test --import tsx \
  test/executor-conversation-lease-postgres.test.ts test/executor-lease-routes.test.ts \
  test/executor-lease-resume-paths.test.ts
pnpm --filter @nessie/worker exec node --test --import tsx \
  src/run/execute/executor-reach-facts.test.ts src/run/execute/prompt.test.ts
DATABASE_URL=… pnpm --filter @nessie/worker exec node --test --import tsx \
  test/db/executor-reach-facts.test.ts
pnpm --filter @nessie/admin test:e2e:executor-lease
```

`executor-lease-carry.test.ts`, `executor-lease-ending.test.ts` and
`executor-lease-pairing.test.ts` drive every carry, refusal and end against a
real database. `executor-lease-resume-paths.test.ts` drives Continue, Restart,
an approval and a card answer through their real services with another member
pressing, and hands the job each one enqueued to the carry. The worker's facts
suites pin every variant and that none of them enters the cache anchor; its
database suite pins where the machine's name may appear. The fixture suite pins
the holder's chip in the composer that carries it and nowhere else, its absence
for everyone else, and End.
