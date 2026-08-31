# Call links + ringing — signaling and push

This chapter continues the numbered design in [the overview](./overview.md).

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

