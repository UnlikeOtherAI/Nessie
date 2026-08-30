# Call links + real ringing — Google Meet by default, Jitsi per team, replacing the embedded call

**Status:** Implementation in progress — Slice 1 complete · 2026-08-30
**Provider decision (made by the product owner, 2026-08-30, amended same
day):** the link provider is a **per-team setting** — **Google Meet (the
default)**, **Jitsi**, or **Microsoft Teams**. Pressing the phone icon does
whatever the team chose: a Jitsi team gets a Jitsi link on click, a Teams
team a Teams link. The agent, when asked, can mint a link with any provider
the asking user's connections support, and can remind people about a call
through ordinary messaging. Whatever the provider, the call is a **link
opened in a tab**: the ring/accept/popup-blocker/native design below is
provider-agnostic, and the embedded Jitsi iframe dies regardless.

## 0. Summary

Today's Call button starts an **embedded Jitsi call** inside the admin: it
creates a channel-scoped room, renders a Jitsi iframe overlay, and informs
only people who happen to be looking at that channel. Nobody's device rings —
discovery is a 5–30 s poll that only runs on the open channel page.

This plan replaces that with a **generate-a-call-link + ring** flow:

1. Caller presses **Call** (same surfaces the button lives on today).
2. The server mints a call link — by the channel's **team setting**, a
   **Google Meet** link under the caller's own Google connection (default)
   or a **Jitsi** room URL (no auth needed) — and creates a `ringing` call
   with one invite per recipient.
3. A popup on the caller's screen shows the link (copyable, joinable as a
   plain anchor) and live per-recipient ring state.
4. Every **recipient device** rings like an incoming call — user-scoped
   realtime for open clients, Web Push / APNs / FCM for closed ones.
5. **Accept opens the Meet link in a new tab**, synchronously in the click
   handler so popup blockers cannot eat it (§7). In the native shells the
   link opens in the system browser via each shell's opener (§8).
6. Pickup on one device cancels ringing on the user's other devices; decline,
   ring-timeout → missed, and caller-cancel are first-class states (§9).
7. An **agent tool** mints the same link (and can ring a channel), under the
   run's requesting user's Google connection (§10).

The embedded Jitsi surface (iframe overlay, `external_api.js` loader) is
**removed**, not kept as a fallback — that also retires three standing
hazards: rooms on public `meet.jit.si` with guessable names and no auth, an
admin CSP that would kill the Jitsi frame the day it stops being
report-only (`infrastructure/docker/admin-nginx.conf` has no `frame-src`),
and shells that lack mic/camera entitlements for in-webview calls (the App
Store desktop entitlements carry no `device.camera`/`.audio-input`; the
mobile shell has no `NSMicrophoneUsageDescription`). The call now happens in
Google's own tab/browser, where none of that is Nessie's problem.

## 1. Current state (verified against code, not the 2025 spec)

[docs/video-calling.md](../video-calling.md) describes the Jitsi feature;
its Phase 1 is genuinely built, with drift:

- **API** — `api/src/routes/calls.ts`: `POST /api/channels/:channelId/call`
  (refuses the PA DM, requires ≥ 2 channel members, 409
  `ACTIVE_CALL_EXISTS`), `POST /api/calls/:callId/join`, `POST
  /api/calls/:callId/leave` (last leaver auto-ends), `DELETE
  /api/channels/:channelId/call` (force-end — any member, despite the spec
  saying starter/admin), `GET /api/channels/:channelId/call`. Service:
  `api/src/services/calls.ts` (room id `nessie-<8 hex>-<hex ms>`).
- **DB** — `Call` (`roomId @unique`, string `status` active|ended,
  `startedById`, timestamps) + `CallParticipant` (`@@unique([callId,
  userId])`), `api/prisma/schema.prisma:4421`.
- **Admin** — exactly **one** call button: the channel header action
  (`ChannelHeader.tsx:126` descriptor into `ResponsivePageHeader`; handler
  `useChannelCall.ts:68`), plus the join button on the in-channel
  `CallBanner.tsx` and the overlay's own leave/minimize. Eligibility is
  client-side `channelUsers.length >= 2` (humans) but server-side
  `channelMember.count >= 2` (includes agents) — a real mismatch. Jitsi is
  hard-coded `meet.jit.si` (`admin/src/lib/jitsi.ts:3`); the spec's
  `JITSI_DOMAIN` env, CallContext, `GET /api/calls/:id`, system messages,
  and JWT phase were never built.
- **Discovery is polling.** `useActiveCall` refetches every 5 s in-call /
  30 s idle. The admin WS handler has no `call.*` case; unknown WS frames
  are silently dropped.
- **Live defect, confirmed:** the four `call.*` publishes throw. Every WS
  publish goes through `WsEventSchema.parse`
  (`packages/runtime/src/realtime.ts:296`) and the union
  (`packages/schemas/src/realtime-ws.ts:400`) contains no `call.*` literal —
  so each call action 500s *after* its transaction commits: the caller of
  `POST .../call` gets a 500 **with the call created**, a retry answers
  `ACTIVE_CALL_EXISTS`, and the UI limps along on the poll. Any new ring
  event starts by extending
  `WsEventMap`/`WsEventNameSchema`/`WsEventSchema`; this plan's events fix
  that defect structurally rather than patching the old names in.
- **No ringing of any kind today**: no push, no sound, no toast, no system
  message, no `call.*` client subscription. The banner requires already
  viewing the channel.
- **Shells**: desktop (Tauri) and mobile (Expo WebView) contain zero
  call-specific code. Desktop has `tauri_plugin_opener` permitted and
  already used for external auth (`admin/src/lib/external-auth.ts:32`).
  Mobile has **no generic open-external bridge** — its only external-open
  path is the auth-hardwired `WebBrowser.openAuthSessionAsync`
  (`mobile/src/lib/external-auth-session.ts`), and `App.tsx` sets no
  `onShouldStartLoadWithRequest`, so untrapped links navigate *inside* the
  WebView.

## 2. What "replace" means

- The channel-header Call button keeps its slot and icon; its action becomes
  **create call link + ring** (provider per §3.0). The banner survives as "Call happening —
  Join" where Join is a plain anchor to the Meet link.
- Deleted: `CallOverlay.tsx`, `CallBanner`'s Jitsi-join wiring,
  `admin/src/lib/jitsi.ts`, the Jitsi globals/types, the unused
  `useEndCall`-as-overlay plumbing. The removal's **security-config
  fallout** goes with it: the admin nginx `Permissions-Policy` currently
  grants camera/microphone/display-capture "for in-browser video calls"
  (`infrastructure/docker/admin-nginx.conf:8`) and
  `docs/deployment.md` tells operators not to tighten it — both revert to
  deny-by-default since no in-browser call remains. Doc sweep:
  `docs/video-calling.md` → `docs/done/` with a banner pointing here, and
  the live Jitsi references in
  `docs/plans/2026-05-30-slack-parity-plan.md` get corrected.
- `Call`/`CallParticipant` stay, extended (§9.1); old rows become history.
  The migration force-ends any `active` Jitsi call (no UI remains to join
  it).
- The client/server eligibility mismatch is fixed while we're in there: the
  server counts **human** members (same predicate the client uses), so both
  agree.

## 3. Link generation — provider by team setting

### 3.0 The team setting

`Team.callProvider` — string column, `'google_meet'` (default) | `'jitsi'`
| `'microsoft_teams'`, on the `Team` model (`api/prisma/schema.prisma:1365`; the model has no
settings fields today, and there is **no team-update route** — only
`GET/POST /api/teams` + member add — so this ships with a new
`PATCH /api/teams/:teamId/settings`, org owner/admin-gated). Resolution at
call time: channel → its team → `callProvider`. The provider used is
stamped on the `Call` row, so a mid-flight settings change never mutates an
existing call. The setting is a **default, not a lockout**: the agent tool
may mint the other provider on the user's explicit request (§10) — it
carries the user's own Google authority either way. The human Call button
always follows the team setting (no per-call picker in v1; §12).

**Surface (Rule zero):** there is no team-settings page; per-team controls
live as rows on org-level pages (the Integrations page's per-team DeepWater
enablement is the precedent). Home: a **Calls** section on
`/settings/organization` listing each team with a provider select. In-context
doorway: the caller popup names the provider ("via Google Meet"), linking to
the setting for owners/admins.

The `createMeetingLinkForUser` seam (§3.4) becomes
`createCallLinkForTeamUser(prisma, {teamId, userId})`, dispatching on the
resolved provider — this is the provider seam §4 calls deliberately
provider-shaped, now with its second implementation. Everything downstream
(ring, accept, popup, state machine, shells) sees only a URL.

### 3.1 Meet API choice — Meet REST `spaces.create` (chosen)

`POST https://meet.googleapis.com/v2/spaces` with the user's OAuth bearer
returns `{ name, meetingUri, meetingCode, config }` — an instant link
(`https://meet.google.com/xxx-yyyy-zzz`), no calendar event. Scope:
`https://www.googleapis.com/auth/meetings.space.created` — the narrowest
Meet scope, but stated precisely: it allows creating **and managing
(reading/modifying) spaces this app created** — not "create-only" — and
Google classifies it **Sensitive**, so adding it to the production consent
screen requires justification + verification **before** deployment, a
pre-deployment gate rather than a maybe-follow-up (§3.5). Works for
consumer Google accounts and Workspace alike.

Rejected: Calendar `events.insert` + `conferenceData.createRequest` — needs
the far broader `calendar.events` write scope and leaves an event on the
user's calendar per ad-hoc call. Revisit only if scheduled meetings with
invitations become a goal.

Space config: `accessType: OPEN`, so recipients join from the link without
Google-side invites (they may not have Google accounts). The link is a
capability; accepted tradeoff recorded in §12 (parity with today's
public-Jitsi rooms, which are strictly worse — guessable names).

### 3.2 Whose Google account (Meet teams only)

**The initiator's.** Minted under the caller's per-user Google
`CommsConnection` (Individual Communications Connector). For the agent tool,
the initiator is the **run's requesting user** (§10). No org-level service
account. A user without a Google connection gets a typed refusal and the
existing connect path (`/settings/connections`, or the PA's
`comms_connect_card`). Teams set to `jitsi` never touch Google — no
connection, no scopes, no refusal states (§3.6).

### 3.3 OAuth scope — new connections and re-consent

Today's Google comms config requests `gmail.readonly openid email profile`
(`api/src/routes/comms/oauth-config.ts:51`; PKCE, `access_type=offline`,
`prompt=consent`). Changes:

- Add `https://www.googleapis.com/auth/meetings.space.created` to the scope
  list and `include_granted_scopes=true` to `extraParams`, so re-auth is
  incremental.
- The credential already records `grantedScopes`
  (`packages/comms-google/src/connector.ts:73`); the link service checks for
  the Meet scope **before** calling Google and returns typed errors —
  `GOOGLE_NOT_CONNECTED` vs `MEET_SCOPE_MISSING` vs
  `GOOGLE_REAUTH_REQUIRED` — so the UI/PA names the exact fix and links the
  same OAuth start route. No silent escalation; the user re-consents.
- Token refresh and `needs_reauthorization` handling reuse the comms
  credential machinery unchanged (encrypted `CommsConnectionCredential`).

**First use, concretely:** a caller who has never connected Google clicks
Call → the popup renders the `GOOGLE_NOT_CONNECTED` state with a Connect
button → the standard comms OAuth flow (now carrying the Meet scope) → back
in the popup, Call retries. One-time per user.

**Design decision (flagged):** extend the *comms* Google connection rather
than adding a second Meet-only Google link. One Google identity per user,
additive scopes, existing connect UX. Cost: the so-far read-only comms
connector gains one create-only action scope (§12.6).

### 3.4 Where the code lives

- Meet HTTP client (space create) in **`@nessie/comms-google`** beside the
  Gmail client — it owns Google HTTP already. Outbound via `safeFetch` per
  the egress rule; bearer headers and provider bodies carrying token
  material are never logged.
- **A shared, DB-aware credential coordinator — correcting an earlier
  draft:** `@nessie/comms-connect` deliberately has **no Prisma
  dependency** (interfaces + crypto only), and today the API and worker
  each hold their own copy of credential decryption
  (`api/src/routes/comms/context.ts`,
  `worker/src/control/comms-persistence.ts`). The link service must not
  become a third copy: the coordinator (new db-aware module, home decided
  at implementation — beside the existing two so they can converge on it)
  loads the owned connection, decrypts narrowly, refreshes with
  concurrency control, **preserves the stored refresh token when the
  provider omits a replacement** — fixing the existing defect where the
  reconnect upsert writes `refreshTokenCiphertext: null` unconditionally
  (`api/src/routes/comms/persist.ts`) — persists expiry/scope changes, and
  atomically marks `needs_reauthorization`.
- **Which connection:** the schema allows several Google connections per
  user (uniqueness includes external tenant/user ids). v1 uses the single
  active connection holding the Meet scope; several qualifying → the most
  recently authorized, and the popup names the account. The OAuth callback
  today lands on `/settings/connections`; the connect-from-popup flow
  carries a **return intent** so re-consent resumes the call popup instead
  of stranding the caller in settings.
- Call orchestration (`startCallForUser`: mint + `Call`+`CallInvite` rows +
  ring kickoff) in **`@nessie/workspace-admin`**, re-exported by
  `api/src/services/calls.ts` — because the worker tool must call the same
  function and `api/src/services/*` is unreachable from the worker (the
  provisioning-tools precedent).

### 3.5 Google Cloud project setup (deployment prerequisite)

One-time, per deployment (the production Google OAuth client):

- Scriptable with `gcloud`: project selection and
  `gcloud services enable meet.googleapis.com`.
- **Not scriptable**: the OAuth consent screen for an *external* app and the
  standard web-application OAuth client id/secret have no public API —
  `gcloud`'s OAuth surfaces (`iap oauth-brands`/`oauth-clients`) cover only
  internal IAP brands. Creating/updating the consent screen (add the Meet
  scope to the declared scopes) and the web client stays a Cloud Console
  step, documented in `docs/deployment.md`.
- Output lands in the existing env: `NESSIE_COMMS_GOOGLE_CLIENT_ID` /
  `..._SECRET`. Publishing status: an external consent screen in "testing"
  caps at 100 test users and expires refresh tokens after 7 days —
  production must be "in production" (the Meet scope is non-sensitive-ish
  but Gmail readonly already forces Google verification; that verification
  burden exists today and does not change materially).

### 3.6 Jitsi as a link provider (team opt-in)

A team set to `jitsi` mints
`https://${NESSIE_JITSI_DOMAIN}/nessie-<128-bit base32 random>` — pure URL
construction, no OAuth, no network call, no per-user setup. Notes:

- `NESSIE_JITSI_DOMAIN` (default `meet.jit.si`) replaces the client
  hard-coded constant (`admin/src/lib/jitsi.ts:3`) server-side; a
  self-hosted Jitsi is just a different domain.
- The cryptographically random room id retires today's guessable
  `nessie-<8 hex of channel uuid>-<hex ms>` naming — on a public Jitsi
  server the room name **is** the access control, so this matters.
- Same capability semantics as an OPEN Meet space: whoever holds the link
  joins. Same ring flow, same tab-open, same state machine.
- The call still happens in a separate tab on the Jitsi page — the embedded
  iframe/overlay is **not** retained for jitsi teams.

### 3.7 Microsoft Teams as a link provider (team opt-in)

Microsoft Graph `POST /me/onlineMeetings` (scope `OnlineMeetings.ReadWrite`)
returns a `joinWebUrl` — the same shape as a Meet mint: created under the
**initiator's** Microsoft connection. The comms connector already plans a
Microsoft provider (`CommsProvider` includes it; the adapter package and the
`NESSIE_COMMS_MICROSOFT_*` OAuth config are the unbuilt half), so the Teams
mint rides that connection exactly as Meet rides Google — typed
`MICROSOFT_NOT_CONNECTED` / `TEAMS_SCOPE_MISSING` refusals, encrypted
credential bundle, same `needs_reauthorization` semantics. The team setting
only offers `microsoft_teams` when the deployment has the Microsoft OAuth
provider configured (an unconfigured provider is unselectable, named in the
UI — never a dead toggle, per the trigger-health precedent). **Sequencing
decision for the owner (§12.10):** the Microsoft comms connection is real
work (Azure AD app + adapter package); v1 can ship Meet + Jitsi with the
provider seam and setting already three-valued, Teams landing with the
Microsoft connector — or the Microsoft OAuth leg gets pulled forward. The
seam and the ring flow are identical either way.

## 4. Provider decision — recorded

**Decided: per-team setting — Google Meet default, Jitsi and Microsoft
Teams opt-in** (owner's calls, 2026-08-30; Teams first deferred, then
explicitly reinstated: "some people wanna just create a Teams link").

| Option | Outcome / notes |
|---|---|
| **Google Meet** ✅ default | Instant links via a create-only scope; recipients need no Google account to join an OPEN space; rides the existing Google connection. |
| **Jitsi (link, not embed)** ✅ team opt-in | Zero-setup link mint for teams without Google connections or with a self-hosted Jitsi; the embedded iframe still dies. |
| **Microsoft Teams** ✅ team opt-in | Graph `onlineMeetings` under the initiator's Microsoft connection; needs the planned-but-unbuilt Microsoft comms OAuth leg (§3.7); selectable only where configured. |
| Embedded Jitsi (status quo) | Out. Keeps a media surface Nessie must own (entitlements, CSP, TURN/JWT) — the thing being removed. |

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

## 6. Ringing — signaling and push

### 6.1 Open clients: user-scoped realtime

Today's `call.*` events were channel-scoped, which is why nothing rings.
The ring is **user-scoped**: `WsScopeSchema` already has
`user{organizationId,userId}` (`packages/schemas/src/realtime-ws.ts:434`),
and the user-SSE stream (`GET /api/events/stream`) already resolves and
delivers user scopes — the alerts pipeline (`alert.created`) is the working
precedent. The admin WS never subscribes user scopes, so the incoming-call
listener rides the **user SSE stream** like alerts do; no WS protocol
change.

New events (added to `WsEventMap` + `WsEventNameSchema` + `WsEventSchema`,
which also structurally fixes the §1 defect):

- `call.incoming` — to each invitee, user-scoped:
  `{callId, channelId, channelName, caller:{id, displayName, avatarUrl},
  meetingUri, expiresAt, revision}`.
- `call.invite.updated` — `{callId, userId, state, revision}`; to that
  invitee (all their devices: stop ringing) and to the caller (popup
  state).
- `call.updated` — `{callId, channelId, status, meetingUri, revision}`.

**One publication per audience — never mixed scopes.** The replay store
persists only the *first* channel scope and *first* user scope of a
publication (`realtime-events.ts` `append`), and the hub treats the
presence of any user scope as user-only, ignoring channel scopes beside
it — so a single `call.updated` carrying channel + N user scopes would
skip the banner and replay to one user. Each transition therefore
publishes a channel-scoped event for the banner **plus one user-scoped
publication per recipient**, exactly as the mention-alert fan-out already
does.

**Reconnect is reconciliation, not replay-trust.** Events persist ~24 h
and `Last-Event-ID` replay can resurface a `call.incoming` that has since
expired or been cancelled. The incoming-call reducer applies events in id
order, keeps terminal tombstones per `callId` (with `revision` so a
reordered ring can never resurrect a cancelled call), ignores invites past
`expiresAt`, and **re-fetches current call state before starting any
ringtone after a reconnect** — sound only ever plays for a
server-confirmed live ring. The listener is its own SSE reader beside the
three existing independent readers of `/api/events/stream` (alerts,
message notifications, thread activity) — a fourth reader is the accepted
cost; consolidating them into one broker is worthwhile but is not this
feature's yak.

A global **`IncomingCallProvider`** at the admin root renders the ring
dialog and plays the ringtone. Ringtone honesty: browsers block audio in
tabs that have had no user gesture; those tabs ring visually and the push
notification carries the sound. No autoplay hacks. **Focus mode and quiet
hours mute the ringtone/vibration in-app too** — the preference's stated
meaning is that focus mutes attention cues, not just push — while the
dialog stays visible. And the caller popup phrases state honestly:
"waiting for responses", never "ringing on N devices" — SSE may be down
and push may be disabled, denied, or unsupported, so delivery is never
claimed, only responses.

### 6.2 Closed clients: push (Web Push + APNs/FCM)

Modeled on `handleAttentionDispatch`
(`worker/src/control/attention-dispatch.ts`) — the existing single-recipient,
entitlement-rechecking path over `deliverToRecipients` — as a new worker job
(`call.ring-dispatch`) fanned out per invitee, plus a matching cancel job.
Specifics the existing pipeline does NOT give us, each an explicit change:

- **Surface suppression must be bypassed.** `deliverToRecipients` drops
  recipients currently viewing the destination surface
  (`push-delivery-core.ts` `findRecipientsViewingPushSurface`) — correct
  for messages, wrong for a ring (the open tab shows a dialog, but the
  *other* devices must still ring). The ring dispatch passes an explicit
  no-suppression flag; de-dupe is client-side on `callId` (the SSE dialog
  and the push share the tag).
- **New preference kind** `pushIncomingCalls` (matching the existing
  `pushMessages`/`pushMentions` naming) in `UserPreferencesSchema` +
  `shouldSuppressPushForPreferences`, default on. **Quiet hours and focus
  mode suppress the ring push** like everything else — a ring is not above
  the user's own do-not-disturb (the realtime dialog still appears; §12.3
  flags the alternative). The **missed-call push respects the same
  suppression** — a person whose quiet hours silenced the ring must not be
  buzzed 45 s later about having "missed" it; the durable alert row and the
  channel message still exist for when they look.
- **Web Push:** payload is E2E-encrypted (RFC 8291), so `meetingUri` may
  ride in it. `admin/public/sw.js` gains: `actions: [Accept, Decline]`,
  `requireInteraction: true`, `renotify`, a stable `tag: call-<callId>`, an
  `event.action` branch in `notificationclick`, and a `notificationclose`
  handler (dismiss ≠ decline; it just stops that device's banner). Accept
  in the SW: `clients.openWindow(meetingUri)` **first** (a notification
  click is user-gesture-bearing; no await before it), then `waitUntil` the
  accept POST. **The SW cannot authenticate that POST the normal way** —
  the API is bearer-token-only (tokens live in the SPA's memory) and the
  refresh cookie is scoped to `/api/auth` on a different production
  subdomain — so the encrypted push payload carries a **single-use signed
  action token** bound to `(callId, userId, action, expiry, revision)`,
  and `POST /api/calls/:callId/respond` accepts it as the sole
  unauthenticated path: it can flip exactly one invite's state and
  returns nothing (no `meetingUri`, no call record). The call routes
  themselves stay fully authenticated. A **plain click** (no action
  button) is *not*
  an unambiguous accept: it opens the app at the channel with the ring
  dialog up, preserving today's deep-link behavior. **Degraded paths,
  stated:** iOS PWA has no action buttons (plain-click path only); and
  cross-origin `openWindow` from a SW is not uniformly reliable outside
  Chromium — where it refuses, the SW opens same-origin
  `/channels/:id?acceptCall=<callId>` instead and the page completes the
  accept and offers the Meet anchor for a real click (the §7 gesture logic,
  applied once more).
- **Native push (APNs/FCM) carries no `meetingUri` — deliberately.** The
  mobile shell treats notification data as untrusted by design:
  `pathFromPushData` accepts only internal `'/'`-prefixed paths, with a
  comment saying exactly why (`mobile/src/lib/push-navigation.ts:4-9`), and
  this plan does not weaken that. The native ring push carries the call id
  and an internal path (`/channels/:id?incomingCall=<callId>`); tapping it
  boots the app into the incoming-call dialog, which fetches the call and
  opens the link through the §8 bridge on Accept — the tap-then-accept
  gesture chain tolerates that one fetch, since `Linking.openURL` is not
  popup-blocked.
- **Ring cancel over push:** a cancel push with the same `tag`; the SW
  closes the matching notification (`registration.getNotifications({tag})`)
  and shows nothing (where a platform insists on a visible notification per
  push, it shows a silent self-closing one). Native: FCM collapse key /
  `apns-collapse-id` = the call id.
- **Native shells** get a high-priority push — which is real payload and
  shell work, not a flag: `PushPayload` today has no priority, category,
  or cancellation fields, FCM sets no `android.priority`, and the mobile
  shell has one generic `nessie-messages` channel and can only dismiss
  **all** notifications at once. Slice 3 therefore adds payload fields
  (priority, category, call id, revision), a dedicated high-importance
  call channel/category, and per-identifier dismissal handling in the
  shell. Where a shell predates that handling, honesty over pretense: the
  ring notification stays until the app next opens. Stated plainly: on a
  closed/locked native device this is a **high-importance notification
  plus in-app ringing once opened** — "rings like an incoming call" in
  the OS-native CallKit sense is exactly the §12.4 non-goal.
- **Stale-client rollout:** an old service worker shows every push as a
  visible notification — including a cancel push. The call/cancel payloads
  are versioned; ring/cancel dispatch to Web Push begins only after the
  new SW protocol has shipped (SWs `skipWaiting`, so the window is short
  but real), and native delivery gates on the recorded `appVersion` of the
  device token.

### 6.3 Multi-device and cancel-on-pickup

The invite is **per user**; devices are fan-out (there is deliberately no
per-device roster — `UserPresence` is a per-user counter and
`UserPushSurfacePresence` collapses to user ids on read; building one for
this would be speculative). Every device of an invitee rings. The first
`accept` wins a conditional update (`WHERE state='ringing'`); the resulting
`call.invite.updated` + cancel push stop the user's other devices. Two
devices accepting simultaneously is harmless — the loser still opens the
Meet tab (the link is a capability) and the invite stays `accepted`.

## 7. Popup-blocker strategy (the load-bearing design)

Browsers allow `window.open` only inside a user-activation call stack; any
`await` between click and open forfeits it. Restated as rules:

1. **The Meet URI travels in the ring payload** (SSE event *and* push), so
   Accept never fetches before opening — the open is the first synchronous
   statement of the click handler; the accept POST follows.
2. **The caller never auto-opens.** The popup presents an anchor; the
   caller's join is its own click. Never "create link, then `window.open`
   when the response arrives".
3. **Notification accepts use `clients.openWindow` inside
   `notificationclick`** — spec-defined as gesture-bearing. Same ordering
   rule: open first, `waitUntil` the fetch after.
4. **Blocked anyway → anchor fallback**, never a retry: any
   `window.open === null` path swaps in a visible "Join call" anchor. An
   `<a target="_blank">` on a real click is never blocked.
5. **No cross-device auto-open** ("accepted on phone → also open on
   desktop"): there is no gesture there; other devices show a passive
   "accepted — join" affordance instead.

## 8. Platform split — browser vs native shells

One `openExternalUrl(url)` helper in the admin, switching on the existing
shell detection (`isDesktopApp()` / `isReactNativeWebView()` — never UA
sniffing):

- **Browser:** `window.open(..., 'noopener,noreferrer')` + §7.4 fallback.
- **Desktop (Tauri):** `@tauri-apps/plugin-opener` `openUrl(meetingUri)` —
  already a permitted capability and already used by
  `external-auth.ts:32`; opens the default system browser, no popup
  blocker. Meet deliberately does **not** run in the shell's webview (no
  media entitlements there, by design).
- **Mobile (Expo WebView):** a **new bridge message**
  `nessie:open-external {url}` posted to the shell, handled in `App.tsx`
  with `Linking.openURL` (system browser). This bridge does not exist today
  — the only current external-open path is hardwired to the auth callback —
  and it follows the existing typed-guard pattern for bridge messages (an
  `isOpenExternalMessage` guard beside `isNativeShellPresentationMessage`),
  with the **allowlist enforced on the native side** (the call-provider
  origins: `meet.google.com`, the configured Jitsi domain,
  `teams.microsoft.com`) so a compromised page context cannot use it as an
  arbitrary URL launcher; a non-allowlisted URL is dropped and logged.
  The allowlist check parses the URL and compares **exact `https:`
  origins** (default ports, no substring/`startsWith` matching) plus
  provider path shapes; the Jitsi entry comes from the shell's own
  configuration of the server-declared domain, never from page content —
  an allowlist the page can supply is no allowlist. Two more hardening
  facts: the WebView today runs `originWhitelist={['*']}` with no
  navigation gate, so the same release restricts **top-level navigation
  to the admin origin** with the call origins externalized via
  `onShouldStartLoadWithRequest` (allowlisting those origins out to the
  system browser, never blanket-externalizing — a blanket rule breaks
  embedded content the WebView legitimately loads). Fallback when the
  shell predates the handler: `window.open`, in-place navigation — ugly
  but functional. And for completeness: agent-authored markdown renders
  links as inert `target=_blank` anchors with `noopener`
  (`MessageMarkdown.tsx`), and **only schema-validated server events and
  API records ever drive the call UI** — message content can never forge
  a ring.
- Ring parity: `IncomingCallProvider` renders identically inside the
  shells; native push covers the closed-app case.

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

## 10. The agent tools

**Two builtin ids, not one** — minting a link and ringing a channel are
different blast radii, and tool policy can only distinguish what has its
own id: **`meeting_link_create`** (mint + return a URL) and
**`call_start`** (mint + create the call + ring every member's devices).
Defined beside the other comms tools
(`packages/runtime/src/builtin-comms-tools.ts` array → spread into
`BUILTIN_TOOL_DEFINITIONS`), dispatched in `worker/src/run/tools.ts`,
handlers in `worker/src/run/pa-tools/`:

- **Both `personalAssistantOnly: true`.** They act with the user's own
  rights in the strongest sense — minting under their **Google/Microsoft
  identity** — and the codebase's stated rule
  (`builtin-channel-tools.ts:3`) is that such tools are PA-only. The
  requirement "an agent can generate a call link" is satisfied: the PA is
  that agent. Widening to shared agents later would be
  `requiresExplicitGrant` (§12.5), not a default.
- **`call_start` and prompt injection (decision flagged, §12.5):** PA-only
  is a *kind* gate, not a user confirmation — an ordinary builtin is
  enabled unless denied, so a prompt-injected PA could ring a whole
  channel's devices. The mitigation options are `requiresExplicitGrant`
  on `call_start` (one-time owner grant per agent — friction the owner
  explicitly doesn't want for "if I ask it") or leaving it default-on for
  the PA like `send_message` (which an injected PA can equally abuse,
  with smaller blast radius). Recommendation: default-on for the PA in
  v1 — the engagement path already means a person asked the PA
  something — with the split ids preserving the ability to flip
  `call_start` to explicit-grant without touching link minting. Owner
  decides.
- **Handler:** `resolveActingMember(context)` (live-membership re-read,
  attribution rewritten to the person), then the same shared seam the
  routes use — `createCallLinkForTeamUser` for link-only,
  `startCallForUser` when ringing. The provider **defaults to the
  conversation channel's team setting** (§3.0), and the tool takes an
  optional `provider` argument so a person can ask the agent for a Meet
  or Teams link even on a Jitsi-preferring team (owner's explicit call,
  2026-08-30): the override is the *user's* request relayed by their
  agent, minted under that user's own connection, so it grants nothing
  the user couldn't do with their own account. Whether to offer the
  override unprompted is the model's judgement, never a string-matched
  heuristic. The mirroring REST route accepts the same optional
  `provider`, keeping tool and route no-weaker-no-stronger. "Remind
  people about the call" needs no new tool — that's the agent posting an
  ordinary message with the link. Typed refusals in words: unattended
  run with no requesting user; `GOOGLE_NOT_CONNECTED` /
  `MEET_SCOPE_MISSING` / `MICROSOFT_NOT_CONNECTED` (the answer names
  `/settings/connections`).
- **Tenancy keys on the *target* channel, not the run's home channel.**
  `resolveActingMember` reads the run channel's organization; when
  `ring: true` names another channel, `startCallForUser` resolves the
  target channel's own organization and re-derives live membership
  (`deactivatedAt IS NULL`) **in that org** — on the UOA multi-org model
  a PA run in org A must never ring an org-B channel under org-A
  membership (the `resolveLocalUserIdsByUoaSub` org-scoping lesson). A
  channel the acting user cannot reach answers the same
  channel-not-found refusal as the route, so the tool cannot probe
  channel existence.
- **Modes:** default returns `{meetingUri}` for the agent's reply
  (mirroring a new member-level `POST /api/meetings/links` route that
  ships in the same change — same service, same gates, per the
  tools-mirror-routes rule and Rule zero). Optional `ring: true` +
  `channelId` runs the full §5.2 flow, mirroring
  `POST /api/channels/:id/call` exactly (membership of the acting user,
  human-count, PA-DM refusal, one-call-per-channel). The caller of record
  is the user; `Call.createdViaAgentId` lets surfaces show "N (via
  AgentName)".
- `safe: false`; not metered beyond the run's own budget; no
  `requiresExplicitGrant` (PA-only already binds it to the delegating
  user).

## 11. Delivery slices (each merges green on its own)

1. **Link service + team setting — implemented 2026-08-30.**
   `@nessie/comms-google` Meet client,
   the provider-dispatching `createCallLinkForTeamUser` seam (Meet + Jitsi
   mints), `Team.callProvider` column + `PATCH /api/teams/:teamId/settings`
   + scope/config change, credential refresh coordinator,
   `POST /api/meetings/links`, and deployment docs for the console steps
   (§3.5). Per the implementation brief, the organization Calls section and
   connect-from-call return intent move with the later UI slice. Deliberate
   Rule-zero note: until that UI and slice 5's tool land, this route is
   **machine-only by decision** — its doorways are deliberately deferred, not
   silently missing.
2. **Schema + call service rework** — `CallInvite`, widened status,
   provider/`meetingUri` columns, migration force-ending live Jitsi calls,
   new accept/decline/cancel routes, ring-timeout job + expiry sweep,
   `call.*` events added to the realtime schemas (fixing the §1 defect).
3. **Ring delivery** — user-scoped SSE events, `call.ring-dispatch` /
   cancel worker jobs with the no-surface-suppression flag (threaded into
   `deliverNativeTokens` and the web leg alike), `pushIncomingCalls`
   preference, the signed action token + `respond` endpoint, `sw.js`
   actions/`event.action`/close handling (versioned payloads, SW protocol
   staged first), native payload/channel/dismissal work, the `call_missed`
   alert kind.
4. **Admin UX + shells** — caller popup, `IncomingCallProvider`,
   button/banner rework, Jitsi removal, `openExternalUrl` helper, the
   `nessie:open-external` mobile bridge + WebView external-origin trap,
   desktop opener wiring. Playwright: button → popup renders link; ring
   dialog on a second session; Accept calls `window.open` with the URI
   (stubbed); blocked-open fallback renders the anchor.
5. **Agent tool + docs** — `meeting_link_create`, move
   `video-calling.md` → `docs/done/`, update `CLAUDE.md` capability line,
   review-log resolution of §12's open decisions.

## 12. Open questions / accepted tradeoffs

1. **Link is a capability** (`accessType: OPEN`): anyone holding the URI
   can join. Accepted for parity and reach (recipients without Google
   accounts); revisit with a `TRUSTED` config knob for Workspace-only
   orgs.
2. **No Meet-side presence**: joined/left/really-ended is invisible without
   Workspace Events API subscriptions + broader scopes. `active/ended` is
   Nessie bookkeeping (explicit end + expiry sweep). Out of scope.
3. **Quiet hours / focus mode silence the ring push** (realtime dialog
   still shows). Alternative — a ring overrides DND — rejected for now:
   the user's own suppression settings win. Owner may overrule.
4. **iOS**: Web Push needs an installed PWA (16.4+) and supports no action
   buttons; the companion app rings via ordinary push, not
   CallKit/VoIP-push lock-screen UI. Follow-up if the companion app grows
   telephony ambitions.
5. **Shared agents and the tool**: PA-only now. If a shared agent should
   start calls (e.g. a standup bot), that becomes a
   `requiresExplicitGrant` widening with its own review.
6. **Comms connection gains an action scope** (§3.3): the read-only
   character of the comms connector changes slightly. Alternative (second
   Google OAuth surface just for Meet) doubles connect UX + credential
   storage; rejected, but flagged for the owner.
7. **Google OAuth client verification**: adding the Meet scope to the
   consent screen may retrigger Google's app review for the production
   client. Deployment-side risk, not code; §3.5.
8. **Per-call provider picker for humans**: the button follows the team
   setting; only the agent tool can override on explicit request. If
   people want a chooser on the button (e.g. long-press → "Start Jitsi
   call"), that's a v2 UI decision, not plumbing — the seam already takes
   a provider.
9. **Placement of the team Calls setting**: `/settings/organization` Calls
   section is the recommendation (org-page-with-team-rows precedent); a
   dedicated team-settings page does not exist and this plan does not
   invent one. Owner may prefer the Integrations page instead.
10. **Teams sequencing** (§3.7): ship v1 as Meet + Jitsi with the
    three-valued setting and seam, Microsoft Teams landing with the
    Microsoft comms OAuth leg — or pull that leg forward into this work.
    Recommendation: v1 without it; the Azure AD app + adapter package is
    its own project.

## 13. Review log

Reviewers: **Kimix** (delivered, folded in below) and **Codex Sol**
(in progress at the time of this revision; its outcomes get appended
here). Both reviewed revision `d309821a` — before the per-team provider
setting and the Teams reinstatement — so their findings target the
Meet-only draft; all still applied. Every folded finding was re-verified
against the code before acceptance.

**Kimix — confirmed and folded:**

1. *(critical)* Native push must not carry `meetingUri`: the mobile shell's
   `pathFromPushData` treats notification data as untrusted and accepts
   internal paths only (verified verbatim,
   `mobile/src/lib/push-navigation.ts:4-9`). → §6.2 native-push paragraph:
   internal path + call id, dialog fetches, bridge opens.
2. *(critical)* Accept had contradictory outcomes for a same-user
   multi-device race. → §5.4: accept idempotent per invitee,
   `CALL_ALREADY_ACCEPTED` vs `CALL_NO_LONGER_RINGING`.
3. *(major)* The API-side `enqueueQueueJob` has no delay support (verified:
   `delayMs` exists only on the runtime `PgQueueProvider`). → §9.3: the
   `@nessie/db` helper gains `delayMs`.
4. *(major)* The banner hands the link to the whole channel, so invites
   must be named a ring list, not an access list. → §5.1 states it plainly
   (decision (b): channel calls are channel-open).
5. *(major)* Invites/eligibility from raw `channelMember` would include
   deactivated members. → §5.2: live-org-membership join.
6. *(major)* Timeout/cancel bulk updates could stomp a concurrent accept.
   → §9.3: all invite mutations `WHERE state='ringing'`.
7. *(major)* Missed-call alert is a new alert kind with cross-stack cost;
   writer undecided. → §9.2: worker ring-timeout handler writes it;
   `call_missed` kind named with its revalidation.
8. *(major)* Cross-origin `clients.openWindow` from a SW is not uniformly
   reliable; plain notification click was unspecified. → §6.2: plain click
   opens the ring dialog; refusal path opens same-origin `?acceptCall=`.
9. *(major)* The tool's ring mode must key tenancy on the *target*
   channel's org, and preserve 404 semantics. → §10 tenancy paragraph.
10. *(minor, several)* Symptom wording of the publish defect (500 with the
    call created); `mapCallRecord` collapse (verified,
    `api/src/services/calls.ts:29`); `roomId @unique` non-null needs a
    decision (→ nullable); join/leave route deletion; `pushIncomingCalls`
    naming; missed-push respects quiet hours; bridge typed guard +
    allowlist trap; machine-only note for slice 1. All folded where cited.

**Kimix — verified-accurate confirmations** (no change needed): the
WsEventSchema defect, user-SSE scope delivery, surface-suppression bypass
needing to thread into `deliverNativeTokens` (§6.2 flag covers both legs),
desktop opener capability, entitlement/CSP hazards, OAuth scope facts,
tool-gating placement, and the `agent-message.ts` fixed-copy exemption.

**Rejected/adjusted:** none rejected outright; finding 8's browser-support
specifics are folded as "not uniformly reliable" rather than per-browser
claims, since the degraded path is cheap and the per-browser matrix is
volatile.

**Codex Sol — 19 findings; the load-bearing ones re-verified against code
before folding. Confirmed and folded:**

1. *(major, verified)* The SW cannot authenticate an accept fetch — the
   API is bearer-only (`server-context.ts` `getAuthorizationToken`) and
   the refresh cookie is scoped to `/api/auth` on a different production
   subdomain. → §6.2: single-use signed action token in the encrypted
   push payload + `POST /api/calls/:id/respond`.
2. *(major, verified)* The replay store persists only the first
   channel/user scope per publication and the hub treats any user scope
   as user-only. → §6.1: one publication per audience, never mixed
   scopes.
3. *(major, verified)* `role='system'` messages are excluded from feed
   reads — the missed-call notice would never render. → §9.2:
   assistant-role fixed copy with `metadata.kind='call_missed'`.
4. *(major)* Check-then-create races; conditional updates alone are not
   serialization. → §9.4: partial unique index on live calls per
   channel, `FOR UPDATE` on the call row, publish only from the
   committed winner.
5. *(major, partially rejected)* Internal inconsistencies after the
   provider amendment (stale §9.1 provider list, slice wording) — fixed.
   Its "restore the Google-only v1 scope" suggestion is **rejected**:
   the owner's amendment (per-team Meet/Jitsi/Teams) postdates the
   review brief and is authoritative; Teams is sequenced via §12.10
   rather than persisting an unimplementable value (the setting offers
   `microsoft_teams` only where the Microsoft OAuth leg is configured).
6. *(major, verified)* Collapse ids don't dismiss a displayed native
   notification and the shell can only `dismissAllNotificationsAsync`.
   → §6.2 native paragraph: identifier/category + dismissal work, honest
   degradation.
7. *(major, verified)* `PushPayload` has no priority/category fields; no
   call channel exists. → §6.2: named payload/channel work; "high-
   importance notification plus in-app ringing", not CallKit pretense.
8. *(major, verified)* `originWhitelist={['*']}`, no navigation gate;
   allowlists must be parsed-origin and never page-supplied. → §8
   hardening; note that agent markdown anchors are inert and only
   server events drive call UI.
9. *(major)* PA-only ≠ user confirmation; an injected PA could ring a
   channel. → §10: tool split (`meeting_link_create` / `call_start`),
   grant-gating decision flagged §12.5 with a default-on recommendation.
10. *(major, verified)* `@nessie/comms-connect` has no Prisma dep;
    decryption already duplicated api/worker; reconnect nulls a stored
    refresh token when the provider omits one (`persist.ts` upsert). →
    §3.4: shared DB-aware credential coordinator + the
    preserve-refresh-token fix; connection selection + return-intent
    added.
11. *(major)* `meetings.space.created` is Sensitive and allows managing
    app-created spaces — "create-only, non-sensitive-ish" was wrong. →
    §3.1 corrected; verification made a pre-deployment gate.
12. *(major, spec-verified)* `window.open` with `noopener` returns
    `null` **on success** — the blocked-detection design was factually
    broken. → §5.4 rewritten: the browser Accept control is a real
    anchor; no null-check; no "never blocked" absolutism.
13. *(major, verified)* No shared SSE reader exists; 24 h replay can
    resurface stale rings. → §6.1: fourth reader accepted explicitly;
    reducer rules (id order, tombstones + revision, expiry, re-fetch
    before sound).
14. *(major)* End-authority contradiction and `getVisibleChannel` on
    GET. → §9.4: participant = accepted invite; end = caller or
    accepted invitee; public-channel visibility kept and stated as
    deliberate.
15. *(minor)* Focus-mode contract, caller-popup honesty ("waiting for
    responses"), stale-SW rollout (versioned payloads, staged SW,
    appVersion gating), nginx Permissions-Policy + deployment.md +
    slack-parity doc fallout, `pushIncomingCalls` naming in slice 3 —
    all folded where cited.

**Cross-reviewer agreement:** both independently confirmed the
`WsEventSchema` publish defect, the user-SSE/WS scope split, the
surface-suppression bypass needing to cover every delivery leg, the
sw.js capability gaps, the missing mobile external-open bridge, and the
desktop opener capability. They disagreed nowhere on facts; Sol went
deeper on auth/persistence mechanics, Kimix on the native-push trust
boundary and state-machine SQL shapes. Sol's review ran against the
live worktree file (mid-amendment), which is why finding 5 saw the
provider widening; all other findings apply to the final text.
