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
  rule ordinary inference already follows. **Correction from adversarial
  review:** the concurrency cap does NOT come free per-user — Ledger's
  count filters by `tokenId` only (`gemini-live-repository.ts:159-173`),
  so on Nessie's one deployment-wide token
  `PROXY_TOKEN_USER_MAX_CONCURRENT_SESSIONS` is a **global** cap across
  the whole deployment. Coder never hit this because its tokens are
  per-user. The Ledger fix (include `endUserSub` in the concurrency
  predicate, with a two-subjects-one-token regression test) is a launch
  blocker.
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
  rates it knowingly. Two qualifications from review: Google Cloud Billing
  *does* export authoritative provider cost at **project** scope — the
  limitation is per-session attribution under a shared project, and a
  reconciliation of client-reported totals against project billing is the
  honest audit for the margin decision; and the portfolio's `calls` column
  counts **usage turns** (one `LedgerEntry` per turn), not phone calls —
  the statement display must say turns, or Ledger adds a session-level
  count. **Gating:** the Ledger portfolio change + Ledger concurrency fix
  + UOA rating of `client_reported` cost are release blockers for anything
  beyond Ondrej's own testing; phase 1 is explicitly an unbilled dev
  phase.
- Trust note, for the record: usage is client-reported because Google
  exposes no per-session server-side metering — a compromised client could
  under-report. The $5/day reservation is **admission control, not a
  spending bound**: Ledger checks it only at issuance, live entries carry
  `realCost: 0` so client-reported spend never consumes the daily-budget
  calculation mid-day, and a superseded credential stays valid at Google
  until its 30-minute expiry. The actual exposure bounds are the Google
  project spend/rate controls plus Nessie's own per-call caps (§2) and
  per-user mint caps (§1).

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
- **`voiceSessionId` is call-scoped and survives rotation.** Rotation
  (`POST /api/voice/sessions/:id/rotate`) mints a fresh Ledger credential
  for the *same* voice session — Ledger supersession does the slot
  bookkeeping, and the row just updates its current Ledger session id.
  Keying rotation as a brand-new voice session would double the transcript
  slot, orphan the tool-call claims, and split the usage relay mid-call.
  One call = one `voiceSessionId`, N Ledger sessions.
- **Device ids are server-minted.** A client-chosen id (a `localStorage`
  UUID, a reinstalled Keychain) would let one authenticated user mint
  unlimited Ledger device slots, each reserving $5/day against the
  deployment token's budget. Instead the relay registers installations
  server-side and enforces **per-user caps**: max active voice
  installations and max session mints per day. The HMAC'd id sent to
  Ledger derives from the server-side registration.

The ephemeral Gemini access token is the *only* credential the phone ever
sees: one-use, 30-minute, restricted to the constrained Live endpoint —
that is precisely what it was designed for.

The `voice_sessions` row binds, immutably at mint: user, **the exact UOA
subject/organization/team tuple and credential epoch used to sign the
mint** (later usage/tool/transcript requests re-sign against that bound
tuple and refuse on workspace drift — never ambient current-workspace
context), device registration, current Ledger session id, model, expiry,
the per-call caps, and the durably accumulated disclosure scopes. It gives
the relay its lookup and `/ops/usage` an owner-only row that names the
decision it drives: active slot state and which user/device holds today's
reservation. No cost figures locally — Ledger meters, UOA rates.

Usage-relay durability: Coder's usage reporter queues in memory and gives
up after three drain attempts — app death loses usage. The Nessie clients
keep a small persistent outbox (Keychain-adjacent storage native,
IndexedDB web) replayed by exact sequence on next launch, and a session
whose reports never completed is marked incomplete server-side rather than
silently final.

### 2. The call is the PA, live — context seeded, tools real

**Decided (2026-09-02):** the voice agent is not a dumb relay. It gets the
previous DM conversation at call start, and it gets real tools during the
call, so things actually happen while you talk. Honest framing (adversarial
review made the first draft's "same run machinery" claim untenable): **this
is a voice orchestrator of its own** — Gemini owns the conversational loop,
turn-taking, and tool choice — and what Nessie guarantees is that **no
authority exists client-side**: every tool executes server-side through the
shared tool implementations and gates, with its own explicitly designed
lifecycle rather than a pretended reuse of `Run`.

- **Context seeding — role-preserving, never system-tier.** The session
  response carries a server-rendered context bundle: a bounded recent DM
  slice (Gemini Live re-bills accumulated context every turn, so the seed
  is small — a few thousand tokens). Only the PA's identity and standing
  instructions go into `setup.systemInstruction`; the conversation history
  is sent as **role-preserving client-content turns**, because folding
  user/agent history into the system instruction would promote untrusted
  conversation content to the highest instruction tier. Everything in the
  bundle is messages the caller can already read via the normal DM read
  path, and the session's only audience is the caller — seeding leaks
  nothing. Older history is one tool call away, which is cheaper and
  correct.
- **A voice session is not a `Run` row.** Runs are one-shot queue jobs
  serialized per `(agent, thread)` (`claimThreadRunOrPend`); a "run" held
  open for a whole call would (a) pend every message posted to the DM until
  the call ends — killing `pa_send` — and (b) occupy an execution slot and
  budget envelope with no defined trigger/terminal semantics. Instead the
  `voice_sessions` row is the durable state, and each tool call is its own
  short server-side dispatch: `POST /api/voice/sessions/:id/tool-call`
  atomically **claims `(voiceSessionId, geminiToolCallId)` with an argument
  hash** (retries replay the cached result; a changed-args replay is
  refused), executes through the shared tool implementations and the single
  truncation chokepoint, persists the consumed disclosure scopes durably on
  the voice session **in the same transaction as the tool result** (the
  in-memory `ConsumedSourceSink` cannot span independent HTTP requests),
  and returns the result. The voice session never holds the `(agent,
  thread)` chat slot, so typed messages and `pa_send` runs proceed
  normally during a call.
- **Voice-sized budgets, enforced at the relay.** "Same budget metering"
  was false — Live spend never enters the local token ledger. The voice
  session gets its own per-call caps enforced server-side: wall-clock,
  tool-call count, and an estimated-spend ceiling fed by the relayed usage
  reports; hitting one ends the call with a spoken notice. Tool results
  returned to Gemini get a **voice-specific cap far below the ordinary
  32,000-char chokepoint ceiling** (order of 2–4 KB), because every byte
  returned is re-billed on every subsequent turn of the call.
- **Tool declarations are setup-time.** Gemini Live takes function
  declarations only in the WebSocket `setup`, so the deferred-tools
  mutation trick does not port. The declared set is a curated hot set plus
  one generic `invoke_tool(name, args)` dispatcher (validated server-side
  against the assembled toolset) for everything discovered via a
  `find_tools` meta tool — a discovered tool is callable without a
  reconnect because the dispatcher, not the declaration list, is the
  contract.
- **Approvals refuse in-call; they never resume into the socket.** The
  existing approval machinery checkpoints a run and resumes it as a
  continuation run — there is no path that delivers a later-approved
  result back into a live Gemini WebSocket, and this plan does not invent
  one. A tool behind an approval gate returns
  `{status: "approval_required"}`; Gemini says so aloud, and the action
  goes through `pa_send` as an ordinary PA run whose approval flows on its
  existing surfaces. A voice turn can never confirm a Nessie approval.
- **`pa_send(text)` stays, for the long-running work.** "Go research X" is
  handed off as a real user message via the existing message-create route,
  spawning an ordinary asynchronous PA run. The client watches the thread
  (SSE `stream.done`; when the run consumed a privileged source the SSE
  lane is structurally cut by `runReplyIsRestricted`, so the client falls
  back to the viewer-entitled REST read on completion) and injects the
  reply to be spoken — with an immediate `{status:"working"}` ack so
  nothing blocks meanwhile.
- **Untrusted content stays data.** The first draft dismissed Coder's
  fencing too broadly: no terminal bytes enter this session, but web
  pages, documents, and MCP results do, and they are exactly the injection
  surface Coder's security doc names. Tool results are bounded, and the
  session instruction carries the Coder-style
  observations-are-data-not-instructions framing — while the actual
  security boundary remains server-side: nothing a tool result says can
  widen the toolset, skip a gate, or confirm an approval, because those
  decisions never live in the model.
- **Provider governance.** A voice call sends DM history, tool results,
  and raw audio to Google regardless of the org's configured chat
  provider. Voice calling is therefore an **org-level feature toggle**
  (owner-set, like other integrations), and enabling it is the org's
  explicit consent to Google as the audio/model processor for this surface.

The Gemini system instruction also carries the spoken-style rules (concise,
answer-first, never read markdown aloud) — model-judged behaviour, per the
no-string-matching standard. From Coder's security doc we keep the logging
discipline verbatim: no tool argument or transcript values in device
diagnostics, shape only.

### 3. The native layer needs a credential it deliberately never had

The Expo shell's standing rule is "the native app never sees an
authenticated Nessie token" (`mobile/src/lib/push-notifications.ts`) — auth
lives in the WebView session. A CallKit call must keep working with the
screen locked and the WebView suspended, so the native layer needs its own
credential. Amend the invariant deliberately, not by accident:

- `POST /api/voice/device-token` — called by the **SPA** (WebView, ordinary
  session auth); mints a *voice-scoped* credential bound to (user, org,
  device registration) and **backed by revocable server state**, not a
  bare stateless JWT: every request rechecks session revocation, live
  membership, and the UOA epoch, exactly as ordinary sessions do — theft
  of the token dies with the session it derives from.
- **Scope = the voice routes only, enumerated.** Nessie has no
  generic route-scoping machinery (`requireActorContext` checks no
  scopes), so the token is honoured exclusively by dedicated
  voice endpoints: session mint/rotate, usage, tool-call, transcript,
  a narrow `pa-send` action, and a voice-scoped reply stream/poll for the
  `pa_send` follow-up. It is **not** accepted by the generic message
  routes or the thread SSE route — scoping those by channel would bolt a
  second auth mode onto every general route. The build ships a
  method-by-path authorization matrix (web cookie vs voice token vs both)
  as part of the phase-1 spec.
- **Refresh cannot depend on the WebView.** A locked-phone CallKit call
  outlives any foreground refresh, and rotation/usage/transcript all need
  the credential mid-call. The native layer refreshes the voice credential
  itself (its own refresh exchange against the voice routes); minting at
  call start guarantees a minimum validity covering the longest allowed
  call, and the WebView bridge is only the *initial* provisioning path.
- The invariant's new wording: the native app never sees a *general*
  Nessie session; it may hold the voice-scoped device credential, which
  only the enumerated voice routes accept.

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
thing. The web "device" is a server-registered installation like the
native one (see §1 — client-chosen ids would multiply $5 reservations),
with the browser holding only an opaque registration handle. The desktop
Tauri shell gets this for free through the hosted admin.

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
- **Not a hidden second agent loop — an explicit one.** Gemini *is* a
  second conversational loop, and the plan says so rather than pretending
  the worker's agentic loop is reused. What is genuinely shared: the tool
  implementations, the authorization gates, the truncation chokepoint, and
  the disclosure obligations — all server-side, with the voice session's
  own lifecycle, idempotency, and caps designed explicitly (§2). No
  client-side toolset, no duplicated authorization, no device-held tool
  credential.

## Rule zero — the doorways

- **Home:** the call button already in the top-right of the PA conversation
  header — on web, mobile, and desktop alike — becomes the trigger. One
  button, every client; no new glyph.
- **In-context entries:** the App Shortcut ("Call my assistant with
  Nessie") for Siri/CarPlay/Shortcuts; `includesCallsInRecents` so redial
  works from the system Recents list.
- **Ops:** voice sessions appear as rows in the owner-only `/ops/usage`
  telemetry — and the rows name the decision they drive: which user +
  installation holds today's $5 reservation slot, session state, and a
  revoke action on a registration (per-user caps in §1 are what the owner
  is adjusting for). Bare count/duration numbers with no action would fail
  Rule zero's third check. No currency figures.

## Phases

**Phase 0 — decisions + ops (no code)**
Add the `gemini-3.1-flash-live-preview` model grant and `live-token`
endpoint grant to the production `LEDGER_PROXY_TOKEN`; confirm daily budget
headroom for the per-device reservations. Sign off the open decision
below. File the two Ledger tasks (portfolio cost passthrough; per-subject
concurrency) and the UOA rating task — release blockers past phase-1
testing.

**Phase 1 — the server contract + the web call**
API: `voice_sessions` table + routes (session mint/rotate, usage relay,
device registration + voice credential, transcript), the method-by-path
authorization matrix, Ledger relay through the existing signing seam,
tests for the relay's idempotent usage sequencing and the voice
credential's refusal of non-voice routes; context-bundle assembly
(role-preserving turns) in the session response. Admin: the PA channel's
existing header call button starts a Gemini Live call in the browser
(TypeScript protocol client, AudioWorklet capture, WebAudio playback,
`pa_send` bridge + reply injection with the restricted-SSE REST fallback,
in-call popover with mute/end/transcript ticker). **Verification item:**
prove credential rotation + Gemini session-resumption handles compose
across ephemeral tokens on a live call (Coder ships exactly this
composition, which is strong evidence, but it has to be seen working
through the relay), with re-seeding on a fresh socket as the documented
fallback. Explicitly unbilled dev phase.

**Phase 1a — the live tool bridge**
The voice-session tool dispatch of §2: per-call claims
(`voiceSessionId` + tool-call id + argument hash), shared tool
implementations behind the truncation chokepoint with voice-sized result
caps, durable disclosure-scope accumulation, per-call budget caps,
`invoke_tool` dispatcher + `find_tools`, approval refusal semantics, and
the org-level voice feature toggle. This is the largest single piece of
server work in the plan and is what turns the call from a relay into
"actually doing stuff while you talk" — sequenced right after the basic
call loop proves out so the plumbing lands on a working audio path.

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

Design, revised after adversarial review — three findings reshaped the
first draft: a `user`-role record would **structurally wake the PA**
(`resolvePersonalAssistantDecisions` replies to every user turn in a PA
DM), a mixed-speaker transcript cannot live under a single message role
without either the assistant's lines becoming user instructions or the
user's lines becoming assistant assertions, and messages cap at 4,000
characters anyway. The shape that satisfies all three **and** Ondrej's
folded-card requirement:

- **The record is an `agent`-role message from the PA, written at call
  end.** Role `agent` is the structural no-engagement path (the PA never
  replies to its own message), so no billed run answers the record. Its
  *content* is a short summary of the call (≤ 4,000 chars) — searchable,
  and in the PA's later conversation windows so "as we discussed on the
  call" works. The **full transcript is a `.md` attachment on that same
  message**, stored through the one `FileService` chokepoint, speaker
  lines preserved as labeled text — never role-bearing turns. The PA reads
  it on demand via its attachment tools (which feed the disclosure sink),
  and the expanded call card renders the transcript from the attachment.
  Full-transcript search is honestly out of scope for phase 2 (message
  search covers the summary; an entitlement-aware transcript index is its
  own later feature — and search already excludes basis-carrying messages
  by design).
- **Server-authored, via the session, through the message-create
  service.** `POST /api/voice/sessions/:id/transcript` verifies the
  session belongs to the caller and is ending/ended, then writes through
  the existing message-create service — never a bespoke Prisma insert, or
  it silently skips realtime publish, reply bookkeeping, and the
  disclosure-basis stamping chokepoint — with `metadata.voiceCall =
  { voiceSessionId, durationMs, turnCount }` and the basis stamped from
  the session's **durably accumulated** scopes (§2). It closes the
  session's set-once transcript slot, so a retry cannot produce two
  records; rotation cannot either, because `voiceSessionId` is
  call-scoped (§1).
- **Client transcript text is labeled, and sanity-checked.** The spoken
  lines are client-reported (only the client saw the audio), so the
  attachment is marked client-reported in the card, and the server
  cross-checks plausibility against the usage turns it relayed for that
  session — a "transcript" for a session with no relayed usage is
  refused. The summary line the PA context carries is generated
  server-side from the same submission, not trusted as instructions.
- **Written once; crash-safe enough.** The client buffers the transcript
  (it already holds it for the live ticker) in the same persistent outbox
  as the usage reports, so an app death mid-call submits the record on
  next launch rather than losing it. Nothing rewrites the message after it
  lands.
- **`pa_send` messages stay real messages.** Commands relayed during the
  call were posted as ordinary user turns when they happened; the record
  does not duplicate them. The feed stays strictly time-ordered — the call
  card lands at call end and *references* the call window; it does not
  pretend to wrap earlier rows.

## Open decision for Ondrej

1. **Voice call caps.** §2 introduces per-call caps (wall-clock, tool
   calls, estimated spend) and §1 per-user caps (active installations,
   session mints per day). The *numbers* are the open decision — e.g. max
   call length 30/60/120 min, max 2 installations per user, spend ceiling
   per call. Everything else that was open (the credential shape) is now
   designed in §3: a revocable server-state-backed voice credential with
   native-side refresh, not a bare short-lived JWT — review showed the
   stateless-JWT-with-foreground-refresh idea dies on a locked-phone call.

## Review log

- 2026-09-02: adversarial review by Kimix (narrowed brief, 11 findings)
  and Codex Sol (full scope, 28 findings), each verified against the
  Nessie/Coder/Ledger code before folding in. Confirmed highs reshaped
  the plan: the voice session is not a `Run` and never holds the
  `(agent, thread)` slot; tool calls are idempotent server dispatches
  with durable disclosure accumulation; approvals refuse in-call; context
  seeds as role-preserving turns, never system-tier; the call record is
  an agent-role summary message + transcript attachment (a user-role
  record would structurally wake the PA, and one role cannot carry two
  speakers); device ids are server-minted with per-user caps; the voice
  credential is revocable server state with native refresh; Ledger's
  concurrency cap is per-token (global for Nessie) until fixed; the $5
  reservation is admission control, not a spend bound. Rejected/absorbed
  as already-covered: none of the reviewers' findings were dropped
  outright; two were softened with evidence (Coder ships
  rotation+resumption composition; Ledger concurrency enforcement exists
  but mis-scoped).
