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

## What remains

Phase 0 (Ledger grants) and phase 1 (server contract + browser call) are
**done**. Everything below phase 1 is not started. The phases are listed in
full, including the finished ones, because each records the constraints its
successor inherits.


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

**Phase 1b — the iPhone call (CallKit)** *(built 2026-09-03; see
"What shipped in 1b" and "What 1b's verification did and did not cover" below)*
The server dependency this phase used to carry is **done** (2026-09-03): the
voice-scoped `pa-send` and reply-poll routes named in §3 exist, the
authorization matrix lists them, and the browser client uses them too, so the
native layer inherits a path that is already exercised rather than a second one
written blind.
Mobile: local Expo module with the ported `GeminiLiveClient` +
`AgentCallCoordinator` + `AgentCallSession` seam; credential source swapped
to the Nessie routes; the same header call button in the mobile WebView
hands off to native via the shell bridge so the call becomes a CallKit
call. Verify on a physical iPhone: place call, lock screen, AirPods, mute
from lock screen, end from lock screen.

### What shipped in 1b

The module is `mobile/modules/nessie-voice-call/` — a local Expo module
(`expo-module.config.json`, autolinked through CocoaPods), Swift, iOS only.
Android declares no platform and `requireOptionalNativeModule` answers `null`,
so the header button asks and gets a clean "unavailable" rather than throwing.

| Piece | File |
| --- | --- |
| The lifecycle seam | `ios/AgentCallSession.swift` |
| CallKit provider + call controller | `ios/AgentCallCoordinator.swift` |
| Gemini Live protocol client | `ios/GeminiLiveClient.swift` + `+Connection` / `+Protocol` / `+Audio` |
| The concrete session (credential, socket, transcript) | `ios/VoiceCallSession.swift` + `+Tools` |
| Nessie voice routes, and the credential's own refresh | `ios/NessieVoiceApi.swift` |
| Per-turn usage relay | `ios/VoiceUsageRelay.swift` |
| Process-owned call + JS boundary | `ios/VoiceCallController.swift`, `ios/NessieVoiceCallModule.swift` |
| Shell bridge | `mobile/src/lib/native-voice-call.ts` |
| The hand-off, and the one call object | `admin/src/facades/voice/native-voice-call.ts`, `facades/voice/hooks.ts` (`usePersonalAssistantCall`) |

Four decisions the browser client never had to make:

- **A cellular call arriving mid-call puts the agent call on hold, and hold is
  not mute.** `CXSetHeldCallAction` (which Coder's coordinator does not
  implement) pauses input *entirely*; `didDeactivate` arriving without an end
  action holds too, because iOS can take the audio session without a hold
  action following. Muting deliberately keeps a silent stream flowing so
  Gemini's VAD can still see the end of an utterance — doing that while held
  would stream silence into a turn that is billed and answered into an output
  nobody can hear. The person hears the agent call go quiet and finds it live
  again when the phone call ends; nothing is spoken into the gap.
- **Route changes rebuild the audio pipeline, not just the route.** The
  platform picks the route; `AVAudioEngine` does not follow it. Its input node
  reports a new hardware format, so the installed tap and the sample-rate
  converter are both stale and the playback graph's connections are broken —
  which is exactly how audio dies mid-call with no error anywhere. Coder builds
  its converter once at init, from a format the session has not chosen yet; here
  it is built inside `startCapture()` and rebuilt on both
  `AVAudioSession.routeChangeNotification` and
  `.AVAudioEngineConfigurationChange`, with `playbackEngine.connect` re-run on
  every start rather than only the first.
- **Credential rotation is implemented, and on a default deployment it never
  runs.** `NESSIE_VOICE_MAX_DURATION_MS` defaults to 30 minutes — the same
  lifetime as Google's credential — so `VoiceCallSession` ends the call at that
  ceiling before the rotation timer (expiry minus one minute) fires. Rotation
  exists for a deployment that raises the cap, and **it has not been observed
  working from a locked, backgrounded phone.** That is the honest state: the
  code path is the browser's, proven there, and the locked-phone execution
  window is not something a 30-minute cap ever exercises. Until somebody runs a
  35-minute locked call on cellular, a locked-phone call is capped under 30
  minutes and the product says so.
- **The call belongs to the process, not to the JS bundle.**
  `VoiceCallController.shared` owns the coordinator and session, and mirrors
  every change into a lock-guarded snapshot. `getActiveCallState()` reads that
  snapshot without hopping to the main actor, because the shell asks it during
  its first render — the queue it would otherwise wait on is the one painting.
  A JS reload therefore remounts into a call that is still running, with its
  timer and its End button intact.

Two smaller things worth recording. The native socket uses `?access_token=`
rather than Coder's `Authorization: Token` header: native could use either, and
one form across both clients is one contract to keep true. And the device
credential lives **in memory for the length of one call** — the WebView mints a
fresh one every time, so a Keychain copy would be a credential nothing ever
reads. Phase 3, where the assistant places the call and there is no WebView to
mint from, is where a durable one starts to matter; that is also where the
`AfterFirstUnlock` accessibility class becomes the deciding detail, because a
locked-phone call has to *rewrite* it and the stricter `WhenUnlocked` class
fails that write with `errSecInteractionNotAllowed`.

### What 1b's verification did and did not cover

**Built and installed, on the named hardware.** A Release build for
`iPhone17,2` compiles clean (SwiftLint strict, zero violations), the module's
classes are in the shipped binary and registered in Expo's generated
`ExpoModulesProvider.swift`, the installed `Info.plist` carries
`UIBackgroundModes: [audio]`, and that exact artifact was installed with
`xcrun devicectl`, launched, and confirmed still running. A simulator build was
installed and screenshotted as well. `@nessie/mobile` and `@nessie/admin` pass
`tsc`, `eslint --max-warnings 0`, and their suites; the bridge tests were shown
to fail with the handler branch removed.

**No call was placed.** Every acceptance criterion below the audio layer is
therefore *unverified against the live service* — a real incoming call, a route
change on real hardware, credential rotation on cellular, the transcript and
the usage relay, `pa_send`, and rehydration after a JS reload. Reaching them
needs a signed-in session on the phone and Ledger's Gemini grants, which the
build alone cannot supply. Nothing in "What shipped in 1b" should be read as
"seen working"; it describes code that compiles, ships, and runs as a process.

**Known gaps in 1b, stated plainly.** The transcript is submitted at hang-up
inside a `beginBackgroundTask`, which buys seconds, not certainty: the browser
client's persistent outbox has no native counterpart yet, so an app killed
between hang-up and delivery loses that call's record. `pa_send` reaches the
voice-scoped `pa-send` and `replies` routes, which now exist and which the
browser client uses too — but no hand-off has been made from the phone, so the
native half of that path is written against a contract rather than against an
answer it has seen.

**Phase 1c — the Android call (Telecom)**
The same local Expo module, second platform. Android's equivalent of CallKit
is a **self-managed `ConnectionService`**: register a `PhoneAccount` with
`CAPABILITY_SELF_MANAGED` and the system gives the call audio focus, Telecom
integration, Bluetooth/car routing and Android Auto placement. It does **not**
give a system in-call screen — self-managed exists precisely so an app draws
its own, which is the opposite of CallKit and is real UI work to budget: a
notification, a full-screen intent, and an in-app call screen. The `AgentCallSession` seam
(connect must not start I/O; audio starts when the platform says the call is
active) ports unchanged, because it was written against the *lifecycle*, not
against CallKit. The Gemini protocol client, the credential relay, rotation,
the usage outbox and the transcript submission are all shared — only the
audio plumbing (`AudioRecord`/`AudioTrack` at 16 kHz in, 24 kHz out) and the
call framework differ. Permissions are more than the obvious three: `RECORD_AUDIO`,
`MODIFY_AUDIO_SETTINGS`, `MANAGE_OWN_CALLS`, `POST_NOTIFICATIONS`,
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, and — for phase 3's
incoming calls — `USE_FULL_SCREEN_INTENT` plus
`FOREGROUND_SERVICE_PHONE_CALL`, which carries a Play Console declaration.

**What a native call has to survive (acceptance criteria for 1b and 1c)**
None of this is optional polish; each is a routine event that silently kills
a call if unhandled, and none of it is exercised by the browser client:

- **A real phone call arriving mid-call.** On iOS CallKit holds or ends the
  agent call; on Android it is `AUDIOFOCUS_LOSS_TRANSIENT`. Decide and state
  what the person hears in each case — the Gemini side needs to pause input
  rather than stream silence into a turn that will be billed.
- **Route changes.** AirPods removed, handoff to a car, speaker toggle. The
  platform picks the route, but the audio *engine* must reconfigure or audio
  dies silently mid-call (`AVAudioSession.routeChangeNotification`,
  `AudioDeviceCallback`). Verify against a real headset, not the simulator.
- **Credential rotation while backgrounded and locked.** This is the
  sharpest one. Gemini's credential lives 30 minutes and rotation goes
  through the Nessie API, so a 35-minute locked-screen call needs an HTTPS
  round trip plus a socket re-open from the background. CallKit keeps the
  *audio* session alive; that is not the same as arbitrary networking on a
  timer. Either prove rotation works inside the call's execution window on a
  real device on cellular (NAT rebinding is worst there), or cap a
  locked-phone call under 30 minutes and say so in the product.
- **Rehydration after a JS reload.** The call is native and survives, but the
  JS event stream does not — so the module needs a `getActiveCallState()` the
  shell asks on mount, or a reload leaves the UI blind while a call runs.

**Store review is a design input, not a final step.** CallKit, a calling
intent, and writing contacts are three of the more heavily policed surfaces
on both stores; Google additionally requires a Play Console declaration for
contacts permissions and for a phone-call foreground service. Plan the
usage-description copy, the demo path a reviewer can follow, and the contacts
removal flow up front — and keep App Shortcuts as the fallback if the calling
domain is refused, since it needs none of this.

**Phase 2 — "call my assistant" on both platforms, in-car, polish**

Two mechanisms, because they answer different sentences and only one of them
gives the phrasing Ondrej actually asked for.

*App Shortcuts (cheap, ships with the native app).* Coder's
`StartPersonalAssistantCallIntent` + `AppShortcutsProvider` ports directly.
**Apple requires an App Shortcut phrase to contain the app name**, so this
buys "Call my assistant with Nessie" — not a bare "call my personal
assistant". It works from the lock screen, the Shortcuts app, and CarPlay's
Siri with no setup after install.

The Android side of this is **unresolved and must be checked against live
docs before the phase starts**. App Actions (`shortcuts.xml` + a
`actions.intent.CREATE_CALL` built-in intent) was the equivalent mechanism,
but Google has been winding App Actions down in favour of Gemini extensions,
and `CREATE_CALL` has historically resolved to the *Phone* app rather than a
third party. Treat "Hey Google, call my assistant on Nessie" as unproven; the
contacts path below is the one that does not depend on it.

*Calling domain + Contacts (the real thing, both platforms).* To say "Hey
Siri, call Ada" with no app name, the agent has to look like a person you
can call — which is exactly how WhatsApp and Skype work, and it is a
supported path rather than a trick:

- The app adopts a **calling intent**, and which API is an open decision
  that has to be made before the phase starts, because it changes the build:
  SiriKit's `INStartCallIntent` needs a separate **Intents app-extension
  target** (its own bundle id, entitlements and provisioning), which an Expo
  config plugin cannot create — it needs `expo-apple-targets`-style Xcode
  surgery and EAS multi-target credentials. App Intents with
  `AssistantSchemas` (iOS 18+) needs no extension target and is where Apple
  is steering new work, at the cost of dropping older iOS. Either way CallKit
  is a prerequisite, so this sits strictly after phase 1b.
- Nessie writes the caller's agents into a **dedicated `CNContactGroup`**
  ("Nessie Agents") through `CNContactStore`, one contact per agent carrying
  an app-specific handle, behind an explicit opt-in on the mobile settings
  screen and the system Contacts permission. The group is the unit of
  cleanup: revoking the toggle deletes the group and nothing else the person
  owns.
- The set is **synced, not seeded once** — agents are created, renamed and
  deleted in Nessie, so a stale "Ada" that no longer exists must disappear.
  Reconciliation runs on app foreground against the same `agent_list`
  entitlement the Agents screen uses, so a person never gets a contact for
  an agent they cannot reach.
- Each completed call **donates an `INStartCallIntent` interaction**, which
  teaches Siri the association over time. Be honest about the ceiling: this
  is best-effort resolution, not a guarantee. Even for WhatsApp, Siri
  routinely asks "call Ada with Phone or Nessie?" until the person has placed
  a few calls through the app, so the acceptance criterion is "reachable
  without naming the app, disambiguation prompt allowed", not "always
  resolves silently".
- The PA gets the additional plain alias people will reach for ("Personal
  Assistant"), so "call my personal assistant" resolves without naming
  Nessie.
- **Android does the same thing with its own primitives**, and slightly more
  cleanly: a sync adapter owning a custom `ACCOUNT_TYPE` writes agents into
  `ContactsContract` under an account the app owns outright, and a custom
  `Data` MIME type puts a "Call with Nessie" row on each contact — the
  mechanism behind WhatsApp's and Signal's contact rows. Because the
  contacts live under the app's own account, removal is deleting that
  account rather than editing the person's address book, so the cleanup
  story is stronger than on iOS. `RECORD_AUDIO` aside, this needs
  `READ_CONTACTS`/`WRITE_CONTACTS` and is opt-in on the same settings
  screen.

Privacy note worth stating up front: this writes rows into the person's
address book. It is opt-in, scoped to one group, removable in one action,
and never touches existing contacts.

Also in phase 2: verify initiation and the in-call surface in **CarPlay and
Android Auto** (a real head unit or each simulator), the call-record message
posted into the PA DM, and reconnect polish (Coder's resumption + rotation
paths exercised under airplane-mode blips).

**Phase 3 — the PA calls you**
The assistant places the call. On iOS that is VoIP PushKit +
`reportNewIncomingCall`, and the hard constraint is that iOS requires a call
to be reported for *every* VoIP push — so the worker must never send a
speculative ring. Android has no PushKit: an FCM high-priority data message
wakes the app, which calls `ConnectionService.addNewIncomingCall`, and the
equivalent constraint is the foreground-service and background-start policy
rather than a per-push obligation. Both are driven by one
`voice_call_start`-shaped PA builtin following the route-mirroring pattern
(`meeting_link_create` / `call_start` precedent), so "call me when the
deploy finishes" works. Each of these is its own spec when we get there.

## The call record — one folded message, full transcript inside *(shipped)*

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
  and the call card opens the transcript from the attachment.
  **The transcript is stored before the record exists** *(fixed
  2026-09-03)*, and linked to the message inside the same transaction that
  claims the session's set-once slot. Written the other way round, a
  storage failure left a committed record holding that claim: the retry was
  refused as already-recorded, the transcript was gone permanently, and the
  surviving record looked exactly like a call that never had one — no
  control, no error, nothing to retry. Storing first inverts which way a
  failure falls, so nothing commits and the same submission simply works
  when it is sent again. The loser of a claim race has bytes on disk by
  then, and frees them through `FileService.delete` — the one path that
  also writes the balancing usage event, so a refused submission cannot
  inflate anybody's storage.
  Full-transcript search is honestly out of scope for phase 2 (message
  search covers the summary; an entitlement-aware transcript index is its
  own later feature — and search already excludes basis-carrying messages
  by design).
- **Two artefacts, and the message content is a compaction *(shipped
  2026-09-02)*.** The record's content used to be the spoken turns
  concatenated to a character cap — which is the noise: filler, "can you
  hear me", false starts, repetition. Because that text enters the
  assistant's context window on *every* later run in the DM, the agent was
  carrying the noise forever. It is now generated
  (`api/src/services/voice/voice-compaction.ts`, one
  `deps.sharedModelClient` call): what was actually discussed and decided,
  every substantive detail kept — names, numbers, decisions, commitments,
  open questions — the conversational noise dropped, written as prose in
  the assistant's voice rather than meeting minutes. The verbatim
  attachment is unchanged and remains the ground truth. Three properties
  hold it up:
  - **It fails open, always.** No model client configured, a provider
    error, an empty or unusable answer — each falls back to the verbatim
    `renderCallSummary`. The call is over and unreproducible, so a failed
    summarisation may cost the compaction and never the record.
  - **The transcript is untrusted input to the summariser.** It is text a
    device reported, and the output lands in an agent's context window, so
    it travels in the user turn inside explicit delimiters and the
    instruction says plainly that it is data describing what was said —
    never instructions to follow.
  - **`metadata.voiceCall.compacted`** records which shape the content is,
    so the card (and any later reader) can tell a generated record from a
    fallback one without reading the text. Records written before this
    shipped carry no flag and read as the fallback shape, which is what
    they are.
- **The card opens the transcript in place, never by navigating.** The
  record used to end "Full transcript attached." — dead text, and once the
  control existed it printed the same sentence one line above the button, so
  neither shape of record says it any more: the model learns the file exists
  from the attachment inventory line the run pipeline appends, and the person
  gets a control. That control lives on `VoiceCallMessage`, opens the shared
  `Dialog`, and renders the attachment's markdown through `MessageMarkdown`
  with bytes fetched by the shared `TextFilePreview` (an authed fetch — an
  `<a href>` misses both the `Authorization` header and the cross-origin
  `api.` host).
  Deliberately not a link: a `blob:`/`data:` URL inherits the page origin,
  and following one replaces the SPA with the raw file and destroys the
  mobile shell's navigation state (fixed in
  `mobile/src/lib/call-external-url.ts`; top-level navigation to
  page-created documents is now blocked outright). A call too short to
  store a transcript has `transcriptAttachmentId: null` and shows no
  control at all.
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

## What only the live service could tell us

Five bugs that every isolated check passed. Recorded because each is the kind
of thing the next platform will have its own version of.

- **The credential is `?access_token=`, not `?key=`.** A browser cannot set
  WebSocket request headers, so Coder's `Authorization: Token …` does not
  port. The first draft guessed `?key=`, reasoning that an ephemeral
  credential stands in for an API key. Google closes that socket with 1007:
  *"Obtain one from CreateAuthToken and pass it in an `access_token` query
  param"*.
- **Gemini answers in BINARY WebSocket frames.** Node's `ws` hands back a
  Buffer that stringifies, so every probe passed; a browser gets a `Blob`,
  which went into `JSON.parse` and died in the parser's catch. The socket
  opened, setup was sent, `setupComplete` came back, and the client discarded
  all of it — stuck on "Connecting…" with no console error anywhere. Fixed
  with `binaryType = 'arraybuffer'` plus a decode. This is why a socket
  closing during connect now fails the call loudly.
- **Ledger requires `deviceId` to be a UUID.** The relay sent a raw HMAC hex
  digest, which Ledger rejects with 400. It is now a version-8 UUID derived
  from the same digest, with a test asserting the shape — a hex digest looks
  perfectly fine locally and fails only at the one place that matters.
- **The admin's CSP and permissions policy forbade the feature.** `connect-src`
  had no Google origin, and `Permissions-Policy` denied the microphone
  outright — correct when every call handed off to a provider, wrong the
  moment a call captures audio in the admin.
- **Both Apple shells lacked microphone entitlements.** The Mac app reported
  `navigator.mediaDevices` undefined; the iOS app **crashed outright**, which
  is iOS working as designed — touching the microphone with no
  `NSMicrophoneUsageDescription` is a TCC violation and the process is
  terminated, not handed a catchable error. The WebView also needed
  `mediaCapturePermissionGrantType`, without which it would have stopped
  crashing and then quietly failed.

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
