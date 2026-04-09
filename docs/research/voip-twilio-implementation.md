# VOIP Implementation — Twilio

Technical implementation brief for Nessie's voice agent capabilities via Twilio. This document covers how agents with VOIP identity make and receive calls, join meetings, and integrate with the agent runtime.

Related documents:
- [agent-identity-and-channels.md](agent-identity-and-channels.md) — agent external identity model, meeting capabilities
- [../the-agents.md](../the-agents.md) — agent architecture, tools, execution loop

---

## Why Twilio

Twilio is a CPaaS (Communications Platform as a Service) that provides phone numbers, PSTN access, and call control APIs. For Nessie, Twilio serves as the **telecom layer** — a dumb pipe with provisioning. Nessie's differentiation is the AI, not the telephony.

**What Twilio handles:**
- Phone number provisioning (global DID inventory)
- PSTN connectivity (public phone network access)
- Call routing and signaling
- Regulatory compliance per country
- Carrier-grade reliability (~99.95% uptime SLA)

**What Nessie handles:**
- AI agent logic and decision-making
- Transcription pipeline (cheaper than Twilio's built-in)
- Meeting intelligence (notes, minutes, tasks, calendar)
- Memory integration (episodic memory from calls)
- Cost optimization

---

## Global Availability

Twilio provides local numbers in **100+ countries** with voice coverage across **nearly 200 destinations**.

Key markets for Nessie:
- US — local and toll-free numbers, full voice
- UK — local numbers, full voice
- EU — local numbers across member states (including Czech Republic)
- Most Western world countries covered

Users can select a number from any supported country. Numbers are rented monthly (~$1/month typical).

Number types:
- **Local** — standard geographic number, best caller ID trust
- **Toll-free** — 1-800 style, no charge to caller
- **Mobile** — limited in EU, often SMS-only, not reliable for voice

---

## Core Architecture

### Call Flow — Inbound

```
External caller dials agent's Twilio number
  │
  ├── 1. Twilio receives call on PSTN
  │
  ├── 2. Twilio sends webhook to Nessie gateway
  │     POST /api/voice/incoming
  │     Body: { From, To, CallSid, ... }
  │
  ├── 3. Gateway looks up agent_identity by (channel_type='voip', address=To)
  │
  ├── 4. Gateway returns TwiML instructions:
  │     <Response>
  │       <Connect>
  │         <Stream url="wss://nessie.example.com/voice/stream/{agentId}" />
  │       </Connect>
  │     </Response>
  │
  ├── 5. Twilio opens WebSocket to Nessie voice server
  │     Bidirectional audio stream (mulaw 8kHz or PCM 16kHz)
  │
  ├── 6. Voice server connects to AI pipeline:
  │     ├── Audio → ASR (Whisper/Deepgram) → text
  │     ├── Text → Agent runtime (process as message in thread)
  │     └── Agent response → TTS → audio → WebSocket → Twilio → caller
  │
  └── 7. On hang-up:
        ├── End stream
        ├── Generate call summary
        ├── Store as episodic memory
        └── Process any action items
```

### Call Flow — Outbound

```
Agent initiates outbound call (via `call_initiate` tool)
  │
  ├── 1. Validate: agent has VOIP identity, recipient in allowlist, budget available
  │
  ├── 2. Twilio REST API: POST /2010-04-01/Accounts/{sid}/Calls.json
  │     From: agent's Twilio number
  │     To: recipient number
  │     Url: callback URL for call control
  │
  ├── 3. Twilio places call on PSTN
  │
  ├── 4. On answer: same WebSocket stream flow as inbound
  │
  └── 5. Same post-call processing
```

### Call Flow — Meeting Join

```
Agent joins a conference call (via `meeting_join` tool)
  │
  ├── 1. Extract dial-in details from calendar invite or manual input
  │     Phone number + meeting ID + passcode
  │
  ├── 2. Twilio outbound call to the conference bridge number
  │
  ├── 3. DTMF injection for meeting ID and passcode
  │     TwiML: <Play digits="w123456#ww7890#" />
  │     (w = wait 0.5s, # = pound key)
  │
  ├── 4. Once connected to conference:
  │     ├── Announce agent presence (configurable per org policy)
  │     ├── Begin bidirectional audio stream
  │     └── Start transcription pipeline
  │
  ├── 5. During meeting:
  │     ├── Real-time transcription with speaker diarization
  │     ├── Running context in working memory (topics, decisions, action items)
  │     ├── If addressed: TTS response through audio stream
  │     └── Tool calls for data lookups if asked
  │
  └── 6. Post-meeting: same processing as any call end
```

---

## SIP Trunking (Recommended Architecture)

For production deployments with high call volume, SIP trunking is preferred over per-call WebSocket streaming:

```
Twilio SIP Trunk
  │
  ├── SIP INVITE → Nessie Media Server (FreeSWITCH or Otelco)
  │
  ├── Media server handles:
  │     ├── Codec negotiation
  │     ├── Audio mixing (for conferences)
  │     ├── Recording
  │     └── RTP stream management
  │
  └── Media server forwards audio to AI pipeline via internal API
```

**Why SIP trunking:**
- Lower latency (direct media path, no WebSocket overhead)
- Full media control (recording, mixing, codec selection)
- Multi-provider support (can add Telnyx, local carriers alongside Twilio)
- Cost optimization (SIP is cheaper per minute at volume)

**When to use WebSocket streaming instead:**
- Low volume (< 100 calls/day)
- Quick prototyping
- No media server infrastructure available

---

## Transcription Pipeline

Twilio offers built-in transcription but it's expensive. Nessie runs its own:

```
Audio stream (from Twilio WebSocket or SIP media server)
  │
  ├── Buffer: collect audio chunks (configurable window: 1-5 seconds)
  │
  ├── ASR Engine (choose one):
  │     ├── Whisper (OpenAI) — best accuracy, higher latency (~2s)
  │     ├── Deepgram — fast, good accuracy, streaming support
  │     └── Google Speech-to-Text — good for multilingual
  │
  ├── Speaker diarization:
  │     ├── Voice activity detection (VAD) per audio channel
  │     ├── Speaker embedding (voice fingerprint) per detected speaker
  │     └── Map speakers to known contacts (if available) or Speaker 1/2/N
  │
  └── Output: timestamped, speaker-attributed transcript segments
        { speaker: "Speaker 1", text: "Let's discuss the Q3 roadmap", start: 12.4, end: 15.1 }
```

### Cost Comparison

| Provider | Cost per minute | Latency | Notes |
|---|---|---|---|
| Twilio built-in | ~$0.05/min | Real-time | Convenient but expensive |
| Whisper API | ~$0.006/min | ~2s batch | 8x cheaper, slight delay |
| Deepgram | ~$0.0043/min | Streaming | Cheapest, real-time capable |
| Self-hosted Whisper | ~$0.001/min (compute) | ~2s batch | Cheapest, requires GPU infra |

**Recommendation**: Deepgram for real-time transcription during calls (streaming, low latency). Whisper for post-call processing where accuracy matters more than speed.

---

## Recording

Every call can be recorded for compliance, training, and memory:

```
call_recordings
  id               UUID PK
  agent_id         UUID FK → agents
  call_sid         TEXT — Twilio call identifier
  thread_id        UUID FK → threads — the conversation thread this call maps to
  
  recording_url    TEXT — Twilio-hosted recording URL (temporary)
  storage_url      TEXT — our permanent storage (GCS/S3)
  duration_seconds INT
  
  transcript_id    UUID — link to processed transcript
  consent_status   ENUM (all_party, one_party, unknown, refused)
  
  created_at       TIMESTAMPTZ
  expires_at       TIMESTAMPTZ — Twilio recording retention
```

### Consent Model

Recording consent varies by jurisdiction:
- **One-party consent** (most US states, UK): Agent's announcement at call start is sufficient
- **All-party consent** (California, EU countries): All participants must consent
- **Meeting recording**: Announcement at join + opt-out mechanism

The system must:
1. Check jurisdiction of caller (via phone number country code)
2. Play appropriate consent announcement
3. Record consent status per call
4. If consent refused: disable recording, continue call without it
5. Retention: follow org policy (default 90 days, configurable)

---

## Number Provisioning

When an agent needs a phone number:

```
POST /api/agents/{id}/identities
{
  "channel_type": "voip",
  "country": "US",
  "number_type": "local",  // local | toll_free
  "area_code": "415",      // optional preference
  "display_name": "Alex, Project Manager"
}
```

Flow:
1. Validate agent has VOIP capability in their role/toolPolicy
2. Check org budget for number provisioning
3. Search Twilio for available numbers matching criteria
4. Purchase number via Twilio API
5. Configure incoming call webhook to Nessie gateway
6. Create `agent_identity` record
7. Number is immediately active

### Number Lifecycle

```
provisioned → active → suspended → deprovisioned
                │
                └→ ported_out (number transferred to another provider)
```

- **Suspended**: Org can temporarily disable incoming/outgoing without releasing the number
- **Deprovisioned**: Number released back to Twilio. After release, number may be reassigned to another Twilio customer.
- **Porting**: If org moves to another provider, the number can be ported out (takes 2-4 weeks)

---

## Calendar Integration for Auto-Join

Agents with VOIP identity + calendar access can auto-join meetings:

```
Background job: every 5 minutes
  │
  ├── For each agent with auto_join = true:
  │     ├── Check upcoming calendar events (next 10 minutes)
  │     ├── For each event with dial-in info:
  │     │     ├── Parse dial-in number + meeting ID + passcode
  │     │     ├── At T-1 minute: initiate `meeting_join` 
  │     │     └── Agent dials in and begins transcription
  │     └── For events without dial-in: skip (no way to join)
  │
  └── On meeting end (scheduled time or hang-up detection):
        ├── Generate minutes
        ├── Extract action items → create tasks
        ├── Distribute minutes via email to attendees
        └── Store as episodic memory
```

---

## Agent Voice Personality

Each agent can have a distinct voice:

```
agent_voice_config
  id               UUID PK
  agent_id         UUID FK → agents
  tts_provider     TEXT — "openai", "elevenlabs", "google"
  tts_voice_id     TEXT — provider-specific voice identifier
  tts_speed        FLOAT DEFAULT 1.0
  language         TEXT DEFAULT "en-US"
  
  greeting         TEXT — "Hello, this is Alex from the engineering team"
  voicemail_greeting TEXT — played when agent can't take a call
  hold_music_url   TEXT — optional
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

Voice selection considerations:
- Match voice to agent persona (professional, friendly, neutral)
- Language and accent matching for the org's primary market
- Consistent voice across all calls (users recognize the agent)

---

## Cost Model

### Per-Call Costs

| Component | Cost | Notes |
|---|---|---|
| Twilio number rental | ~$1/month | Per number |
| Twilio inbound voice | ~$0.0085/min (US) | Varies by country |
| Twilio outbound voice | ~$0.013/min (US) | Varies by destination |
| Transcription (Deepgram) | ~$0.0043/min | Real-time streaming |
| TTS (OpenAI) | ~$0.015/1K chars | Agent speaking |
| AI processing | ~$0.01-0.05/min | Depends on model and tool calls |

### Budget Controls

Per the agent identity model:
- **Per-agent monthly cap**: Max spend on VOIP per agent (e.g., $50/month)
- **Per-call cap**: Max duration per call (e.g., 60 minutes)
- **Rate limiting**: Max concurrent calls per agent (default: 1)
- **Allowlist**: Outbound calls only to approved numbers/patterns
- **Alerts**: Notify org admin when agent reaches 80% of monthly cap

All costs flow into the `cost_ledger` with `operation = 'voice_call'`.

---

## Provider Abstraction

Twilio is the initial provider, but the architecture must support provider switching:

```typescript
interface VoiceProvider {
  // Number management
  searchNumbers(criteria: NumberSearchCriteria): Promise<AvailableNumber[]>
  provisionNumber(number: string): Promise<ProvisionedNumber>
  releaseNumber(number: string): Promise<void>
  
  // Call control
  initiateCall(from: string, to: string, callbackUrl: string): Promise<CallSession>
  endCall(callSid: string): Promise<void>
  sendDtmf(callSid: string, digits: string): Promise<void>
  
  // Media
  startStream(callSid: string, wsUrl: string): Promise<void>
  startRecording(callSid: string): Promise<string> // returns recording ID
  stopRecording(callSid: string): Promise<void>
}
```

Future providers:
- **Telnyx** — cheaper per-minute rates, SIP-native
- **Vonage** — good EU coverage, WebRTC support
- **Local carriers** — cheapest, but per-country integration work
- **Self-hosted (FreeSWITCH/Asterisk)** — full control, lowest per-minute cost, highest ops overhead

### Multi-Provider Strategy

```
Phase 1 (now): Twilio only
  └── Fast to market, global coverage, one integration

Phase 2 (scale): Twilio + Telnyx
  └── Least Cost Routing (LCR) — route each call to cheapest provider
  └── Telnyx for high-volume markets (US, UK)
  └── Twilio for long-tail countries

Phase 3 (optimize): Multi-provider + self-hosted
  └── FreeSWITCH media server for calls staying within infrastructure
  └── Twilio/Telnyx for PSTN origination/termination only
  └── Provider-agnostic interface — agents don't know which provider handles their calls
```

---

## What Needs Implementation

1. **Voice gateway** — Webhook handler for Twilio incoming/outgoing calls, WebSocket stream manager
2. **Transcription service** — Audio → text pipeline with speaker diarization, pluggable ASR backends
3. **Voice agent runtime** — Integration between audio stream and agent execution loop (bidirectional: text in from transcription, text out to TTS)
4. **Number provisioning API** — CRUD for agent VOIP identities via Twilio
5. **Recording service** — Record, store, manage consent, enforce retention
6. **Calendar connector** — Google Calendar + Outlook integration for auto-join
7. **DTMF handler** — Meeting code/passcode injection for conference bridge dialing
8. **Cost tracking** — Per-call cost calculation and budget enforcement
9. **Provider abstraction** — Interface layer to support multiple VOIP providers
10. **Voice config** — TTS voice selection, greetings, voicemail per agent
