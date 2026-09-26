# Executor management reads and agent access

The executor detail surface owns **Agents**, **Sessions**, **Permissions** and
**Activity**. Its doorways are the computers lists (Admin › Computers and Your
settings › Your computers) and a project's Computers tab. [Executor sharing](../standards/executor-sharing.md) is authoritative for
direct agent assignment, people/project/team sharing and immediate signed
capability reports. There is no permission-review badge or queue.

Machine resource permissions belong only to the local executor, independently
for each paired team. Nessie manages people and agent access but exposes no
remote folder/command configuration path; see
[local executor controls](../executor-local-controls.md).

Agent and candidate lists retain pagination, search and the existing private
agent entitlement. Direct agent mutations are atomic with tool-policy changes,
connection fences and audit. The older prepared-change machinery remains for
conversation approvals, lifecycle confirmation and standing ticket policies;
the admin assignment and sharing screens do not use it.

GET /api/executors/attention returns an empty summary: a signed machine report
is configuration, not an outstanding decision. Legacy clients may still read
this endpoint.

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
agent (`wholeThread`) that is the main composer, beside **Run on a computer**;
where its toolbar has no room the chip folds into a dot on Run on a computer. A
launch in an ordinary room carries only in its own reply thread, so its chip is
in that reply panel's composer, which has no Run on a computer and keeps the chip
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

The surface is the coding bridge's entry in the **Sessions** tab's *Local
apps* section: the rows, with Close for the pairing owner, "Closing…" until a
later report drops the row, and for anyone else the sentence saying who may
close them.

## Live machine presence

The admin shell subscribes to `executor_inventory` on the tab's existing
`/api/activity` WebSocket. `executor.status.changed` carries the executor ID,
status, last heartbeat, status detail, update timestamp and removal flag. It
contains no machine label, policy, program, path or session content. Claim,
heartbeat, descriptor, pairing and access-change routes publish committed
state through the shared PostgreSQL realtime transport. Failed advisory
publication does not reject an otherwise accepted heartbeat.

Subscription is restricted to the authenticated organization, and both WS
and user-SSE fan-out check the same live machine visibility as the inventory
before sending presence bytes. Private assignments, project membership and
active organization membership are evaluated for every status event. An older
API replica cannot match the new scope, so rolling deployment does not widen
private machine visibility. The inventory is live-only, not a durable replay
lane. A content-free `executor.inventory.changed` announcement after an access
change causes an authorized REST read, including for a viewer who just lost
access. Every reconnect does the same resynchronization.

The worker checks expired heartbeats every ten seconds under a shared sweep
lock. It also announces recent lazy expirations made by REST reads or command
polls, so those writers cannot swallow an offline transition. Duplicate or
out-of-order presence frames are harmless: the UI compares `updatedAt`, and
in-flight older REST reads cannot overwrite newer presence. The browser does
not poll the inventory to maintain status.

Verification: no browser suite walks the live socket on the computers lists
yet. The account menu's suite, `test:e2e:executor-menu`, was removed together
with the menu's Executors rows and is not a command to run; a replacement
belongs with the Computers surfaces. Database tests cover private-assignment
and membership boundaries; API fan-out tests cover revocation on both live
lanes.

### Existing-session heartbeat receipt

A successful daemon heartbeat includes `existingSessionsAllowed`, derived from
the executor's existing private scope. This adds no grant or authentication
step. The local daemon records its existing authority for at most 60 seconds;
background native session discovery and Claude channel delivery require that
live receipt. Shared scopes, a missing field, failed connection or revoked
connection stop these operations. The owner-only command and view routes keep
their existing authorization checks.
