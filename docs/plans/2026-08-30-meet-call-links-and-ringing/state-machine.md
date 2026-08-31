# Call links + ringing — call state machine

This chapter continues the numbered design in [the overview](./overview.md).

## 9. Call state machine

### 9.1 Schema evolution

`Call` gains `provider` (`'google_meet' | 'jitsi' | 'microsoft_teams'`,
stamped from the team setting at creation; legacy embedded-era rows backfilled
`'jitsi_embedded'` to stay distinguishable), `meetingUri` (nullable on
legacy), `ringExpiresAt`,
`createdViaAgentId` (nullable), and `status` widens: `ringing | active |
ended | missed | declined | cancelled` (stays a string column; values
validated in code — and `mapCallRecord`, which today collapses everything
non-`ended` to `active` (`api/src/services/calls.ts:29`), grows with the
new states or the banner would show `ringing` as an active call).
**`roomId` becomes nullable**: link-provider calls have no room id, legacy
rows keep theirs, the `@unique` survives on the non-null values. New model
`CallInvite`: `callId`, `userId`, `state` (`ringing | accepted | declined |
missed | cancelled`), `respondedAt`, `@@unique([callId, userId])`.
`CallParticipant` is retired from the new flow (provider-side presence is
unobservable) but kept for history.

New routes: `POST /api/calls/:callId/accept` / `.../decline` /
`.../cancel`; the create/end routes keep their paths, and **`POST
/api/calls/:callId/join` and `/leave` are deleted with the overlay** —
against a `ringing` row they could only ever 409, and nothing calls them
once Jitsi-embed dies. Every invite-mutating route checks the actor **is
the invitee** (accept/decline) or the caller (cancel/end), on top of
channel membership; not-a-member stays `404 CHANNEL_NOT_FOUND` (never a
403), preserving the existing no-existence-probing semantics.

### 9.2 Transitions (conditional updates, race-safe)

- `ringing → active`: first accept (`WHERE status='ringing'`; later
  accepts don't regress — guard `IN ('ringing','active')` for the invite
  side).
- `ringing → cancelled`: caller cancels; remaining `ringing` invites →
  `cancelled`.
- `ringing → declined`: the last still-ringing invite declines and none
  accepted.
- `ringing → missed`: ring timeout with zero accepts; `ringing` invites →
  `missed`. The **worker's ring-timeout handler** (it already runs there)
  writes a server-authored "Missed call from N" message in the channel —
  **`assistant`-role with typed `metadata.kind='call_missed'`, never
  `role='system'`**: the feed reader explicitly excludes system rows
  (`api/src/services/messages.ts` — they are internal kickoff prompts), so
  a system-role notice would simply never render. Fixed server copy in the
  `agent-message.ts` docstring's exempt group, like
  `comms-card.ts`/`trigger-run.ts`; empty disclosure basis is correct
  because the copy derives only from channel-visible facts — it never
  includes invitee states or the `meetingUri`. Plus a durable `UserAlert`
  per missed invitee. That alert is a **new alert kind** (`call_missed`),
  which is a cross-stack addition, not one line: the alert contract, the
  admin alerts facade rendering, the bell copy, and its own read-time
  revalidation (alive while the call row exists; kinds each carry bespoke
  revalidation in the attention path). `eventKey =
  call:<callId>:missed:<userId>`.
- `active → ended`: explicit end by the caller or an accepted invitee
  (§9.4's participant definition), or the expiry sweep. Nessie **cannot
  observe** provider-side hangup — no Workspace Events subscription in
  scope — so `ended` is honest bookkeeping (§12.2).
- Invite-level: `ringing → accepted | declined | missed | cancelled`, each
  one-way; a late accept answers `CALL_NO_LONGER_RINGING` and the client
  shows missed-state with the link still one honest click away.

### 9.3 Timers are durable, never in-process

- **Ring timeout** (`NESSIE_CALL_RING_TIMEOUT_MS`, default 45 s): delayed
  queue job enqueued at creation. Delay support exists only in the
  runtime's `PgQueueProvider.enqueue` (`delayMs` → future `enqueued_at`,
  claimed by `enqueued_at <= now()`); the API-side `enqueueQueueJob`
  helper in `@nessie/db` takes no delay — so that helper **gains a
  `delayMs` option** (same future-`enqueued_at` write) in slice 2 rather
  than the API growing a second enqueue path. Handler: re-read the call,
  then conditional UPDATEs only — call `WHERE status='ringing'`, invites
  `WHERE state='ringing'` — so crash/double-delivery is harmless **and a
  concurrently-accepted invite can never be stomped to `missed`** (the
  same `WHERE state='ringing'` shape applies to the cancel path). Never
  `setTimeout` in the API.
- **Active-call expiry**: periodic sweep flips `active` calls older than
  `NESSIE_CALL_MAX_ACTIVE_HOURS` (default 8 h) to `ended` so the banner
  cannot stick forever.

### 9.4 Concurrency

One ringing-or-active call per channel — **enforced by a partial unique
index** (`calls(channel_id) WHERE status IN ('ringing','active')`), not by
the existing check-then-create (which races under concurrent creates: two
transactions can both pass the in-tx check today). The second presser's
insert violates the index → mapped to `ACTIVE_CALL_EXISTS` → the client
shows the join affordance. Accept/decline/cancel/timeout all run in a
transaction that locks the `Call` row (`SELECT … FOR UPDATE`) before their
conditional invite updates, verify affected-row counts, and publish
events / enqueue cancel pushes only after commit from the transition that
actually won.

**End authority and read visibility, made consistent:** a "participant" of
a link call is an invitee whose invite is `accepted` (provider-side
presence is unobservable). **End** is allowed to the caller or any
accepted invitee; **cancel** (pre-pickup) is caller-only. Read visibility
follows the §5.1 channel-open decision: `GET .../call` keeps
`getVisibleChannel`, so a public-channel viewer sees the banner and the
link — deliberate, matching public channels' readability. Every lookup by
`callId` resolves through `Call.channel.organizationId` before returning
anything; invitee routes additionally constrain on `userId`.

