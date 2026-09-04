# Calling the Personal Assistant (Gemini Live voice)

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


The channel header's call button is **one control** whose behaviour follows the
channel kind: in the `personal_assistant` DM it starts a live voice call with
the assistant; everywhere else it keeps minting provider-linked meetings
(below). Structural, never a reading of content, and never a second phone
glyph. Spec and phasing:
[docs/plans/2026-09-02-gemini-voice-calling/overview.md](../plans/2026-09-02-gemini-voice-calling/overview.md).

- **The API is a credential broker, not a media path.** `POST
  /api/voice/sessions` asks Ledger (`/v1/gemini/live-token`) for Google's
  one-use ephemeral `auth_tokens/…` credential, carrying `LEDGER_PROXY_TOKEN`
  plus signed `X-Nessie-Context` / `X-UOA-Delegation` through the same identity
  seam every Ledger call uses. The client then opens the *constrained*
  BidiGenerateContent socket itself and audio flows device↔Google. The app key
  never leaves the server; the ephemeral credential is the only one a client
  holds. Ledger requires signed UOA subject/org/team on a product-bound token,
  so on a signing deployment a caller with no linked UOA identity fails closed.
- **Spoken audio cannot have typed-chat interception semantics.** Microphone
  frames already reach Gemini over that direct socket before Nessie has text to
  scan. The shared compact prompt tells the assistant not to request or repeat
  credentials; once transcript fragments exist, the client redacts them before
  live rendering or local persistence, and the API refuses an unsanitized
  transcript before writing its message or attachment. Never describe this as
  preventing a spoken credential from reaching Gemini.
- **`voice_installations` are server-minted.** Ledger reserves daily budget per
  device slot, so a client-chosen device id would let one account multiply
  those reservations; ids come from the row and per-user caps
  (`NESSIE_VOICE_MAX_INSTALLATIONS_PER_USER`,
  `NESSIE_VOICE_MAX_DAILY_MINTS_PER_USER`) bound them.
- **One call is one `voice_sessions` row across N credentials.** Rotation
  (`/rotate`) replaces Google's 30-minute credential in place so the usage
  stream and the single transcript slot stay attached; the socket resumes with
  Gemini's resumption handle rather than re-seeding context. The UOA tuple is
  captured at mint and every later relay re-signs against it, never against
  ambient team context that may have drifted mid-call.
- **Context seeds as role-preserving turns**, never inside
  `setup.systemInstruction` — folding DM history into the highest-trust tier
  would let anything ever said in the DM read as an instruction. The seed is
  small on purpose: Gemini Live re-bills accumulated context on *every* turn.
- **The voice and the manner are per-agent.** `Agent.voiceName` is one of the
  eight curated `GEMINI_LIVE_VOICES`; `Agent.speakingStyle` is the person's own
  words for how the agent talks. Both are set in the Agent Designer ("Voice and
  manner"), and both lists live once in `@nessie/schemas` — Google publishes no
  API enumerating Live voices, so the picker reads the constant and never an
  endpoint. `resolveVoiceName(agent.voiceName)` prefers the agent, then
  `NESSIE_VOICE_GEMINI_VOICE`, then `Charon`, validating each against that list
  because an unknown name fails Gemini's `setup`. The style reaches the typed
  system prompt and `setup.systemInstruction` through one
  `buildSpeakingStyleBlock`, at the same trust tier as the system prompt —
  it is agent configuration, not conversation. Today's call target is always
  the `systemManaged` PA, so its own call still uses the deployment voice.
- **The call record is one message in the assistant's voice.** A `user`-role
  record would structurally wake the PA (`resolvePersonalAssistantDecisions`
  replies to every human turn in a PA DM) and one message role cannot carry two
  speakers, so `POST …/transcript` writes an `assistant` message holding a short
  summary with the full transcript as a `.md` attachment through the one
  `FileService` chokepoint. The `active → ended` conditional update is the claim,
  so a retry or two tabs racing a hang-up produce exactly one record.
- **Two artefacts: a compaction the agent carries, a transcript that is the
  truth.** The message content is generated
  (`api/src/services/voice/voice-compaction.ts`) — what was discussed and
  decided, filler dropped — because raw turns re-enter the assistant's context
  window on every later run in the DM. It **fails open** to the verbatim summary
  on any failure: a call is unreproducible, so summarisation may never cost the
  record. The transcript reaches the summariser as delimited, untrusted data in
  the user turn, never as instructions. `metadata.voiceCall.compacted` says
  which shape the content is; the card renders each as what it is plus a **Full
  transcript** control opening the attachment in the shared `Dialog` — never a
  navigating link, which is how a `blob:` URL destroyed mobile's nav state.
- **`pa_send` adds no authority.** The one declared function posts an ordinary
  user message, so the run is indistinguishable from a typed one and every
  existing gate applies. It acks `working` immediately (Gemini Live blocks
  until a tool responds) and the reply is spoken later; replies are polled
  through a viewer-entitled read rather than the thread SSE stream, which is
  cut structurally when a run consumes a privileged source. Both halves are
  **voice-scoped routes** (`…/pa-send`, `…/replies`) rather than the generic
  message routes, because the device credential is refused on those by design:
  a native call needs them and a stolen phone token must not become a write to
  any thread the person can see. What keeps that scope real is that the thread
  is the call's own and is never named by the caller. Web and native use the
  same two routes — one path, so neither can drift.
- **The post-commit work of a message is one service, not one route's tail.**
  A message row on its own does nothing; `deliverCreatedMessage`
  (`api/src/services/message-delivery.ts`) is what wakes the agent, pushes to
  phones, alerts whoever was named, and announces it to open feeds. Both the
  composer's route and `pa-send` call it. Forking that sequence into the voice
  path is how you get a hand-off that writes a message, looks like it worked,
  and answers nothing.
- **A hand-off spends from the call's tool budget.** `maxToolCalls` is the only
  bound on how much work one call can start, and a hand-off starts a real
  billable run — far more than a web search. It is counted for the run it
  begins, not for the fixed ack it returns. Gemini's own call id arrives as the
  `Idempotency-Key`, so a retried tool call is one message, one run and one
  unit of budget.
- **On iPhone the call is native, and the seam is the call lifecycle — not
  CallKit.** `mobile/modules/nessie-voice-call/` is a local Expo module whose
  `AgentCallSession` protocol states four moments a platform reports: connect
  (which must start **no** audio I/O), audio activated, audio deactivated, and
  held. CallKit drives them today; Android's self-managed `ConnectionService`
  drives the same four, which is why everything above the audio layer — the
  Gemini protocol client, the credential relay, rotation, the usage relay, the
  transcript — is written once. Adding a CallKit-shaped parameter to that
  protocol is how the second platform stops being a port and becomes a fork.
- **Held is not muted.** Muting keeps a silent stream flowing so Gemini's VAD
  can still see the end of an utterance; holding — a cellular call arriving, or
  `didDeactivate` without an end action — stops sending altogether, because
  silence is a real audio stream that is billed and answered into an output
  nobody can hear.
- **A route change rebuilds the audio pipeline, not just the route.** The
  platform picks the route; `AVAudioEngine` does not follow it — the input
  node's hardware format changes, so the installed tap and the sample-rate
  converter are stale and the playback graph's connections are broken. Build
  the converter inside capture from the *current* input format and rebuild on
  both `AVAudioSession.routeChangeNotification` and
  `.AVAudioEngineConfigurationChange`. A converter built once at init is the
  bug: it points at a format the session had not chosen yet.
- **The call belongs to the process, not the JS bundle.** A reload tears down
  the Expo module and every listener while the CallKit call, the socket and the
  microphone keep running, so the call lives on `VoiceCallController.shared`
  and `getActiveCallState()` reads a lock-guarded snapshot off the main actor —
  the shell asks during its first render, and the queue it would otherwise wait
  on is the one painting. Without it a reload leaves the UI blind mid-call.
- **The WebView provisions once; the phone renews itself.** The SPA mints the
  voice-scoped device credential on its ordinary session and hands it over the
  shell bridge. Everything after that is the native side's, against
  `POST /api/voice/device-token/refresh` — a locked phone has no foreground
  WebView to ask. The credential lives in
  memory for one call, because the WebView mints a fresh one every time; when
  phase 3 makes the phone place calls with no WebView to mint from, a stored
  one has to be `AfterFirstUnlock` — a locked-phone call *rewrites* it, and the
  stricter class fails that write.
- **Local-dev constraint:** the Ledger call goes through `safeFetch`, which
  refuses loopback and private addresses, so a local Ledger cannot be used —
  point `LEDGER_PUBLIC_URL` at the hosted service.
