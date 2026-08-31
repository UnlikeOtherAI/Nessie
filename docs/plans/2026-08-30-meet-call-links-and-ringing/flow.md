# Call links + ringing — the new flow, end to end

This chapter continues the numbered design in [the overview](./overview.md).

## 5. The new flow, end to end

### 5.1 Surfaces

- **Channel header button** (`ChannelHeader.tsx` descriptor): idle → "Start
  call"; ringing/active → join affordance (anchor to `meetingUri`) with
  ring/participant state. Eligibility unchanged in spirit (≥ 2 human
  members, PA DM refused) and now consistent client/server.
- **In-channel banner**: "N started a call — Join" (anchor). Driven by the
  channel-scoped events, as today's banner should have been. **Stated
  plainly: a channel call is open to the whole channel.** The banner hands
  the link to every member, so the invite list is a *ring* list (who gets
  woken), never an access list — a declined invitee can still join from the
  banner, and that is the design, not a leak. Anything invite-gated would
  need `TRUSTED` spaces and is out of scope (§12.1).
- **Incoming-call dialog**: new, global (§6.1) — renders anywhere in the
  app, not only on the channel page.

### 5.2 Caller presses Call

`POST /api/channels/:channelId/call` (same route, new behavior):

1. Auth + membership + eligibility as today (human-member count).
2. Resolve the team's `callProvider` (§3.0) and mint the link — Meet space
   under the caller for `google_meet` (typed failures:
   `GOOGLE_NOT_CONNECTED`, `MEET_SCOPE_MISSING`, `GOOGLE_REAUTH_REQUIRED`,
   `MEET_LINK_FAILED`; no `Call` row on failure), random room URL for
   `jitsi` (cannot fail).
3. Transaction: `Call` row (`provider` = the resolved value, `meetingUri`,
   `status='ringing'`, `ringExpiresAt`) + one `CallInvite` per **human,
   currently-active** channel member except the caller (`state='ringing'`).
   "Human, active" means joining `organization_members` on
   `(organizationId, userId)` with `deactivatedAt IS NULL` — a raw
   `channelMember` filter still includes deactivated people, who must get
   neither invites nor rings (the `resolveActingMember` liveness standard).
   The eligibility count uses the same join. Agents are never invited.
4. Post-commit (never inside it, matching the message-create pattern):
   publish realtime (§6.1), enqueue the ring push job (§6.2), enqueue the
   ring-timeout job (§9.3).
5. Return the call record including `meetingUri`.

### 5.3 Caller popup

In-app dialog (never a browser window):

- The link as a real `<a href={meetingUri} target="_blank" rel="noopener
  noreferrer">Join</a>` + copy button. The caller's own join is a direct
  anchor click — zero popup-blocker exposure, and **no auto-open after the
  async create** (that is exactly the pattern blockers kill; we never do
  it).
- Live per-invitee state (ringing / accepted / declined / missed) from the
  same events recipients receive.
- **Cancel** (hang up before pickup) → §9.2. **End call** once active.

### 5.4 Recipient accepts

Accept is a click on the incoming-call dialog (or push notification —
§6.2). **In the browser, the Accept control IS a real anchor** —
`<a href={meetingUri} target="_blank" rel="noopener noreferrer">Accept</a>`
— whose click handler fires the accept POST **without preventing the
default navigation**. The URI is already client-side inside the ring
event, so nothing async precedes the open; the browser performs the
navigation itself, so there is no blocked-detection to get wrong.
(An earlier draft opened via `window.open(..., 'noopener')` and treated
`null` as "blocked" — factually wrong: per the HTML Standard,
`window.open` with `noopener` in the features returns `null` **on
success**, so that design showed a false "blocked" banner on every
accept. The anchor design removes the ambiguity; we also do not claim
anchors are literally never blocked — an aggressive extension or
enterprise policy can still interfere, in which case the dialog stays up
with the link visible for another attempt.) In the shells, Accept is a
button calling the platform opener (§8) — no anchor semantics needed.

The accept POST (`POST /api/calls/:callId/accept`, fired from the click,
with retry) is **idempotent per invitee**: an invite already `accepted`
(the same user's other device won the race) answers 200
`CALL_ALREADY_ACCEPTED` and the device shows nothing alarming — the tab is
open and that's correct, it's the same person. Only a genuinely terminal
call (`missed`/`cancelled`/`ended`) answers `CALL_NO_LONGER_RINGING`, and
the UI then shows the missed state.

Decline is `POST /api/calls/:callId/decline`: no tab, ringing stops on all
of that user's devices.

