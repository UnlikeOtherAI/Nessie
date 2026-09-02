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
[docs/plans/2026-09-02-gemini-voice-calling.md](../plans/2026-09-02-gemini-voice-calling.md).

- **The API is a credential broker, not a media path.** `POST
  /api/voice/sessions` asks Ledger (`/v1/gemini/live-token`) for Google's
  one-use ephemeral `auth_tokens/…` credential, carrying `LEDGER_PROXY_TOKEN`
  plus signed `X-Nessie-Context` / `X-UOA-Delegation` through the same identity
  seam every Ledger call uses. The client then opens the *constrained*
  BidiGenerateContent socket itself and audio flows device↔Google. The app key
  never leaves the server; the ephemeral credential is the only one a client
  holds. Ledger requires signed UOA subject/org/team on a product-bound token,
  so on a signing deployment a caller with no linked UOA identity fails closed.
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
  ambient workspace context that may have drifted mid-call.
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
  `FileService` chokepoint. The `active → ended` conditional update is the
  claim, so a retry or two tabs racing a hang-up produce exactly one record.
- **`pa_send` adds no authority.** The one declared function posts an ordinary
  user message through the normal message route, so the run is
  indistinguishable from a typed one and every existing gate applies. It acks
  `working` immediately (Gemini Live blocks until a tool responds) and the reply
  is spoken later; replies are polled through a viewer-entitled read rather than
  the thread SSE stream, which is cut structurally when a run consumes a
  privileged source.
- **Local-dev constraint:** the Ledger call goes through `safeFetch`, which
  refuses loopback and private addresses, so a local Ledger cannot be used —
  point `LEDGER_PUBLIC_URL` at the hosted service.
