# Call links + real ringing — Google Meet by default, Jitsi per team, replacing the embedded call

**Status:** Implementation in progress — Slices 1–3 complete; slice 4 has a
link-join compatibility repair but its caller/recipient UX remains pending ·
2026-08-31
**Provider decision (made by the product owner, 2026-08-30, amended same
day):** the link provider is a **per-team setting** — **Google Meet (the
default)**, **Jitsi**, or **Microsoft Teams**. Pressing the phone icon does
whatever the team chose: a Jitsi team gets a Jitsi link on click, a Teams
team a Teams link. The agent, when asked, can mint a link with any provider
the asking user's connections support, and can remind people about a call
through ordinary messaging. Whatever the provider, the call is a **link
opened in a tab**: the ring/accept/popup-blocker/native design below is
provider-agnostic, and the embedded Jitsi iframe dies regardless.

## Table of Contents

The numbered design continues across the chapters below; §0–§2, §4, and
§11–§13 stay here.

- [link-generation.md](link-generation.md) — §3: the team setting, the Meet
  API choice, whose Google account, OAuth scope and re-consent, where the code
  lives, Google Cloud setup, and Jitsi/Microsoft Teams as link providers.
- [flow.md](flow.md) — §5: the new flow end to end — surfaces, pressing Call,
  the caller popup, and what happens when a recipient accepts.
- [ringing.md](ringing.md) — §6: signaling and push — user-scoped realtime for
  open clients, Web Push/APNs/FCM for closed ones, multi-device and
  cancel-on-pickup.
- [popup-blocker-and-platforms.md](popup-blocker-and-platforms.md) — §7 and
  §8: the popup-blocker strategy and the browser/desktop/mobile-shell split.
- [state-machine.md](state-machine.md) — §9: schema evolution, transitions,
  durable timers, and concurrency.
- [agent-tools.md](agent-tools.md) — §10: `meeting_link_create` and
  `call_start`.

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

[docs/video-calling.md](../../video-calling.md) describes the Jitsi feature;
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
2. **Schema + call service rework — implemented 2026-08-30, corrected 2026-08-31.** `CallInvite`, widened status,
   provider/`meetingUri` columns, migration force-ending live Jitsi calls,
   new accept/decline/cancel routes, ring-timeout job + expiry sweep,
   `call.*` events added to the realtime schemas (fixing the §1 defect). The
   REST start route now binds the target channel to the session organisation,
   while the worker tool remains deliberately target-tenant-scoped; a declined
   invite is committed even when other invitees are still ringing.
3. **Ring delivery — implemented 2026-08-31.** User-scoped SSE events, `call.ring-dispatch` /
   cancel worker jobs with the no-surface-suppression flag (threaded into
   `deliverNativeTokens` and the web leg alike), `pushIncomingCalls`
   preference, the signed action token + `respond` endpoint, `sw.js`
   actions/`event.action`/close handling (versioned payloads, SW protocol
   staged first), native payload/channel/dismissal work, the `call_missed`
   alert kind. The committed missed-call message also publishes its own
   channel-scoped `message.new` event; realtime publication is best-effort.
4. **Admin UX + shells — in progress.** The 2026-08-31 compatibility repair
   makes the header and banner Join controls real anchors to `meetingUri` and
   prevents the legacy overlay from rendering link calls with no `roomId`.
   The caller popup, `IncomingCallProvider`,
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
