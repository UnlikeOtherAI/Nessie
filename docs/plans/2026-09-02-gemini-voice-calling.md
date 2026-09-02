# Call your Personal Assistant — Gemini Live voice + CallKit on iPhone

**Status: plan (2026-09-02). Nothing here is built yet.**

Ondrej wants to *call* his Personal Assistant: real-time voice-to-voice,
triggered by the existing call button in the top-right of the PA
conversation header, on **every** client — the web admin included — and on
iPhone presented to iOS as a phone call: lock-screen call UI,
AirPods/Bluetooth routing, CarPlay, "Hey Siri, call my assistant". The Coder
project (`/Volumes/External/Projects/Coder`, `ios/TalkIOS.swiftpm`) has a
working implementation of exactly this shape against Gemini Live; this plan
says what we port, what Nessie must do differently, and in what order.

The credential model, confirmed: Ledger mints **temporary, one-use Gemini
Live tokens** (it already ships this — see below), the client opens the
Gemini WebSocket *directly* with that ephemeral token, and audio flows
device↔Google. The deployment's main `LEDGER_PROXY_TOKEN` never leaves the
server; the Nessie API is only the broker that asks Ledger for each
ephemeral token on the authenticated user's behalf.

One naming correction up front: the framework involved is **CallKit** (and
App Intents for Siri initiation), not CoreTelephony. CoreTelephony is
read-only carrier/radio information; CallKit is what makes a VoIP session a
first-class system call — lock-screen answer UI, the green pill, Recents,
and the CarPlay in-call screen all come from CallKit. CarPlay needs no
separate entitlement for this: a CallKit call renders on the CarPlay screen
automatically, and Siri phrases registered through App Intents work from
CarPlay's Siri.

## What Coder proves, and what we take

Coder's iOS app talks to Gemini Live over a WebSocket
(`BidiGenerateContentConstrained`) using a **one-use ephemeral credential
minted by Ledger**, with audio flowing directly between the device and
Google. The pieces worth porting nearly verbatim (all under
`ios/TalkIOS.swiftpm/AppModule/`):

| Coder file(s) | What it owns | Verdict |
| --- | --- | --- |
| `GeminiLiveClient.swift` + `+Connection` + `+Protocol` + `+Audio` + `+Usage` (~1,200 lines) | WS lifecycle, setup payload (VAD, interruptions, transcription both ways, voice selection, sliding-window compression), 16 kHz mic upsample / 24 kHz playback via `AVAudioEngine`, session-resumption handle + `goAway` server rotation, credential rotation 1 min before expiry, function calling, per-turn `usageMetadata` snapshots | Port as-is, swap the credential source |
| `Calling/AgentCallCoordinator.swift` | The single CallKit call: `CXProvider`/`CXCallController`, outgoing-call state machine, **audio I/O started only in `provider(_:didActivate:)`**, mute reapplied after activation, unexpected-disconnect → `reportCall(endedAt:)` | Port as-is |
| `Calling/AgentCallSession.swift` | The seam: CallKit owns call + audio-session lifecycle, the session owns networking/Gemini state (`connect` must not start I/O) | Port as-is |
| `Calling/AgentCallIntents.swift` | App Intent + `AppShortcutsProvider` — "Call Personal Assistant with ⟨app⟩" via Siri, including from CarPlay | Port, rebrand phrases |
| `Voice/VoiceSession*.swift` | Foreground push-to-talk orb, hands-free toggling, watchdogs, generation counters guarding stale connects | Take the CallKit-facing subset (`+CallLifecycle` pattern, generation counters); skip the orb/push-to-talk UI for phase 1 |
| `LedgerGeminiLiveService.swift` | Credential fetch + `LedgerGeminiUsageReporter` (sequenced, idempotency-keyed, drain-on-finish) | Port the *shape*; the endpoints move to the Nessie API (below) |

Hard-won details encoded in that code we must not lose in the port:

- Prove the local audio path **before** minting the credential — an audio
  failure otherwise burns the one-use credential and holds the Ledger
  issuance slot until expiry.
- `stop()` can race the in-flight token request; the guard closes the
  just-created Ledger session instead of orphaning its slot.
- Credential rotation installs the new socket before cancelling the old one
  and swaps usage reporters in the gap, so no turn is attributed to the
  wrong session.
- A mute request can arrive before CallKit activates audio; activation
  re-applies mute state so it never unmutes input.
- Tool calls run in their own tasks — Gemini Live happily waits for a
  `toolResponse`, but blocking the socket receive loop is fatal.
- Tool arguments/results never reach device logs with values, only shape.

## The Ledger contract already exists

Ledger (main branch) ships `POST /v1/gemini/live-token`: an active Ledger
proxy token + an app-generated device UUID → a one-use Gemini Live
credential (must open its session within 45 s, expires after 30 min,
resumable across Google's routine WS rotations). Per-turn usage goes to
`POST /v1/gemini/live-sessions/:id/usage` (idempotent, sequence-keyed,
client-reported estimated rows — never provider-verified spend). Each
device slot reserves the configurable `GEMINI_LIVE_RESERVATION_USD`
(default **$5/day**) against the token's daily budget; a repeat request from
the same device atomically supersedes its prior session and transfers the
reservation, so crash/reinstall recovery cannot double-reserve.

Issuance requires, on the calling token: an explicit
`gemini-3.1-flash-live-preview` model grant, an explicit `live-token`
endpoint grant, an active Gemini service, and a positive daily budget.
**Ops prerequisite:** those grants must be added to Nessie's
`LEDGER_PROXY_TOKEN` before any of this works — that is a Ledger-side
configuration task, not code.

### Cost tracking — verified against Ledger main (2026-09-02)

The question was whether call spend can actually be tracked through Ledger
so billing shows appropriately. Verified in code
(`api/src/repositories/gemini-live-repository.ts`,
`services/gemini-live-service.ts`, `services/usage-metering.ts`,
`repositories/metering-usage-aggregate.ts`):

**What works today, end to end:**

- **Every reported turn is priced.** Per-modality USD/1M-token rates are
  pinned onto the session at mint time (`GEMINI_LIVE_PRICING`: text-in
  $0.75, audio-in $3, visual-in $1, text-out $4.50, audio-out $12) and each
  accepted usage report becomes one idempotent `LedgerEntry` with
  `estimated` = the priced amount, plus session-level cumulative token
  counters and `clientReportedAmount`. Costed spend per call/user/day is a
  query away on Ledger's side.
- **Per-user attribution works — and is mandatory.** The mint attributes
  the session to `uoaSubject ?? nessieSubject ?? token.provisionedForSub`,
  and each usage row's metering attribution requires — for a product-bound
  token like Nessie's — a **signed UOA subject + organization + team, or
  the call 401s** (`usage-metering.ts` `identity()`). So the Nessie relay
  must attach `X-UOA-Delegation` + `X-Nessie-Context` on both the mint and
  every usage relay, and on a signing deployment **voice calls are only
  available to users with a linked UOA identity** — the same fail-closed
  rule ordinary inference already follows. Per-user session concurrency
  (`PROXY_TOKEN_USER_MAX_CONCURRENT_SESSIONS`) comes free with that
  attribution.
- **Rows land in the UOA-read portfolio dimensions.** The entries carry
  `billingProduct` / `billingOrganizationId` / `billingTeamId` /
  `billingUserId`, `serviceId`, units in/out, and
  `costProvenance: "client_reported"` / `billingStatus: "telemetry_only"`,
  so the `metering-portfolio-v1` `group_by=user` snapshot shows the calls
  and token units under the right user.

**The gap — customer-statement dollars:**

- The portfolio's cost aggregation sums **only**
  `rawProviderEstimatedCost` / `rawProviderActualCost`
  (`metering-usage-aggregate.ts`), and `deriveUsageMetering` deliberately
  nulls both unless the basis is `provider_cost` — client-reported
  telemetry is not provider-verified spend, and Ledger refuses to present
  it as such. Net effect: **Gemini Live usage appears in the customer
  statement's portfolio with calls and units but NULL cost.** UOA cannot
  rate it from the snapshot either, because the portfolio's `unitsIn` /
  `unitsOut` collapse the modality split (audio vs text differ 4–16× in
  price), so the dollars are not reconstructible downstream.
- **Decided billing flow (2026-09-02):** Ledger passes the call's cost
  through to UOA; UOA — the sole commercial authority, owning payments and
  tariffs — applies its margin on top (10–30%, exact rate still Ondrej's
  call, and a UOA tariff decision Nessie never sees as a number); the
  resulting credit charge appears on the UOA-authored statement Nessie
  renders at `/tokens`. Nessie-side there is nothing to build — rendering
  UOA-authored models only is the invariant, and margin application lives
  strictly in UOA.
- **Required follow-up in Ledger** to make that flow real: carry the cost
  into the portfolio for telemetry-basis rows. One precision on "real
  costs": for ephemeral Live sessions Google exposes **no provider-side
  metering**, so the truest cost Ledger can ever pass is its own
  per-modality-priced figure computed from the client-reported
  `usageMetadata` — already stored per turn as `LedgerEntry.estimated`.
  The change is to surface that figure in the `metering-portfolio-v1`
  aggregation (today it sums only the `rawProvider*Cost` columns, which
  telemetry rows null), keeping the existing
  `costProvenance: "client_reported"` dimension as the trust label so UOA
  rates it knowingly. Until that lands, `/tokens` shows voice calls as
  usage with no charge. This is a Ledger contract change consumed by UOA —
  its own task in the ledger repo, coordinated with UOA's rating side.
- Trust note, for the record: usage is client-reported because Google
  exposes no server-side metering for ephemeral Live sessions — a
  compromised client could under-report. Exposure is bounded by the $5/day
  per-device reservation and the Google project spend controls; that
  bound, not the telemetry, is the financial backstop.

## Where Nessie must differ from Coder

### 1. The device never holds a Ledger credential — the API relays

Coder provisions a **per-user** Ledger ProxyToken into the device Keychain
and the phone calls Ledger directly. Nessie's standing invariant
(`AGENTS.md`) is the opposite: `LEDGER_PROXY_TOKEN` is the one
deployment-wide, product-bound app key and is **never a per-user or
per-device credential**. So the Nessie API becomes the credential broker:

- `POST /api/voice/sessions` — authenticated user. Resolves the caller's
  Personal Assistant DM channel (the existing `GET /api/personal-assistant`
  machinery), calls Ledger `live-token` with `LEDGER_PROXY_TOKEN` **plus the
  signed `X-Nessie-Context` / linked-user `X-UOA-Delegation`** through the
  same identity-signing seam every other Ledger call uses (never a second
  copy), and passes a *server-derived* device id — an HMAC of
  `(userId, deviceId)` — so Ledger's per-device slots isolate per user+device
  and the raw device identifier never reaches Ledger. Returns
  `{ voiceSessionId, accessToken, model, expiresAt, paChannelId,
  paThreadId }`. The Ledger session id stays server-side, keyed by
  `voiceSessionId`.
- `POST /api/voice/sessions/:id/usage` — relays the per-turn usage snapshot
  to Ledger under the stored Ledger session id, preserving the client's
  sequence numbers and idempotency keys. Accepts reports only from the
  session's own user.
- Rotation = the client calls `POST /api/voice/sessions` again with the
  same device id (Ledger supersession does the bookkeeping), exactly like
  Coder's `rotateCredential()` but with the Nessie route as the source.

The ephemeral Gemini access token is the *only* credential the phone ever
sees: one-use, 30-minute, restricted to the constrained Live endpoint —
that is precisely what it was designed for.

A small `voice_sessions` table (user, org, device hash, Ledger session id,
model, expiry, timestamps) gives the relay its lookup and gives `/ops/usage`
an owner-only observability row. No cost figures locally — Ledger meters,
UOA rates; same rule as everything else.

### 2. The call is the PA, live — context seeded, tools real

**Decided (2026-09-02):** the voice agent is not a dumb relay. It gets the
previous DM conversation at call start, and it gets real tools during the
call, so things actually happen while you talk. The way to grant that
without minting a second brain is: **Gemini does the talking and the tool
*choosing*; every tool executes server-side inside the existing PA run
machinery.** The device never holds a tool credential, and no gate is
bypassed.

- **Context seeding.** `POST /api/voice/sessions` returns, alongside the
  credential, a context bundle rendered server-side: the recent PA DM
  window (a bounded slice — Gemini Live re-bills accumulated context every
  turn, so the seed is deliberately small, on the order of the last few
  dozen messages / a few thousand tokens) plus the PA's identity and
  standing instructions. The client folds it into the session `setup`
  system instruction. Everything in the bundle is messages the caller can
  already read through the normal DM read path, and the session's only
  audience is the caller — so seeding leaks nothing. Older history is not
  seeded; it is one tool call away (below), which is both cheaper and
  correct.
- **Live tools, server-executed.** When a call starts, the worker opens a
  **voice run** for the PA: same toolset assembly as any PA run (builtins +
  granted MCP projections), same budget metering, same disclosure sink,
  same single truncation chokepoint. The session response carries the
  projected function declarations for Gemini's `setup` (a curated hot set
  plus a `find_tools`-style meta tool above the inline limit — the existing
  deferred-tools discipline, not a new one). Each Gemini function call goes
  to `POST /api/voice/sessions/:id/tool-call`, which dispatches through the
  voice run's chokepoint and returns the (truncated) result for Gemini to
  speak from. Coder's rule holds on-device: tool calls run in their own
  tasks and never block the socket receive loop.
- **Approvals park, never bypass.** A tool behind an approval gate returns
  `{status: "approval_required"}` to Gemini, which says so aloud; the
  approval itself happens on its existing surfaces. A voice turn can never
  confirm a Nessie approval — that rule from Coder's security doc survives
  verbatim.
- **`pa_send(text)` stays, for the long-running work.** Quick lookups and
  actions happen live through the tool bridge; "go research X and get back
  to me" is handed off as a real user message into the DM via the existing
  message-create route, spawning an ordinary asynchronous PA run. The
  client watches the thread (SSE `stream.done`) and injects the reply into
  the Gemini session to be spoken when it lands — with an immediate
  `{status:"working"}` ack so nothing blocks meanwhile.
- **Disclosure holds by construction.** Voice-run tool reads feed
  `ConsumedSourceSink` exactly like any run's reads (the obligation sits on
  the read, unchanged). The spoken reply reaches only the caller; the
  durable transcript record (below) is stamped with the voice run's
  accumulated basis at write time, like any agent message, so a privileged
  read during a call cannot launder into a wider room later.

The Gemini system instruction carries the spoken-style rules (concise,
answer-first, never read markdown syntax aloud) — model-judged behaviour,
per the no-string-matching standard. Coder's elaborate terminal-fencing
apparatus (`docs/ios-voice-session-security.md`) is not needed because no
raw terminal bytes ever enter this session; what we keep from it is the
logging discipline — no tool argument or transcript values in device
diagnostics, shape only.

### 3. The native layer needs a credential it deliberately never had

The Expo shell's standing rule is "the native app never sees an
authenticated Nessie token" (`mobile/src/lib/push-notifications.ts`) — auth
lives in the WebView session. A CallKit call must keep working with the
screen locked and the WebView suspended, so the native layer needs its own
credential. Amend the invariant deliberately, not by accident:

- `POST /api/voice/device-token` — called by the **SPA** (WebView, ordinary
  session auth); mints a short-lived, rotating, *voice-scoped* bearer bound
  to (user, org, device). Scope: the two voice-session routes plus message
  create/read **on the caller's PA DM channel only**. Delivered to native
  over the existing native-shell bridge message channel, stored in
  Keychain, refreshed the same way on app foreground.
- The invariant's new wording: the native app never sees a *general* Nessie
  session; it may hold the voice-scoped device token, which cannot reach
  any other route or channel.

### 4. The web admin gets the same call — no CallKit, same everything else

Because the ephemeral token is safe to hand to any authenticated client,
the browser can hold the whole session too: the admin SPA opens the same
Gemini Live WebSocket directly, captures the mic via
`getUserMedia` + an `AudioWorklet` resampling to 16 kHz PCM, and plays the
24 kHz response through WebAudio. Everything above the audio layer —
`POST /api/voice/sessions` (ordinary session-cookie auth on web, no device
token needed), the setup payload, rotation, the `pa_send` tool bridge, the
usage relay — is byte-identical to the native path, so the protocol client
is written once in TypeScript for the web (`admin/src/facades/voice/`) and
once in Swift for the phone; the *server* contract is the single shared
thing. Web "device id" is a per-browser-installation UUID in
`localStorage`, HMAC'd server-side with the user id exactly like the native
one, so each browser gets its own Ledger slot. The desktop Tauri shell gets
this for free through the hosted admin.

### 5. It lives in the Expo app as a local native module

`mobile/` is a managed Expo app (SDK 55, dev-client already in use), so the
Swift lives in a **local Expo module** (`mobile/modules/nessie-voice-call/`)
containing the ported Coder files, exposed to JS as a small surface
(`startCall`, `endCall`, `setMuted`, state/transcript events). A config
plugin adds: `NSMicrophoneUsageDescription`, `UIBackgroundModes: [audio]`
(and `voip` in phase 3), and the App Intents metadata. The JS side only
renders state — the call must survive JS reloads; all lifecycle stays
native. Android is out of scope for phase 1; the module API stays
platform-neutral so a `ConnectionService` implementation can slot in later
(phase 3), and on Android the module reports "unavailable" cleanly.

CallKit does not run meaningfully on the iOS simulator — device builds
(`pnpm --filter @nessie/mobile build:device:ios`, existing EAS profile) are
the verification path, per the repo's install-on-named-device build rule.

### 6. What this is *not*

- **Not a provider-linked call — but it *is* the same button.** Nessie's
  existing `Call` domain mints Google Meet/Jitsi links and rings channels;
  a PA voice session is a different animal (one person, one agent, no
  external meeting URI) and gets its own small model rather than a fake row
  in `calls`. The **surface** is shared per Rule zero: the channel header's
  call button is one component, and on the `personal_assistant` system
  channel it starts the Gemini voice call (a structural fact of the channel
  kind, not a content heuristic), while every other channel keeps
  provider-linked behaviour. No second look-alike phone glyph.
- **Not touching `macos/`.** The OpenAI-Realtime companion stays as-is,
  architecturally separate. If it ever converges onto the Ledger Gemini
  path, that is its own plan.
- **Not a second agent loop.** Gemini chooses tools, but every execution,
  gate, meter, and disclosure decision happens inside the worker's existing
  run machinery via the voice run — there is no client-side toolset, no
  duplicated authorization, and no device-held credential for any tool.

## Rule zero — the doorways

- **Home:** the call button already in the top-right of the PA conversation
  header — on web, mobile, and desktop alike — becomes the trigger. One
  button, every client; no new glyph.
- **In-context entries:** the App Shortcut ("Call my assistant with
  Nessie") for Siri/CarPlay/Shortcuts; `includesCallsInRecents` so redial
  works from the system Recents list.
- **Ops:** voice sessions appear as rows in the owner-only `/ops/usage`
  telemetry (session count/duration per user; no currency), because a $5/day
  per-device Ledger reservation is something an owner must be able to see
  the cause of.

## Phases

**Phase 0 — decisions + ops (no code)**
Add the `gemini-3.1-flash-live-preview` model grant and `live-token`
endpoint grant to the production `LEDGER_PROXY_TOKEN`; confirm daily budget
headroom for the per-device reservations. Sign off the two open decisions
below.

**Phase 1 — the server contract + the web call**
API: `voice_sessions` table + the three routes (`sessions`, `usage`,
`device-token`), Ledger relay through the existing signing seam, tests for
the relay's idempotent usage sequencing and the scoped token's refusal of
non-voice routes; context-bundle assembly in the session response. Admin:
the PA channel's existing header call button starts a Gemini Live call in
the browser (TypeScript protocol client, AudioWorklet capture, WebAudio
playback, `pa_send` bridge + reply injection, in-call popover with
mute/end/transcript ticker). This lands the whole product loop with the
fastest verification cycle (Playwright + a real browser mic session)
before any native build is involved.

**Phase 1a — the live tool bridge**
The worker-side voice run (toolset assembly, budget metering, disclosure
sink, truncation chokepoint reused; new lifecycle: opened at session
start, closed at call end, holding the `(agent, thread)` slot like any
run), the `tool-call` route, function-declaration projection into the
session response, approval parking. This is the largest single piece of
server work in the plan and is what turns the call from a relay into
"actually doing stuff while you talk" — sequenced right after the basic
call loop proves out so the run plumbing lands on a working audio path.

**Phase 1b — the iPhone call**
Mobile: local Expo module with the ported `GeminiLiveClient` +
`AgentCallCoordinator` + `AgentCallSession` seam; credential source swapped
to the Nessie routes; the same header call button in the mobile WebView
hands off to native via the shell bridge so the call becomes a CallKit
call. Verify on a physical iPhone: place call, lock screen, AirPods, mute
from lock screen, end from lock screen.

**Phase 2 — Siri, CarPlay, polish**
App Intent + Shortcuts phrases; verify initiation and in-call UI in CarPlay
(real car or CarPlay simulator head unit). The call-record message (below)
posted into the PA DM. Reconnect polish (Coder's resumption + rotation
paths exercised under airplane-mode blips).

**Phase 3 — the PA calls you, and Android**
VoIP PushKit + `reportNewIncomingCall` (iOS requires reporting a call for
every VoIP push — the worker must never send a speculative ring). A
`voice_call_start`-shaped PA builtin following the route-mirroring pattern
(`meeting_link_create`/`call_start` precedent), so "call me when the deploy
finishes" works. Android `ConnectionService` parity. Each of these is its
own spec when we get there.

## The call record — one folded message, full transcript inside

**Decided (2026-09-02):** the full transcript is persisted in the PA DM,
folded into **one message per call**. The feed shows a collapsed call
card — "📞 Call with Personal Assistant · 6 min" — that expands in place to
the complete transcript underneath. No per-utterance messages: a call is
one conversation event, not forty rows of crap burying the channel.

Design, matched to the standing invariants:

- **Written once, at call end.** Nothing rewrites a message, so the record
  is not created at call start and edited as lines arrive — the client
  buffers the transcript locally (it already holds it for the live ticker)
  and the message is written when the call ends. A dropped app mid-call
  loses at most that call's record, never a half-edited message; if that
  ever matters, periodic client-side checkpointing into the *pending*
  record is a later refinement, still ending in exactly one message.
- **Server-authored metadata, via the session.** The client does not post a
  free-form message carrying `metadata.voiceCall` — metadata keys that
  drive rendering and orchestration are server-written (the
  `agentCard`/`replyBroadcast` discipline). Instead
  `POST /api/voice/sessions/:id/transcript` accepts the transcript lines,
  verifies the session belongs to the caller and is ending/ended, writes
  the message server-side stamped `metadata.voiceCall = { voiceSessionId,
  durationMs, turnCount }`, and closes the session's transcript slot
  (set-once, so a retry cannot produce two records). The voice-scoped
  device token's allowed surface already covers exactly this route.
- **Content is the transcript, plain text.** `Ondrej: …` / `Assistant: …`
  lines in the message content — so channel search finds what was said, and
  the PA's later runs get the call in their conversation window like any
  other message (that is the point of persisting it: "as we discussed on
  the call" just works). The collapsed rendering is a client concern keyed
  on the metadata, like the other metadata-rendered message kinds — not a
  new card system.
- **Size guard.** A long call is a big message and enters the PA's context
  window whole. Above a threshold (~16 KB of transcript), the message keeps
  the head plus a marker line, and the full transcript is stored as a `.md`
  attachment on the same message through the one `FileService` chokepoint —
  readable on demand (and by the PA via its attachment tools, which feed
  the disclosure sink like every read). The expanded card stitches the two
  seamlessly; the threshold covers the overwhelming majority of calls
  without ever letting one marathon call eat the context window.
- **`pa_send` messages stay real messages.** Commands relayed to the PA
  during the call were already posted as ordinary user turns when they
  happened — the transcript record does not duplicate them as new turns; it
  is the record of what was *spoken*, and the folded card renders around
  the interleaved command/reply messages in feed order.

## Open decisions for Ondrej

1. **Voice-scoped device token shape.** Proposed: short-lived JWT minted by
   the API, delivered via the WebView bridge, Keychain-stored, ~1 h expiry
   with foreground refresh. Alternative is a long-lived revocable device
   credential row (more machinery, survives long offline gaps). The short
   JWT is recommended — a call can't start offline anyway.
