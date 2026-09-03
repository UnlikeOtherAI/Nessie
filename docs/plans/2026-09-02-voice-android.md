# Android voice calling — Personal Assistant on the Gemini Live socket

Date: 2026-09-02. Parent spec: `docs/plans/2026-09-02-gemini-voice-calling.md`
(shipped; browser client in production). This document plans the Android build.

The browser already places Gemini Live voice calls to the Personal Assistant:
the API brokers a one-use ephemeral Google credential via Ledger, the client
opens `BidiGenerateContentConstrained` directly, and audio flows
device↔Google with `LEDGER_PROXY_TOKEN` never leaving the server. Nothing in
that architecture changes for Android. What changes is everything around the
socket: audio capture and playback, process survival, permissions, Telecom
integration, and how a native process reaches the assistant's run (the browser
uses the generic session-authed message routes; a native client must not).

This plan deliberately reuses the browser client's proven semantics — the
frame builders in `admin/src/facades/voice/gemini-live-protocol.ts` and the
lifecycle in `admin/src/facades/voice/voice-call-client.ts` are the reference
implementation, not a starting point for reinvention. Where this document
states a platform fact I could not verify from the repo, it says so.

---

## 1. Server dependencies that must land first

Two API gaps block a native client and are named here so they are scoped as
dependencies, not discovered mid-build:

**Voice-scoped device credential** — *shipped 2026-09-03, and Android
inherits it unchanged.* Storage is a dedicated `voice_device_credentials`
table rather than a column on the installation row (open question 1, now
answered): one live credential per device slot, holding only the token's
SHA-256 digest plus the minting session's `sid`, the user's token generation
and its workspace scope. The token is prefixed `nvc1_`, minted by the WebView
on ordinary session auth at `POST /api/voice/device-token`, and refreshed by
the device itself at `POST /api/voice/device-token/refresh` — a locked phone
has no foreground WebView to ask. Scope is a per-route `voiceCredential` flag
read by the one global auth hook: anywhere else in the API it is
`403 VOICE_CREDENTIAL_OUT_OF_SCOPE`. Revocation is stronger than this plan
asked for — `DELETE /api/voice/installations/:id` revokes it, and so does
signing out on the web, a forced sign-out, or deactivating the member, each
checked on *every* request rather than at token expiry. Keystore-backed
storage on the device is still this plan's job.

The reasoning that follows is kept because it is why the credential exists:
Every `/api/voice/*` route rode ordinary session auth, which in the browser
means an HttpOnly cookie. A native app cannot and should not hold that. The plan needs a device-scoped bearer
credential minted at installation registration (or first authenticated launch)
that authorizes *only* the voice routes for that installation: session start,
rotate, usage, transcript, end, pa-send, reply-poll. It must be revocable via
`DELETE /api/voice/installations/:id`, carry no wider scope, and be stored in
the Android Keystore-backed `EncryptedSharedPreferences` (or
`expo-secure-store`, which wraps it). Without this the app either ships the
user's session cookie into a WebView (fragile, and violates the
"no ambient authority" reading of the access rules) or cannot call the API at
all.

**Voice-scoped pa-send + reply-poll — shipped 2026-09-03.** `POST
/api/voice/sessions/:id/pa-send` and `GET /api/voice/sessions/:id/replies` live
in `api/src/routes/voice-conversation.ts`, marked `duringACall`. The session id
is the capability: the route re-derives the thread from the stored session row
and never takes one from the client, then reads it through the same visibility
check the composer's route uses, so a person who lost access mid-call cannot
still post. The write goes through `createThreadMessage` and then
`deliverCreatedMessage` — the same shared post-commit step the composer's route
runs — so the run is indistinguishable from a typed one. The browser client was
moved onto both routes in the same change, so Android inherits a path that is
already exercised rather than a second one written blind, including its polling
cadence.

Both are ordinary API work with existing schema contracts and are verified in
CI (route tests against the seeded Postgres, following the established
`api/test` patterns). No device needed.

---

## 2. Independently landable steps, with how each is verified

Each step lands on `main` behind the existing capability gate — Android
clients simply see nothing until the mobile app ships, because
`GET /api/voice/capability` is deployment-level, not platform-level.

~~**Step 1 — Voice-scoped device credential + scoped routes (server only).**~~
**Done (2026-09-03).** Installation registration returns a device token, and
pa-send and reply-poll ship with it. Covered by `voice-device-credential.test.ts`
(minting, revocation, and the scope refusal against a real route table) and
`voice-conversation-routes.test.ts` (the hand-off's message, the run and push it
enqueues, its budget and idempotency, and the reply poll in both lanes).

**Step 2 — Shared JS voice core extraction.** The protocol payloads, usage
normalisation, transcript collection, and outbox logic move from
`admin/src/facades/voice/` into a shared package (see §3 for why JS, not
Kotlin). The admin re-imports them; behaviour is unchanged. *Verification: CI
only* — the existing admin voice tests must pass unmodified against the
moved code, which is the strongest possible proof the extraction was
behaviour-preserving. No new tests are needed to *move* code; the tests that
already pin the payloads move with it.

**Step 3 — Expo local module: native audio + socket engine skeleton.**
`mobile/modules/nessie-voice/` (§4) with Kotlin `AudioRecord` capture,
`AudioTrack` playback, an OkHttp WebSocket, and the foreground service shell —
but driven by a *loopback* test mode: a module-internal fake that echoes
frames, so capture→encode→decode→playback is exercised with no server and no
credential. *Verification: emulator (b).* Emulator audio is good enough to
prove the pipeline moves bytes; it is not good enough to judge VAD behaviour
or echo. Playwright does not apply here (no admin UI), so the visual check is
a screen recording of the dev-client debug UI showing live state transitions.

**Step 4 — Real call path, foreground only.** The JS core from step 2 wires
into the native engine via the module's event bridge; a debug screen in the
dev client places a real call while the app is foregrounded. Rotation, mute-
as-silence, interruption flush, transcript, usage outbox — all the browser
semantics, replayed natively. *Verification: physical device with a real
Gemini credential (c).* This is the first step that cannot be faked: one-use
credentials, resumption handles, and Gemini's VAD all behave differently than
any stub, and echo cancellation on real hardware is where
`AudioRecord` source selection (`VOICE_COMMUNICATION` vs `MIC`) is decided.
The emulator step before it exists precisely to keep this step's debugging
surface small.

**Step 5 — Survival: foreground service, audio focus, Telecom.**
`ConnectionService` self-managed registration, audio-focus handling for
incoming GSM calls, Bluetooth/car route changes, and the backgrounded-rotation
path (§6). *Verification: physical device (c)*, and this time explicitly
including the hostile cases: place a real phone call to the device mid-call,
walk out of Bluetooth range and back, lock the screen across a rotation
boundary. Doze behaviour can be partially exercised with
`adb shell dumpsys deviceidle force-idle`, which works on an emulator too,
but the audio-focus and Telecom cases need hardware because the emulator's
telephony is simulated.

**Step 6 — In-call UI + contacts/assistant surface.** The app-drawn call
screen (self-managed ConnectionService gives no system UI — budgeted here),
the notification with mute/end actions, contact sync (§7), and the assistant
entry points that are actually available. *Verification: physical device (c)*
for the assistant paths, emulator for the pure UI states.

Steps 1–2 are CI-landable alone and unblock parallel work; steps 3–4 and 5–6
are each one PR. Nothing ships half-reachable: the app surfaces the call
button only when capability says available *and* a device credential exists,
so a partial rollout shows no dead control.

---

## 3. Shared vs Android: what is shared, and how

**Shared (JS, not Kotlin):** everything that is pure bytes-and-state —
`buildSetupPayload`/`buildSeedPayload`/`buildAudioPayload`/`buildTextPayload`/
`buildToolResponsePayload` and `parseServerFrame`, the transcript collector
(interleaved live-text assembly and turn-boundary finalisation), usage
normalisation (Google's `usageMetadata` → Ledger's snapshot shape), the usage
and transcript outboxes (persist + replay-on-launch), and the rotation policy
(rotate at `expiresAt − 60s`, reconnect on `goAway`, resume via
`sessionResumptionHandle` rather than re-seeding — re-seeding re-bills the
context every turn). The call controller itself — the state machine that is
`createVoiceCall` — is also shared, parameterised on a socket interface, an
audio interface, and a clock.

**The choice: keep it in JS, one implementation, both platforms.** The
alternatives were a Kotlin port or duplication-with-tests, and both lose. A
Kotlin port doubles the maintenance surface of a wire protocol that is still
moving (the browser client has already been through "a frame carries several
events at once; an earlier draft silently dropped usage on every audio
frame"), and every future protocol change would need two careful edits and a
cross-language divergence audit. Duplication-with-tests has the same property
with extra steps. JS sharing has a real cost — the socket and audio callbacks
cross the JS↔native bridge, and 50 ms audio frames at 16 kHz is ~20 bridge
crossings/second each way — but React Native's bridge (JSI in the new
architecture, which SDK 55 dev-client uses) handles that rate comfortably;
audio *bytes* do not cross per frame in the chosen design (§4 puts the socket
and the audio device both on the Kotlin side, bridged only by events and
control). The justification is the same one Rule zero's TabBar story encodes:
the second implementation of the same view is the defect, whatever language
it is written in. The protocol payloads have exactly one correct shape; there
should be exactly one file that builds them.

**Genuinely Android (Kotlin, no sharing possible):** `AudioRecord` capture at
16 kHz mono PCM16 with source selection and AEC/NS where the hardware offers
it; `AudioTrack` playback at 24 kHz with the flush-on-interrupt semantics the
browser's `playback.flush()` encodes; the foreground service with the
`microphone` + `phoneCall` types; `ConnectionService` and the `Connection`
lifecycle; `AudioManager` focus and route callbacks; the notification; and
the OkHttp WebSocket (needed because a JS-side `WebSocket` in RN would put
every audio frame across the bridge — this is the one place the socket moves
native, and the JS core is indifferent because its socket interface is just
`send(json)` / `onMessage(json)`).

The split lands as: Kotlin owns *realtime* (mic→socket, socket→speaker, under
a foreground service, immune to JS thread stalls), JS owns *policy* (what to
send, when to rotate, what the transcript says, what to persist). That is
also the failure-containment line: a JS reload (Metro refresh, OTA) can lose
policy state but the call survives on the Kotlin side, which is what the
rehydration call in §4 exists to repair.

---

## 4. Expo local module shape

`mobile/modules/nessie-voice/`, an Expo local module (the `expo-module`
local-autolinking layout, consumed by the dev client and EAS builds; no
separate Gradle publishing):

```
mobile/modules/nessie-voice/
  expo-module.config.json
  package.json
  index.ts                        # JS API surface (below)
  app.plugin.js                   # config plugin entry
  android/
    build.gradle
    src/main/java/works/nessie/voice/
      NessieVoiceModule.kt        # ExpoModule definition; bridges to engine
      VoiceCallEngine.kt          # owns socket, audio, service binding; one live call
      VoiceCapture.kt             # AudioRecord: 16 kHz mono PCM16, frames out
      VoicePlayback.kt            # AudioTrack: 24 kHz, enqueue/flush
      VoiceSocket.kt              # OkHttp WebSocket, JSON text frames
      VoiceCallService.kt         # foreground service; microphone+phoneCall types
      VoiceConnectionService.kt   # self-managed ConnectionService
      VoiceNotification.kt        # ongoing call notification + actions
  plugin/
    src/index.ts                  # withAndroidManifest edits (below)
```

The JS API is deliberately small and event-shaped, because the call must be
rehydratable (below):

```ts
// index.ts
type NativeVoiceCallState = VoiceCallState // same type the shared core publishes

startCall(): Promise<void>            // JS core drives; engine takes over realtime
endCall(): Promise<{ lines: VoiceTranscriptLine[]; durationMs: number }>
setMuted(muted: boolean): void
sendFrame(json: string): void         // JS core → socket (setup, seed, tool responses)
onSocketMessage(cb: (json: string) => void): Subscription
onEngineEvent(cb: (e: EngineEvent) => void): Subscription  // socket closed, focus lost, route changed
// Rehydration: after a JS reload, re-attach to a call the engine still holds.
// Returns null if no call is live; otherwise the engine's current credential
// id, resumption handle, mute state, startedAt, and buffered state so the JS
// core rebuilds its controller without touching the socket.
rehydrate(): Promise<RehydratedCall | null>
```

`rehydrate` is not optional. A dev-client reload or an OTA update kills the
JS runtime while the foreground service and its socket keep running; without
re-attachment, the transcript collector, rotation timer, and usage sequence
vanish mid-call and the user is left with audio but no record and no
rotation — the call dies at the 30-minute credential boundary and the usage
relay is orphaned. The engine is the single owner of realtime truth for
exactly this reason: JS can come and go.

The config plugin writes into `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_PHONE_CALL"/>
<uses-permission android:name="android.permission.MANAGE_OWN_CALLS"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT"/>
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
<uses-permission android:name="android.permission.WAKE_LOCK"/>
<uses-permission android:name="android.permission.INTERNET"/>
<service android:name=".VoiceCallService"
         android:foregroundServiceType="microphone|phoneCall"
         android:exported="false"/>
<service android:name=".VoiceConnectionService"
         android:permission="android.permission.BIND_CONNECTION_SERVICE"
         android:exported="true">
  <intent-filter>
    <action android:name="android.telecom.ConnectionService"/>
  </intent-filter>
</service>
```

`MANAGE_OWN_CALLS` is the self-managed `ConnectionService` gate and is
normal (not runtime). `READ_CONTACTS`/`WRITE_CONTACTS` and the sync-adapter
service are added by the contacts step (§7), not up front — the manifest
should not carry a permission the build does not yet use, because Play
Console declarations must match reality.

---

## 5. Permissions, foreground-service types, Play declarations, and where each is asked

Runtime permissions and when the UX asks for them:

| Permission | FGS type | When requested |
|---|---|---|
| `RECORD_AUDIO` | `microphone` | At the first tap of the call button, before `POST /api/voice/sessions` — this *is* the browser client's "prove the microphone before minting" rule in native form. Never at launch. |
| `POST_NOTIFICATIONS` (API 33+) | — | Immediately after the first successful call, framed as "so you can control the call from the lock screen"; the ongoing call notification is also what keeps the FGS honest. Degraded path: the call still works foreground-only if refused, so this is a nudge, not a gate. |
| `BLUETOOTH_CONNECT` (API 31+) | — | First time a BT device is present at call start, or from settings; without it, route *announcement* still works via legacy intents but SCO control is limited. Degraded, never blocking. |
| `READ_CONTACTS` / `WRITE_CONTACTS` | — | Only when the user enables "show Nessie contacts in my phone app" (§7). Never bundled with the call flow — a mic permission asked at a call button is self-explanatory; a contacts permission there is not. |

`MANAGE_OWN_CALLS`, `FOREGROUND_SERVICE*`, `WAKE_LOCK`, `MODIFY_AUDIO_SETTINGS`
are install-time; no UX moment.

Play Console declarations (this is where Android voice apps die in review, so
it is planned, not discovered): the `microphone` foreground service type
requires a Play Console declaration with a demo video showing the
user-initiated call flow; `phoneCall` FGS type is declared alongside it; and
if the `android.intent.action.DIAL`/default-dialer path were ever taken there
would be a further declaration — this plan deliberately does *not* seek
default-phone-app status, because Nessie is not a dialer and the review bar
for that role is "the app is a phone". The honest category is a self-managed
calling app using `MANAGE_OWN_CALLS`, which has no role requirement. I am
flagging as uncertain: whether the current Play policy treats
`FOREGROUND_SERVICE_PHONE_CALL` for a VoIP-only app as needing any additional
justification beyond the FGS declaration form — the policy text has moved
several times and must be re-read at submission time, not assumed from this
document.

While-in-use vs background mic: the app requests the mic while-in-use only
(the manifest never declares `android:backgroundLocation`-style escalation;
background mic comes from the foreground service type, which is the
sanctioned path). Starting the FGS *before* the mic grant or from a pure
background state throws `ForegroundServiceStartNotAllowedException` on modern
API levels, which is why the call flow is always user-initiated from a
foregrounded UI — see the fallback in §6.

---

## 6. Lifecycle: the four survival cases

**A real phone call arrives (audio focus loss).** The engine requests audio
focus with `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` semantics at call start and
listens for `AUDIOFOCUS_LOSS*` (plus the Telecom `onCallStateChanged` path
when self-managed — self-managed connections are expected to manage their own
focus, so both signals are wired). On transient loss: auto-mute (which means
*sending silence*, not stopping the stream — Gemini's VAD must never stop
seeing frames or it never ends the turn), pause playback, and surface "call
held" in the notification. On permanent loss: end the call through the normal
path so the usage-complete report and transcript still ship. The one thing
that must not happen is the mic staying live into a GSM call — that is both a
privacy defect and, on many devices, a hardware routing fight the app loses
anyway.

**Bluetooth / car route changes.** `AudioDeviceCallback` (API 23+) on the
playback and record devices, plus SCO state intents for legacy headsets.
Route loss mid-call re-routes to earpiece/speaker without touching the
socket; the frame format is route-independent so nothing about the protocol
changes. The failure mode being defended against is the classic one: car
disconnect yanks the mic, `AudioRecord` starts returning zeros or errors, and
if the engine treats that as fatal the call dies every time someone parks.
Instead the engine re-opens the record stream on the new route and continues;
if re-open fails after a bounded retry, the call fails loudly through the
normal end path (record + usage complete), never silently.

**Doze / background limits.** The foreground service with `microphone` type
is the whole answer while a call is live: it holds the process out of Doze's
app-standby bucket and keeps the mic grant valid. The `WAKE_LOCK` is held by
the engine for the socket's sake (Doze defers network for non-foreground
apps; an FGS process is exempt, but the partial wake lock guards the
screen-off-CPU-off case, which FGS does not by itself guarantee — I am
reasonably but not fully certain this is still required on current API levels
for an FGS doing continuous network I/O; the load test in step 5 must settle
it empirically by locking the screen for 35 minutes).

**Credential rotation while backgrounded and locked.** This is the hard one
and it gets its own paragraph. Rotation is `POST /api/voice/sessions/:id/rotate`
then re-open the socket with the resumption handle. Backgrounded and locked,
the JS timer that schedules rotation (`ROTATE_LEAD_MS` before expiry) may not
fire reliably — RN timers are JS-thread, and a locked device with the app
backgrounded is exactly where JS execution gets suspended. **The rotation
schedule therefore moves into the engine**: Kotlin owns the `expiresAt − 60s`
alarm (a `Handler` on the service thread is sufficient inside an FGS; no
`AlarmManager` needed while the service lives), calls the rotate endpoint
directly with the device credential, and emits an event so JS — if alive —
updates its copy of the credential. The shared JS core still owns the
*policy* (lead time, retry-once-then-fail), but the *trigger* is native.
**Explicit fallback:** if backgrounded rotation proves unreliable in device
testing (OEM task killers — Xiaomi/Oppo aggressive FGS management is the
known offender, and I am flagging this as a real risk rather than asserting a
solution), the fallback is: at 60 seconds before expiry with no successful
rotation, the engine posts a high-priority notification ("Tap to continue
your call") whose tap brings the app to the foreground, where rotation is
unrestricted; if the credential lapses first, the call ends through the
normal path so the transcript and usage are preserved, and the UI offers
one-tap redial (new session, re-seeded — expensive, but correct, and it only
happens past the 30-minute mark in the worst case). This fallback is designed
now so it is a config flag, not an emergency rewrite.

---

## 7. Contacts + "Hey Google, call Ada"

**Contacts.** The achievable, sanctioned design is a custom account with a
`SyncAdapter` pushing Nessie people (the PA and any voice-callable agents)
into the Contacts Provider as raw contacts under the Nessie account type,
each carrying a `vnd.android.cursor.item` custom MIME row that deep-links
into the app's call screen. This is how WhatsApp/Signal contacts appear in
the phone app with a "voice call" row, and it is fully supported — but
requires `READ_CONTACTS`/`WRITE_CONTACTS`/`GET_ACCOUNTS` on older APIs, the
sync-adapter service in the manifest, and an authenticator stub
(`AbstractAccountAuthenticator`). The alternative, asking users to save
contacts manually, is a non-starter; the sync adapter is the only real path
and is scoped to the people/agents the user's entitlement already exposes
(the roster source parameterised exactly as the members surface does — no new
scoping rule, the contacts sync is a *view* of the same entitlement). What
must be verified on-device: custom-account contact rows render a callable
action in the stock dialer only if the MIME-type row is registered with the
right `ContactsContract.Data` columns; I am confident in the mechanism, less
certain about per-OEM dialer rendering, so step 6 includes a device matrix
check (Pixel stock, Samsung, one Xiaomi).

**Assistant / "Hey Google, call Ada".** `actions.intent.CREATE_CALL` via App
Actions is treated as unavailable for third parties — the settled constraint —
so nothing is built on it. What *is* achievable: (a) the contacts row above,
which makes "call Ada" resolvable from the dialer and from Assistant's
contact-calling path *if* Assistant honours third-party contact actions —
this is uncertain and OEM/Assistant-version dependent, stated as such; (b)
app shortcuts (`ShortcutManager` dynamic shortcuts, "Call Ada") which surface
in launcher long-press and are picked up by Assistant's shortcut invocation on
some versions — cheap to ship, do it; (c) a `VIEW` intent-filter on a
`nessie://call/<agentId>` deep link so any surface that can open a URL
(including Assistant routines that open apps/URLs, and QR/NFC) can start a
call. The honest plan position: "Hey Google, call Ada on Nessie" working
end-to-end is a *goal tested on device*, not a deliverable this plan
guarantees, because the only documented third-party path (App Actions) is
dead and everything else is emergent behaviour of the contacts/shortcuts
surface. If device testing shows Assistant resolving the synced contact row
reliably on Pixels, that becomes the documented path; if not, the feature
statement narrows to "Nessie contacts in your phone app" plus shortcuts, and
the plan does not pretend otherwise.

---

## 8. Open questions I cannot resolve from the repo

1. ~~**Device credential shape.**~~ **Answered (2026-09-03):** its own
   `voice_device_credentials` table, not a column on the installation row —
   the credential has its own lifecycle (rotation, per-session binding,
   independent revocation) that an installation column could not carry. The
   contract this plan specified — scoped, revocable, Keystore-held — is met,
   and the scope is enforced in one auth hook against a per-route flag. See
   §1.
2. ~~**pa-send authorization granularity.**~~ **Settled 2026-09-03:** both.
   The session row is re-read for ownership and liveness, and the thread it
   names is then resolved through the same visibility check the composer's
   route uses — so a membership lost mid-call ends the write, not just the
   next sign-in.
3. **Play Console FGS declarations.** The exact current declaration form and
   whether `phoneCall` FGS type needs extra justification for VoIP-only —
   policy must be re-read at submission (§5).
4. **OEM background survival.** Whether the engine-owned rotation survives
   Xiaomi/Oppo FGS killing without the notification fallback (§6). Only a
   device matrix settles this.
5. **Assistant contact-action resolution** (§7): emergent behaviour, settled
   only by on-device testing.
6. **iOS parity.** *In flight as of 2026-09-03* — the CallKit module is being
   built against the same routes, so the shared-JS extraction (step 2) should
   be reconciled with whatever seam that lands rather than designed twice. The
   point stands that CallKit + `AVAudioSession` have their own survival matrix;
   the iOS lifecycle work belongs in the main voice-calling plan's phase 1b,
   not bolted onto this one.
7. **Emulator Gemini reachability.** Whether the emulator's network path to
   `generativelanguage.googleapis.com` and its simulated mic are faithful
   enough for step 4 debugging or whether step 4 collapses into device-only.
   Assumed emulator-good-enough-for-bytes, device-required-for-VAD; if the
   emulator proves useless, step 3's loopback mode still earns its keep for
   the audio pipeline.

---

## 9. Review (2026-09-03)

Read against the shipped server surface and the working browser client.
The plan holds. Three of its calls are load-bearing and right:

- **Rotation must be triggered natively, not from JS.** React Native timers
  run on the JS thread and a locked, backgrounded device is exactly where JS
  execution is suspended — so a JS-scheduled rotation is a call that dies at
  the 30-minute mark on the one platform state that matters most. Moving the
  trigger into the engine while the shared JS core keeps the *policy* is the
  correct split. iOS has the same problem for the same reason, and the two
  should reach it the same way.
- **Auto-mute means sending silence, not stopping the stream.** This matches
  the browser client, and it is not a stylistic choice: Gemini's VAD ends a
  turn by hearing silence, so a gap in frames leaves a turn open and billing.
- **A route change must not be treated as fatal.** Re-opening the record
  stream on the new route, with a bounded retry and a loud failure rather than
  a silent one, is right. "The call dies every time someone parks" is the real
  failure this prevents.

Two things to correct when the work starts:

- §1's first dependency is **already built** — see the amendment there. Android
  inherits the credential rather than designing one, and its remaining job is
  Keystore-backed storage plus the native refresh trigger above.
- The plan's uncertainty about `WAKE_LOCK` under a foreground service is
  honest and should stay uncertain until the 35-minute locked-screen test in
  step 5 settles it. Do not resolve it from documentation.

Sequencing: this sits after the iOS module lands, because `AgentCallSession`
was written against the call *lifecycle* rather than against CallKit, and the
shared seam is worth inheriting rather than inventing twice.
