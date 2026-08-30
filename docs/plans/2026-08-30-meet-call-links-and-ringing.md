# Google Meet call links + real ringing — replace the embedded Jitsi call

**Status:** Draft for review · 2026-08-30
**Provider decision (made by the product owner, 2026-08-30):** the generated
link is a **Google Meet** link. The original request mentioned both a "Teams
link" and "the google call"; the ambiguity was flagged and resolved to Meet —
§4 records the alternatives and why they lost.

## 0. Summary

Today's Call button starts an **embedded Jitsi call** inside the admin: it
creates a channel-scoped room, renders a Jitsi iframe overlay, and informs
only people who happen to be looking at that channel. Nobody's device rings —
discovery is a 5–30 s poll that only runs on the open channel page.

This plan replaces that with a **generate-a-Meet-link + ring** flow:

1. Caller presses **Call** (same surfaces the button lives on today).
2. The server mints a **Google Meet link** under the caller's own Google
   connection and creates a `ringing` call with one invite per recipient.
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
  so each call action 500s *after* its transaction commits, and the UI
  limps along on the poll. Any new ring event starts by extending
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
  **create Meet link + ring**. The banner survives as "Call happening —
  Join" where Join is a plain anchor to the Meet link.
- Deleted: `CallOverlay.tsx`, `CallBanner`'s Jitsi-join wiring,
  `admin/src/lib/jitsi.ts`, the Jitsi globals/types, the unused
  `useEndCall`-as-overlay plumbing. `docs/video-calling.md` moves to
  `docs/done/` with a banner pointing here.
- `Call`/`CallParticipant` stay, extended (§9.1); old rows become history.
  The migration force-ends any `active` Jitsi call (no UI remains to join
  it).
- The client/server eligibility mismatch is fixed while we're in there: the
  server counts **human** members (same predicate the client uses), so both
  agree.

## 3. Google Meet link generation

### 3.1 API choice — Meet REST `spaces.create` (chosen)

`POST https://meet.googleapis.com/v2/spaces` with the user's OAuth bearer
returns `{ name, meetingUri, meetingCode, config }` — an instant link
(`https://meet.google.com/xxx-yyyy-zzz`), no calendar event. Scope:
`https://www.googleapis.com/auth/meetings.space.created` — create-only, the
narrowest Meet scope; it cannot read or list anything. Works for consumer
Google accounts and Workspace alike.

Rejected: Calendar `events.insert` + `conferenceData.createRequest` — needs
the far broader `calendar.events` write scope and leaves an event on the
user's calendar per ad-hoc call. Revisit only if scheduled meetings with
invitations become a goal.

Space config: `accessType: OPEN`, so recipients join from the link without
Google-side invites (they may not have Google accounts). The link is a
capability; accepted tradeoff recorded in §12 (parity with today's
public-Jitsi rooms, which are strictly worse — guessable names).

### 3.2 Whose Google account

**The initiator's.** Minted under the caller's per-user Google
`CommsConnection` (Individual Communications Connector). For the agent tool,
the initiator is the **run's requesting user** (§10). No org-level service
account. A user without a Google connection gets a typed refusal and the
existing connect path (`/settings/connections`, or the PA's
`comms_connect_card`).

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
  Gmail client — it owns Google HTTP and token bundles already. Outbound
  via `safeFetch` per the egress rule.
- A `createMeetingLinkForUser(prisma, userId)` seam in the comms core
  (`@nessie/comms-connect`), which owns credential decryption/refresh.
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

## 4. Provider decision — recorded

**Decided: Google Meet.** Options considered:

| Option | Why not / notes |
|---|---|
| **Google Meet** ✅ | Chosen. Instant links via a create-only scope; recipients need no Google account to join an OPEN space; rides the existing Google connection. |
| Microsoft Teams | `onlineMeetings` Graph API needs an Azure AD app and per-user M365 accounts; no M365 footprint in the org. |
| Nessie-native (keep/fix Jitsi) | Keeps an entire media surface Nessie must own (TURN, JWT, self-hosting, entitlements, CSP) — the thing being removed. |
| Provider-configurable | Real future direction — the §3.4 seam is deliberately provider-shaped — but an abstraction for one provider now is speculative generality. |

## 5. The new flow, end to end

### 5.1 Surfaces

- **Channel header button** (`ChannelHeader.tsx` descriptor): idle → "Start
  call"; ringing/active → join affordance (anchor to `meetingUri`) with
  ring/participant state. Eligibility unchanged in spirit (≥ 2 human
  members, PA DM refused) and now consistent client/server.
- **In-channel banner**: "N started a call — Join" (anchor). Driven by the
  channel-scoped events, as today's banner should have been.
- **Incoming-call dialog**: new, global (§6.1) — renders anywhere in the
  app, not only on the channel page.

### 5.2 Caller presses Call

`POST /api/channels/:channelId/call` (same route, new behavior):

1. Auth + membership + eligibility as today (human-member count).
2. Mint the Meet space under the caller (§3). Typed failures
   (`GOOGLE_NOT_CONNECTED`, `MEET_SCOPE_MISSING`, `GOOGLE_REAUTH_REQUIRED`,
   `MEET_LINK_FAILED`) — no `Call` row is written on failure.
3. Transaction: `Call` row (`provider='google_meet'`, `meetingUri`,
   `status='ringing'`, `ringExpiresAt`) + one `CallInvite` per **human**
   channel member except the caller (`state='ringing'`). Agents are never
   invited.
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
§6.2). The in-app handler, in order:

1. **Synchronously** open the link — the URI is already client-side inside
   the ring event, so there is no await before the open. Browser:
   `window.open(meetingUri, '_blank', 'noopener,noreferrer')`. Shells: the
   platform opener (§8).
2. Fire `POST /api/calls/:callId/accept` (after/parallel, with retry — the
   tab already being open is fine even if this races the timeout; server
   answers `CALL_NO_LONGER_RINGING` and the UI shows the missed state).
3. If `window.open` returned `null` (blocked regardless), the dialog stays
   up and swaps to a "Pop-up blocked — Join call" **anchor**; a direct
   anchor click always opens.

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
  meetingUri, expiresAt}`.
- `call.invite.updated` — `{callId, userId, state}`; to that invitee (all
  their devices: stop ringing) and to the caller (popup state).
- `call.updated` — `{callId, channelId, status, meetingUri}` terminal/state
  transitions; channel-scoped for the banner, plus user-scoped to caller +
  invitees.

A global **`IncomingCallProvider`** at the admin root (beside the alerts
facade, sharing its SSE reader) renders the ring dialog and plays the
ringtone. Ringtone honesty: browsers block audio in tabs that have had no
user gesture; those tabs ring visually and the push notification carries
the sound. No autoplay hacks.

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
- **New preference kind** `incomingCalls` in `UserPreferencesSchema` +
  `shouldSuppressPushForPreferences`, default on. **Quiet hours and focus
  mode suppress the ring push** like everything else — a ring is not above
  the user's own do-not-disturb (the realtime dialog still appears; §12.3
  flags the alternative).
- **Web Push:** payload is E2E-encrypted (RFC 8291), so `meetingUri` may
  ride in it. `admin/public/sw.js` gains: `actions: [Accept, Decline]`,
  `requireInteraction: true`, `renotify`, a stable `tag: call-<callId>`, an
  `event.action` branch in `notificationclick`, and a `notificationclose`
  handler (dismiss ≠ decline; it just stops that device's banner). Accept
  in the SW: `clients.openWindow(meetingUri)` **first** (a notification
  click is user-gesture-bearing; no await before it), then `waitUntil` the
  same-origin accept fetch. **iOS PWA caveat:** action buttons are
  unsupported there — the notification degrades to click-= accept-and-open.
- **Ring cancel over push:** a cancel push with the same `tag`; the SW
  closes the matching notification (`registration.getNotifications({tag})`)
  and shows nothing (where a platform insists on a visible notification per
  push, it shows a silent self-closing one). Native: FCM collapse key /
  `apns-collapse-id` = the call id.
- **Native shells** get the ordinary high-priority push. **Not in scope:**
  APNs VoIP push / CallKit lock-screen call UI (§12.4).

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
  and it ships allowlisted to `https://meet.google.com/` at the native
  side, so a compromised page context cannot use it as an arbitrary URL
  launcher. Fallback when the shell predates the handler: `window.open`,
  which the WebView turns into in-place navigation — ugly but functional;
  the shell's `onShouldStartLoadWithRequest` gains an external-origin trap
  in the same release.
- Ring parity: `IncomingCallProvider` renders identically inside the
  shells; native push covers the closed-app case.

## 9. Call state machine

### 9.1 Schema evolution

`Call` gains `provider` (`'google_meet'`; legacy rows backfilled
`'jitsi'`), `meetingUri` (nullable on legacy), `ringExpiresAt`,
`createdViaAgentId` (nullable), and `status` widens: `ringing | active |
ended | missed | declined | cancelled` (stays a string column; values
validated in code like today). New model `CallInvite`: `callId`, `userId`,
`state` (`ringing | accepted | declined | missed | cancelled`),
`respondedAt`, `@@unique([callId, userId])`. `CallParticipant` is retired
from the new flow (Meet-side presence is unobservable) but kept for
history.

New routes: `POST /api/calls/:callId/accept` / `.../decline` /
`.../cancel`; existing create/end routes keep their paths. Every
invite-mutating route checks the actor **is the invitee** (accept/decline)
or the caller (cancel/end), on top of channel membership.

### 9.2 Transitions (conditional updates, race-safe)

- `ringing → active`: first accept (`WHERE status='ringing'`; later
  accepts don't regress — guard `IN ('ringing','active')` for the invite
  side).
- `ringing → cancelled`: caller cancels; remaining `ringing` invites →
  `cancelled`.
- `ringing → declined`: the last still-ringing invite declines and none
  accepted.
- `ringing → missed`: ring timeout with zero accepts; `ringing` invites →
  `missed`. Writes a **server-authored** "Missed call from N" system
  message in the channel (the `agent-message.ts` docstring's fixed-copy
  group — empty disclosure basis is correct: the event is channel-visible
  by construction) + a durable `UserAlert` per missed invitee (`eventKey =
  call:<callId>:missed:<userId>`, revalidated on read like other alerts).
- `active → ended`: caller/any-participant explicit end, or the expiry
  sweep. Nessie **cannot observe** Meet-side hangup — no Workspace Events
  subscription in scope — so `ended` is honest bookkeeping (§12.2).
- Invite-level: `ringing → accepted | declined | missed | cancelled`, each
  one-way; a late accept answers `CALL_NO_LONGER_RINGING` and the client
  shows missed-state with the link still one honest click away.

### 9.3 Timers are durable, never in-process

- **Ring timeout** (`NESSIE_CALL_RING_TIMEOUT_MS`, default 45 s): delayed
  queue job enqueued at creation; handler is one conditional UPDATE, so
  crash/double-delivery is harmless. Never `setTimeout` in the API.
- **Active-call expiry**: periodic sweep flips `active` calls older than
  `NESSIE_CALL_MAX_ACTIVE_HOURS` (default 8 h) to `ended` so the banner
  cannot stick forever.

### 9.4 Concurrency

One ringing-or-active call per channel (the `ACTIVE_CALL_EXISTS` 409 now
covers `ringing`); a concurrent second presser gets the join affordance.

## 10. The agent tool

Builtin **`meeting_link_create`**, defined beside the other comms tools
(`packages/runtime/src/builtin-comms-tools.ts` array → spread into
`BUILTIN_TOOL_DEFINITIONS`), dispatched in `worker/src/run/tools.ts`,
handler in `worker/src/run/pa-tools/`:

- **`personalAssistantOnly: true`.** The tool acts with the user's own
  rights in the strongest sense — it mints a resource under their **Google
  identity** — and the codebase's stated rule
  (`builtin-channel-tools.ts:3`) is that such tools are PA-only. The
  requirement "an agent can generate a call link" is satisfied: the PA is
  that agent. Widening to shared agents later would be
  `requiresExplicitGrant` (§12.5), not a default.
- **Handler:** `resolveActingMember(context)` (live-membership re-read,
  attribution rewritten to the person), then the same shared seam the
  routes use — `createMeetingLinkForUser` for link-only,
  `startCallForUser` when ringing. Typed refusals in words: unattended run
  with no requesting user; `GOOGLE_NOT_CONNECTED` / `MEET_SCOPE_MISSING`
  (the answer names `/settings/connections`).
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

1. **Meet client + link service** — `@nessie/comms-google` Meet client,
   comms-core seam, scope/config change + re-consent path,
   `POST /api/meetings/links`, deployment doc for the console steps (§3.5).
2. **Schema + call service rework** — `CallInvite`, widened status,
   provider/`meetingUri` columns, migration force-ending live Jitsi calls,
   new accept/decline/cancel routes, ring-timeout job + expiry sweep,
   `call.*` events added to the realtime schemas (fixing the §1 defect).
3. **Ring delivery** — user-scoped SSE events, `call.ring-dispatch` /
   cancel worker jobs with the no-surface-suppression flag,
   `incomingCalls` preference, `sw.js` actions/`event.action`/close
   handling, native collapse behavior.
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

## 13. Review log

_To be filled after codex sol + kimix review: findings, which were verified
real and folded in, which were rejected and why._
