# Executor management reads and agent access

The executor detail surface owns **Agents**, **Permissions**, and **Activity**.
Its doorway is the executor list; the navigation badge points to machines whose
latest local policy proposal awaits a decision the current person may make.

`GET /api/executors/:executorId/agents` lists agents with an explicit private
assignment or at least one currently allowed operation grant on that executor.
`GET /api/executors/:executorId/agent-candidates` lists eligible tool-policy
targets not already in that set. Both require executor management permission,
apply the existing agent privacy boundary, exclude deleted agents, and apply
`q` search before computing the total. Organisation ownership does not expose
another person's private agent. Candidate eligibility matches the existing
tool-policy target kinds: ordinary shared agents and Personal Assistants.

Both routes accept `PaginationParams` plus `q`, return the standard `data` and
`PaginationMeta` envelope with `total`, and use immutable creation time plus id
for a stable keyset. Cursors are opaque to clients. Each row contains
`agentId`, `name`, `visibility`, `assigned`, and `allowedOperationKeys`.
`assigned` reports the explicit private roster entry; stored allowed keys do
not assert runtime readiness. Machine status, reviewed policy, the requesting
human, the agent's logical tool policy, and run scope remain separate gates.
Denied-only grant history does not keep a removed agent in the current list.

The prepared change `{kind: "agent_executor_access", agentId, state}` combines
private roster membership and the existing whole-suite grant. Allow adds both;
deny withdraws both. Project and organisation executors use the existing
whole-suite grant alone. All writes and continuation consumption share one
transaction. The per-agent logical tool policy update runs after continuation
validation in that same transaction; invalid, expired, rejected, or stale
confirmations cannot alter it. The agent policy lock also covers the read of
grants held on other executors, so concurrent changes cannot disable a policy
the agent still holds elsewhere. The existing authorization checks,
per-mutation connection fences, and audit events remain in force.
Confirmation and cancellation atomically claim the same pending continuation;
only one can succeed. A successful cancellation prevents a delayed confirmation
from applying, and a failed confirmation rolls its claim back with its writes.
Failure to grant rolls the new private assignment back. Removing one agent
does not remove another agent's grants on the same machine.

Fresh verification is still required for allowing access, for activating a
capability revision and for private roster changes, including removal. The
lifecycle changes never require it: `revoke` and `remove` only take access
away and must stay reachable by a manager whose sign-in has no fresh factor.
`remove` is `revoke` plus `removedAt`, after which the list, detail, access
and change-preparation reads treat the executor as absent.

The access-change GET response adds `verificationMethod: "password" |
"unavailable"`, derived from the same factor availability as the existing
confirmation guard. It lets the review explain when verification cannot be
completed; it does not introduce an SSO proof or weaken the confirmation
requirement.

`GET /api/executors/attention` returns `{total, executors}`, with one
`{executorId, policyRevision}` per manageable machine whose absolute latest
revision is `pending_review`. Pending pairing and revoked machines are excluded.
Superseded pending revisions, disabled/active policies, and historical workspace
review receipts contribute nothing. Workspace receipts have no resolved or
actionable-state projection and therefore must not be counted as outstanding
decisions. The summary reveals no policy contents or other people's private
machines. The existing navigation `badgeCount` and detail `TabBar.count` render
the summary without fetching every machine's management payload.

## Conversation leases: seeing and ending them

A local-apps launch opens a conversation lease that lets the launching person's
own follow-ups in that conversation keep the pair
([conversation-lease plan](../plans/2026-09-22-executor-local-apps/conversation-lease.md)).
Three routes read and end one; none of them can tell anyone but the holder, or
the machine's administrators, that a lease exists.

- `GET /api/executor-leases?threadId=` returns **only the viewer's own** live
  leases in that thread — `{id, agentId, executorLabel, threadId,
  rootMessageId, wholeThread, launchedAt, expiresAt}`, where `expiresAt` is the
  earlier of the idle and the absolute window, and `wholeThread` is true inside
  a conversation with the lease's agent, where everything the holder sends in
  the thread carries it; otherwise only replies under `rootMessageId` do.
  Everyone else, including the machine's own
  administrators, gets `[]` rather than a refusal, so the answer never confirms
  that a lease or a private executor exists in a shared room. A missing or
  malformed `threadId` is a 400.
- `POST /api/executor-leases/:leaseId/end` is End: the holder, or anyone who
  may manage the executor, ends it with reason `person` and themselves as
  `ended_by_user_id`. Anyone else — and any id that is not a lease — gets 404
  `EXECUTOR_NOT_FOUND`. A lease that had already ended answers
  `{ended: false}`; it is not an error.
- `GET /api/executors/:executorId/leases` lists a machine's live leases for the
  people who may manage it (404 for everyone else), most recently used first
  and bounded at 50: `{id, agent: {id, name}, holderUserId, conversation:
  {channelId, threadId, label} | null, launchedAt, lastUsedAt, expiresAt}`.
  Managing the machine widens nothing else: `agent.name` is null unless the
  ordinary agent entitlement (the Agents tab's rule) shows that agent to the
  reader, and `conversation` is null — not its label, not its channel or thread
  id either — unless the reader could open that conversation under the
  participant rule. An owner's all-channels view does not count, because a
  lease in someone's DM is theirs, and even the id of a private room is more
  than the rule lets them know.

Every change to a lease is announced as `executor.lease.changed {leaseId,
threadId}` on the **holder's** `user` realtime scope and nowhere else: from the
launch that opens (or replaces) it, from End, from any confirmed access change
that ends it (pause, revoke, a narrowed grant, a roster removal, a review that
drops the pair — `confirmExecutorAccessChange` reports exactly the leases its
transaction ended, which the route turns into notices after commit), from a
machine pairing again (`POST /api/executor-pairing/start` revokes its previous
executor row and tells the holders of the leases that ended with it), from the
worker when a follow-up carries it forward and its window moves, and from the
expiry sweep. The payload is ids only; the client's refetch of the first route
is the read. A notice that fails to publish is logged and never fails the
change it follows.

The holder's surface is the composer whose messages would carry the lease, and
no other: a chip — "Minis · local apps · until 21:40 · End" — inside the
toolbar, so the composer at rest stays one line. In a conversation with the
agent (`wholeThread`) that is the main composer, beside **Run on executor**;
where its toolbar has no room the chip folds into a dot on Run on executor. A
launch in an ordinary room carries only in its own reply thread, so its chip is
in that reply panel's composer, which has no Run on executor and keeps the chip
at every width, its label giving way first; the room's main composer shows
nothing, since a top-level post would not carry it. The launcher dialog lists
every one of the holder's leases in the thread with its End. The
administrators' surface is the **Activity** tab's *Local apps in use* list
(agent, conversation, person, last used, End), above the machine's recent
sessions.

## Coding sessions: seeing and closing them

A private executor that offers the built-in coding bridge reports the sessions
open on it, and those sessions act as the person who paired it
([host-coding-sessions.md](host-coding-sessions.md) → "The executor page").

- `GET /api/executors/:executorId/coding-sessions` answers the people who may
  manage the machine (404 for everyone else) with `{canClose, sessions}`: each
  open session its last local-MCP report lists, plus `closing` (a close
  request that reaches it is open) and `ownerAgentName`, the agent driving it,
  null unless the ordinary agent entitlement — the Agents tab's rule — shows
  that agent to the reader. `canClose` is true for the pairing owner of a
  private machine only.
- `POST /api/executors/:executorId/coding-sessions/close {ownerKey,
  sessionId}` is that pairing owner's Close: 202 `{closing: true, sessionId}`
  once a `person` close request is written, which the next heartbeat carries.
  Another administrator — on a shared machine, everyone — gets 403
  `EXECUTOR_CODING_SESSIONS_OWNER_ONLY`,
  anyone else 404 `EXECUTOR_NOT_FOUND`, and a session the last report does not
  list as that owner's and open 404 `EXECUTOR_CODING_SESSION_NOT_FOUND`.

The surface is the coding bridge's entry in the **Permissions** tab's *Local
apps* section: the rows, with Close for the pairing owner, "Closing…" until a
later report drops the row, and for anyone else the sentence saying who may
close them.
