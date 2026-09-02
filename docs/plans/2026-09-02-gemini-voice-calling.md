# Call your Personal Assistant — Gemini Live voice + CallKit on iPhone

**Status: plan (2026-09-02). Nothing here is built yet.**

Ondrej wants to *call* his Personal Assistant from an iPhone: real-time
voice-to-voice, presented to iOS as a phone call — lock-screen call UI,
AirPods/Bluetooth routing, CarPlay, "Hey Siri, call my assistant". The Coder
project (`/Volumes/External/Projects/Coder`, `ios/TalkIOS.swiftpm`) has a
working implementation of exactly this shape against Gemini Live; this plan
says what we port, what Nessie must do differently, and in what order.

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

### 2. The PA is the brain; Gemini is the mouth

Coder wires Gemini function calls into terminal/session control with an
elaborate security boundary (`docs/ios-voice-session-security.md`) because
its tools touch terminals. Nessie's version is deliberately simpler and
safer: **the voice call is a control surface for the PA DM channel** (which
CLAUDE.md already declares is voice's role). Gemini gets a minimal tool set
that only does what the person could do by typing in that DM:

- `pa_send(text)` — POSTs a real user message into the PA DM channel via the
  existing message-create route with the user's own authority. The normal
  orchestrator engages the PA; every existing gate (RBAC, approvals,
  disclosure basis, PA tool authorization) applies unchanged, because the
  run is indistinguishable from a typed message. The voice layer adds **no
  new authority anywhere**.
- Reply delivery — the native client watches the PA thread (poll
  `GET` messages after the posted id, or the thread SSE stream; SSE
  `stream.done` is the precise signal) and injects the PA's reply back into
  the Gemini session as a tool follow-up / text turn to be spoken.
  Long-running runs must not block the tool response: `pa_send` acks
  immediately with `{status:"working"}` when no reply lands within a few
  seconds, Gemini tells the caller it's working on it, and the reply is
  injected as its own turn when it arrives (Coder's `sendUserText` /
  `speakAssistantText` precedent).

The Gemini system instruction carries the spoken-style rules (concise,
answer-first, never read markdown syntax aloud) — model-judged behaviour,
per the no-string-matching standard. The PA reply injected into Gemini is
our own agent's judged output, not raw tool bytes, so Coder's
terminal-fencing apparatus is not needed; what we do keep from Coder's
security doc is the logging discipline (no argument/transcript values in
device diagnostics) and the rule that a voice turn can never confirm a
Nessie approval — approvals stay on their existing surfaces.

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

### 4. It lives in the Expo app as a local native module

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

### 5. What this is *not*

- **Not a provider-linked call.** Nessie's existing `Call` domain mints
  Google Meet/Jitsi links and rings channels. A PA voice session is a
  different animal (one person, one agent, no external meeting URI) — it
  gets its own small model rather than a fake row in `calls`, and the two
  surfaces stay visually distinct so nobody expects teammates to join.
- **Not touching `macos/`.** The OpenAI-Realtime companion stays as-is,
  architecturally separate. If it ever converges onto the Ledger Gemini
  path, that is its own plan.
- **Not a second agent loop.** Gemini holds no Nessie tools beyond the DM
  bridge; all real capability remains in the PA's worker run.

## Rule zero — the doorways

- **Home:** the PA conversation screen in the mobile app gets a call button
  (phone glyph) in its header — the same place a person's thumb goes in any
  messenger. That is the owning surface.
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

**Phase 1 — outgoing call, end to end**
API: `voice_sessions` table + the three routes (`sessions`, `usage`,
`device-token`), Ledger relay through the existing signing seam, tests for
the relay's idempotent usage sequencing and the scoped token's refusal of
non-voice routes. Mobile: local Expo module with the ported
`GeminiLiveClient` + `AgentCallCoordinator` + `AgentCallSession` seam;
credential source swapped to the Nessie routes; `pa_send` tool + reply
injection; call button on the PA screen; usage relay wired. Verify on a
physical iPhone: place call, lock screen, AirPods, mute from lock screen,
end from lock screen.

**Phase 2 — Siri, CarPlay, polish**
App Intent + Shortcuts phrases; verify initiation and in-call UI in CarPlay
(real car or CarPlay simulator head unit). End-of-call summary message
posted into the PA DM (`metadata.voiceCall`, one message per call — the
channel's durable record that a call happened and what was decided), rather
than streaming every transcript line into the channel. Reconnect polish
(Coder's resumption + rotation paths exercised under airplane-mode blips).

**Phase 3 — the PA calls you, and Android**
VoIP PushKit + `reportNewIncomingCall` (iOS requires reporting a call for
every VoIP push — the worker must never send a speculative ring). A
`voice_call_start`-shaped PA builtin following the route-mirroring pattern
(`meeting_link_create`/`call_start` precedent), so "call me when the deploy
finishes" works. Android `ConnectionService` parity. Each of these is its
own spec when we get there.

## Open decisions for Ondrej

1. **Transcript persistence.** Phase 2 proposes a single end-of-call summary
   message in the PA DM rather than per-utterance transcript messages. If
   you want the full transcript durable (searchable, feeds later PA
   context), say so — it changes the message-write design (bulk, marked
   `metadata.voiceCall`, probably collapsed in the feed).
2. **Voice-scoped device token shape.** Proposed: short-lived JWT minted by
   the API, delivered via the WebView bridge, Keychain-stored, ~1 h expiry
   with foreground refresh. Alternative is a long-lived revocable device
   credential row (more machinery, survives long offline gaps). The short
   JWT is recommended — a call can't start offline anyway.
