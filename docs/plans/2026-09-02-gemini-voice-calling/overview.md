# Call your Personal Assistant — Gemini Live voice on web, iPhone and Android

**You can place this call today.** Open the Personal Assistant DM and press
the call button in the header: the browser opens a live voice conversation
with your assistant, and audio flows straight between your device and Google.
It works in the web admin, in the desktop shell, and in the iOS app in the
foreground. Verified end to end on 2026-09-02 against the real services.

**On an iPhone it is a real phone call** *(built 2026-09-03, and not yet placed
— see "What 1b's verification did and did not cover")*: the mobile app's header
button hands off to a local Expo native module that places a CallKit call, so
it reaches the lock screen, Recents, and the CarPlay in-call screen, and keeps
running with the phone locked. Android is still the web
call in a WebView — the lifecycle seam the iOS module is built on was written
against the call lifecycle rather than against CallKit, so its `ConnectionService`
successor reuses everything above the audio layer.

Two things it is not yet. **A locked-phone call is capped under 30 minutes**:
credential rotation from a backgrounded, locked phone is implemented but has
not been observed working, and the default call ceiling ends the call before
rotation would ever be needed. And **the assistant cannot act mid-call** beyond
handing work to itself: the only declared function is `pa_send`, which posts an
ordinary message into the DM and starts a normal run. Live tools are designed
but unbuilt.

## Table of Contents

- [Design and what's built](#where-the-code-is)
- [Status, rollout, and open items](./status-and-rollout.md)

## Where the code is

| Piece | Lives in |
| --- | --- |
| Credential broker + call lifecycle | `api/src/routes/voice.ts`, `api/src/services/voice/*` |
| Enrolment (capability + device slots) | `api/src/routes/voice-enrolment.ts` |
| Wire contract | `packages/schemas/src/voice.ts` |
| Voice list + speaking-style presets | `packages/schemas/src/voice.ts`, `packages/schemas/src/agent-speech.ts` |
| Durable state | `voice_installations`, `voice_sessions` (migration `20260902160000_voice_calling`) |
| Browser client | `admin/src/facades/voice/*`, worklet at `admin/public/voice-capture-worklet.js` |
| The one call button | `admin/src/components/features/channels/ChannelHeader.tsx` |
| iPhone CallKit call | `mobile/modules/nessie-voice-call/` (local Expo module, Swift) |
| The hand-off to it | `admin/src/facades/voice/native-voice-call.ts`, `mobile/src/lib/native-voice-call.ts` |
| In-call surface | `admin/src/components/features/channels/VoiceCallDialog.tsx` |
| Android build plan | [2026-09-02-voice-android.md](2026-09-02-voice-android.md) *(drafted, unreviewed)* |

## The shape of it, in one paragraph

Ledger mints a **one-use ephemeral Gemini credential**; the Nessie API is the
broker that asks for one on the authenticated caller's behalf, carrying the
deployment's `LEDGER_PROXY_TOKEN` and signed identity. The client then opens
Google's *constrained* BidiGenerateContent socket **itself**, so audio never
passes through Nessie and the app key never leaves the server. One call is one
`voice_sessions` row that survives credential rotation, so a 30-minute
credential can be replaced mid-call without splitting the usage stream or the
transcript. The call ends as a single message in the assistant's voice with
the transcript attached.

The rest of this document is the reference for that design (what is settled
and why), then what remains to build, then the evidence behind the decisions.
Sections marked **shipped** describe code that exists; everything under
"What remains" does not.

## Operational prerequisites

Voice needs Ledger reachable and granted, or the call button does not appear
at all (`GET /api/voice/capability` gates it):

- `LEDGER_PUBLIC_URL` + `LEDGER_PROXY_TOKEN` configured. The relay goes
  through `safeFetch`, which refuses loopback and private addresses, so a
  **local Ledger cannot be used in development** — point at the hosted service.
- The Ledger key needs, on its `gemini` scope: the
  `gemini-3.1-flash-live-preview` model, the `live-token` endpoint, **and a
  positive daily budget**. Production's key (`tk_98ffbd0b_95b4`) carries all
  three at $50/day.
- Each device slot reserves $5/day of that budget, and the reservation is held
  for the rest of the budget day. Repeated testing must reuse one device id,
  or a handful of runs exhausts the budget and every mint returns 402.

Setting that budget needed a Ledger change of its own: a service scope's daily
budget was settable only at token issuance, so a capability requiring one
could be granted to an existing token and refused forever. Ledger now has
`manage_token_services` action `set_budget` (UnlikeOtherAI/ledger#14).

## Why CallKit, not CoreTelephony

CoreTelephony is read-only carrier/radio information. **CallKit** is what makes
a VoIP session a first-class system call — lock-screen answer UI, the green
pill, Recents, and the CarPlay in-call screen all come from it. CarPlay needs
no separate entitlement for the case we need: an *active* CallKit call renders
on the CarPlay screen automatically, and Siri phrases registered through App
Intents work from CarPlay's Siri. (Giving the app its own CarPlay surface —
recents, favourites — is a different thing and does need a CarPlay calling
entitlement Apple grants selectively. We are not asking for that.)

Android's equivalent is a self-managed `ConnectionService`, which is *not* a
drop-in equal: it grants audio focus, Telecom integration and Android Auto
placement, but the app draws its own in-call UI.

## The reference implementation we are porting from

The Coder project (`/Volumes/External/Projects/Coder`,
`ios/TalkIOS.swiftpm`) has a working iOS implementation of this exact shape.
Phase 1 did **not** use its code — the browser client is new TypeScript — but
it is the source for the native phases, and the section below records what is
worth taking.

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

### Cost tracking — verified against Ledger main (2026-09-02) *(evidence)*

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

## The design, and which parts are built

Six decisions. **§1, §4 and §6 are shipped** — that code runs. §2, §3 and §5
are the design for the phases that remain, and nothing in them exists yet.


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

- **The voice and the manner are the agent's, not the deployment's**
  *(shipped 2026-09-02).* `Agent.voiceName` names one of the eight curated
  `GEMINI_LIVE_VOICES` (`packages/schemas/src/voice.ts`) and
  `Agent.speakingStyle` holds the person's own words for how it talks; both
  are set in the Agent Designer ("Voice and manner"). The session response
  resolves `resolveVoiceName(agent.voiceName)` — the agent's choice, else
  `NESSIE_VOICE_GEMINI_VOICE`, else `Charon` — and both fallbacks are
  validated against the same list, because Gemini rejects an unknown
  `voiceName` at `setup` and an operator typo would otherwise kill every call
  on the deployment. The list is hardcoded on purpose and there is exactly
  one copy: Google publishes no API that enumerates Live voices, so the
  picker reads the constant rather than an endpoint. The speaking style joins
  `setup.systemInstruction` through the *same* `buildSpeakingStyleBlock`
  the typed agent's system prompt uses (`@nessie/schemas`), so the two
  surfaces cannot describe the same choice differently — and it belongs at
  that tier because it is agent configuration written by someone entitled to
  edit the agent, never conversation content. **Caveat, deliberate:** a call
  today is always with the Personal Assistant, which is `systemManaged` and
  therefore not editable in the Agent Designer, so the PA's own call still
  falls back to the deployment voice with no style. The wiring is in place
  for the moment calling a designed agent ships; the speaking style already
  takes effect on every ordinary typed run.
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

### 3. The native layer needs a credential it deliberately never had *(shipped 2026-09-03)*

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

**What shipped.** `voice_device_credentials` holds one live credential per
device slot; only the token's SHA-256 digest is stored, and the row carries
the minting session's `sid` plus the user's token generation and workspace
scope. `verifyVoiceDeviceCredential` re-runs every check an ordinary session
runs on *each* request — generation, that exact sign-in, live membership, the
device slot — so signing out on the web, deactivating the member, or revoking
the device ends a call in progress rather than at token expiry. The scope is a
per-route `voiceCredential` flag read by the one global auth hook, because
Nessie has no generic route-scoping machinery: presenting the credential
anywhere else is `403 VOICE_CREDENTIAL_OUT_OF_SCOPE`, and a test asserts that
against a real route table with the generic message route as the negative
case. Minting is session-only; renewal is `POST /api/voice/device-token/refresh`,
which carries the original sign-in forward and revokes its predecessor under a
conditional update, so two racing refreshes cannot leave two live credentials.
The credential lives two hours against a 30-minute default call cap.

**The conversation bridge shipped 2026-09-03 too.** `POST
…/sessions/:id/pa-send` and `GET …/sessions/:id/replies` are the voice-scoped
equivalents of the generic message routes, marked `duringACall` and living in
`api/src/routes/voice-conversation.ts`. `pa-send` writes the message through
the same `createThreadMessage` the composer uses and then the same
`deliverCreatedMessage` — the post-commit work (orchestration, push, realtime,
alerts, memory) extracted out of `thread-message-create.ts` so both routes run
one copy of it. The poll reads through `listThreadMessages` with the caller as
viewer, in both lanes a run can answer in. The browser client was moved onto
the same two routes in the same change, so there is one code path rather than
two that can drift. Still to build for a native call: the Expo module itself.
Nothing calls the mint route yet — it is inert until the native client lands.

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
