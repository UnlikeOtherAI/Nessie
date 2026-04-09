# Agent Identity and External Communication Channels

Agents are not just internal entities. They have real-world identity — email addresses, phone numbers, WhatsApp accounts, SMS capability. This makes them externally reachable and capable of initiating and receiving communication through the same channels humans use.

This is a design brief, not a finalized spec. It captures the concept and maps out what needs to be designed.

Related documents:
- [voip-twilio-implementation.md](voip-twilio-implementation.md) — Twilio VOIP implementation: call flows, SIP trunking, transcription, recording, cost model
- [../the-agents.md](../the-agents.md) — agent architecture and execution
- [../agent-base-template.md](../agent-base-template.md) — universal agent contract

---

## Core Concept

Every agent can have one or more **external identities** — real addresses and numbers that the outside world can reach. These are not simulations. An agent with an email address receives real emails. An agent with a VOIP number can receive real calls and texts.

This transforms agents from "things you talk to inside the app" into "colleagues you can email, call, or message on WhatsApp."

---

## Identity Types

### Email

- Real email addresses per agent (e.g., `code-reviewer@agents.example.com`, `ops-bot@company.com`)
- Delivery options:
  - **AWS SES** — send/receive, low cost, high volume, requires domain verification
  - **Custom internal mail server** — full control, on-prem compatible, IMAP/SMTP
  - **Provider-agnostic interface** — the agent doesn't know which mail system backs it
- Incoming email → parsed → routed to agent as a message in a thread
- Outgoing email → agent composes via tool → sent through configured provider
- Email threads map to Nessie threads (correlation via Message-ID / In-Reply-To headers)

### VOIP Phone Number

- Real phone number per agent (local or toll-free)
- Providers: Twilio, Vonage, Telnyx, or self-hosted (Asterisk/FreeSWITCH)
- Capabilities:
  - Receive/make voice calls (connects to voice layer — OpenAI Realtime API or similar)
  - Receive/send SMS
  - Voicemail → transcription → agent message
  - **Join conference calls and meetings** (see Corporate VOIP section below)
- Incoming call → voice session with the agent
- Incoming SMS → parsed → routed as message

### WhatsApp

- WhatsApp Business API (via Meta Cloud API or BSP)
- Agent has a real WhatsApp number
- Incoming messages → routed to agent
- Outgoing messages → sent via API
- Rich media support (images, documents, voice notes)
- Template messages for outbound initiation (WhatsApp policy)
- Maps directly to OpenClaw's WhatsApp channel integration

### SMS

- Via VOIP provider (Twilio, etc.) or dedicated SMS gateway
- Inbound SMS → agent message
- Outbound SMS → agent tool
- Short code or long code depending on volume

### Future: Slack, Teams, Discord, Telegram

- OpenClaw already supports these as chat surfaces
- Agent identity = bot user in each platform
- One agent can have identities across multiple platforms simultaneously

---

## Agent Identity Model

Extend the agent record with identity bindings:

```
agent_identities
  id               UUID PK
  agent_id         UUID FK → agents
  channel_type     ENUM (email, voip, whatsapp, sms, slack, telegram, discord, teams)
  address          TEXT — the actual address/number: "reviewer@agents.co", "+14155551234"
  provider         TEXT — "ses", "smtp", "twilio", "meta_cloud_api", "vonage"
  provider_config  JSONB — provider-specific config (encrypted at rest)
  display_name     TEXT — how the agent presents itself: "Alex, Code Reviewer"
  status           ENUM (active, suspended, pending_verification, deprovisioned)
  verified_at      TIMESTAMPTZ
  organization_id  UUID FK → organizations
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ

  @@unique([channel_type, address])
  @@index([agent_id, channel_type])
```

### Identity as Persona

An agent's external identity is part of its persona:
- `display_name` — "Alex Chen" or "Code Review Bot" depending on how human-like the org wants it
- `email_signature` — auto-appended to outgoing emails
- `voicemail_greeting` — played when agent can't take a call
- `avatar_url` — profile photo across platforms
- `timezone` — for scheduling and "available hours"

This connects to personalization memory — the agent adapts its communication style per channel (formal in email, concise in SMS, conversational on WhatsApp).

---

## Communication Tools

Each identity type needs corresponding tools that agents can use:

### Email Tools

| Tool | Description | Risk |
|------|-------------|------|
| `email_read` | Read inbox, specific thread, or search | Low |
| `email_send` | Compose and send email | Medium — external-facing |
| `email_reply` | Reply in an existing thread | Medium |
| `email_forward` | Forward to another address | High — data exfiltration risk |
| `email_draft` | Create draft for human review before sending | Low |

### Phone/SMS Tools

| Tool | Description | Risk |
|------|-------------|------|
| `sms_send` | Send SMS to a number | Medium |
| `sms_read` | Read received SMS | Low |
| `call_initiate` | Start outbound voice call | High — costs money, external |
| `call_transfer` | Transfer active call | Medium |
| `voicemail_read` | Read transcribed voicemails | Low |

### WhatsApp Tools

| Tool | Description | Risk |
|------|-------------|------|
| `whatsapp_send` | Send message (within 24h window or via template) | Medium |
| `whatsapp_read` | Read conversation history | Low |
| `whatsapp_send_template` | Send approved template message | Medium |
| `whatsapp_send_media` | Send image/document/audio | Medium — data exfiltration risk |

---

## Security Considerations

### External Communication is High-Risk

Any tool that sends data outside the system boundary is inherently risky:
- **Data exfiltration**: Agent emails confidential info to an external address
- **Impersonation**: Agent sends messages appearing to be from the organization
- **Cost**: VOIP calls and SMS cost real money per use
- **Reputation**: Bad emails/messages damage the org's brand
- **Compliance**: Email retention, recording consent for calls, GDPR for contact data
- **Spam/Abuse**: An agent that can send unlimited emails is a spam cannon

### Required Controls

1. **Outbound approval gates**: External messages above a risk threshold require human approval before sending (like the `email_draft` tool pattern — compose, hold, approve, send)
2. **Recipient allowlists**: Per-agent lists of approved external contacts/domains
3. **Rate limits**: Per-agent, per-channel send limits (e.g., max 50 emails/day, max 10 SMS/hour)
4. **Content policy**: Automated scanning for PII, credentials, confidential markers before external send
5. **Cost caps**: Per-agent spend limits on VOIP/SMS
6. **Audit trail**: Every external communication logged with full content, recipient, timestamp, approval chain
7. **Revocation**: Ability to immediately suspend an agent's external identity without affecting internal operation
8. **Domain separation**: Agent email domains should be distinguishable from human employee domains (e.g., `agents.company.com` vs `company.com`) unless the org explicitly wants human-passing agents

### Identity Verification

- Email: domain verification (SES), SPF/DKIM/DMARC alignment
- VOIP: carrier registration, STIR/SHAKEN for caller ID
- WhatsApp: Business verification through Meta
- SMS: 10DLC registration (US), sender ID registration (international)

---

## Inbound Message Routing

When an external message arrives at an agent's identity:

```
External message arrives (email/SMS/WhatsApp/call)
  │
  ├── 1. Provider receives it (SES/Twilio/Meta API)
  │
  ├── 2. Webhook/push delivers to Nessie gateway
  │
  ├── 3. Look up agent_identity by (channel_type, address)
  │
  ├── 4. Create or find thread (correlation via headers/conversation ID)
  │
  ├── 5. Create message in thread (role: 'user', with sender metadata)
  │
  ├── 6. Route to agent via normal channel orchestration
  │
  └── 7. Agent processes and responds through the same channel
```

For voice calls, step 6-7 involves connecting to the voice layer (OpenAI Realtime API) for live conversation.

---

## OpenClaw Integration

This maps directly to OpenClaw's multi-channel gateway:

| Nessie Identity | OpenClaw Channel |
|---|---|
| Email | Not native — implement as skill/plugin |
| VOIP | Voice Call channel |
| WhatsApp | WhatsApp channel (native) |
| SMS | SMS via Twilio plugin |
| Slack | Slack channel (native) |
| Telegram | Telegram channel (native) |
| Discord | Discord channel (native) |

OpenClaw already handles inbound message routing from chat surfaces to agent sessions. Nessie's identity model extends this by:
- Making the identity assignment explicit and auditable
- Adding outbound initiation (not just responding)
- Adding approval gates and rate limits
- Connecting to the memory and skill systems

---

## Connection to Agent Template

The base agent template (docs/agent-base-template.md) should be extended with:

### Identity Declaration
- `identities[]` — which external channels this agent can use
- `communication_policy` — rate limits, approval requirements, recipient restrictions
- `persona` — display name, avatar, signature, greeting, timezone

### Memory Integration
- External conversations become memory sources (email threads → captured memories)
- Personalization memory tracks communication preferences per external contact
- Procedural memory captures "how to handle this type of external request"

### Skill Integration
- Email management skills (triage inbox, draft responses, follow up)
- Phone skills (take messages, schedule callbacks, handle IVR-like flows)
- Cross-channel skills (receive email → respond on WhatsApp, or vice versa)
- Meeting skills (join call, take notes, produce minutes, create tasks, update calendar)

---

## Corporate VOIP — Meeting Participation

VOIP identity unlocks an entirely new dimension: agents as active meeting participants. An agent with a phone number can dial into any conference bridge — Zoom, Teams, Google Meet, or plain SIP — the same way a human would. This makes them first-class participants in the corporate workflow without requiring platform-specific bot integrations.

### Capabilities

| Capability | Description |
|---|---|
| **Join meetings** | Agent dials into a conference bridge using its VOIP number. Supports SIP trunking, PSTN dial-in, or WebRTC depending on provider. No platform-specific bot SDK required — if it has a dial-in number, the agent can join. |
| **Real-time transcription** | Live speech-to-text of all participants. Speaker diarization via voice fingerprinting or API-provided speaker labels. Feeds into the agent's working memory during the call. |
| **Meeting notes** | Structured notes generated in real-time or post-call: key decisions, action items, open questions, topic transitions. Stored as artifacts linked to the meeting thread. |
| **Minutes generation** | Formal minutes document produced after the meeting: attendees, agenda items discussed, decisions made, action items with owners and deadlines. Can follow org-specific templates. |
| **Task creation** | Action items extracted from the conversation → automatically created as tasks in Nessie (or synced to external systems: Jira, Linear, Asana). Each task linked to the source moment in the transcript. |
| **Calendar management** | Agent reads calendar invites, auto-joins scheduled meetings, proposes scheduling for follow-ups, sends calendar invites for action item deadlines. Integrates with Google Calendar, Outlook, CalDAV. |
| **Live participation** | Agent can speak during the meeting via TTS (text-to-speech) through the voice layer. Can answer questions, provide status updates, read out summaries when asked. |
| **Follow-up automation** | Post-meeting: distributes minutes via email, creates tasks, schedules follow-up meetings, sends reminders for action items as deadlines approach. |

### Meeting Agent Flow

```
Calendar invite received (or manual "join this call" command)
  │
  ├── 1. Agent reads invite → extracts dial-in number, meeting ID, passcode
  │
  ├── 2. At scheduled time, agent dials in via VOIP provider (SIP/PSTN)
  │
  ├── 3. Voice layer connects — bidirectional audio stream established
  │
  ├── 4. Real-time transcription begins (Whisper, Deepgram, or provider ASR)
  │      Speaker diarization tags each utterance
  │
  ├── 5. Agent listens, builds running context in working memory:
  │      - Topics discussed
  │      - Decisions made
  │      - Action items mentioned (who, what, when)
  │      - Open questions / parking lot items
  │
  ├── 6. If addressed or prompted, agent speaks via TTS:
  │      - Status updates, data lookups, schedule checks
  │      - "Let me check..." → tool call → spoken answer
  │
  ├── 7. Meeting ends (hang-up detected or scheduled end time)
  │
  ├── 8. Post-processing:
  │      ├── Generate structured minutes (template-driven)
  │      ├── Extract action items → create tasks with owners + deadlines
  │      ├── Update calendar with follow-ups
  │      └── Distribute minutes via email to attendees
  │
  └── 9. Store meeting transcript + minutes as episodic memory
         Link to project/channel for future retrieval
```

### Meeting Tools

| Tool | Description | Risk |
|------|-------------|------|
| `meeting_join` | Dial into a conference bridge | Medium — uses VOIP minutes |
| `meeting_leave` | Hang up / leave the meeting | Low |
| `meeting_mute` | Mute/unmute agent's microphone | Low |
| `meeting_speak` | Say something via TTS | Medium — external-facing, audible to all participants |
| `meeting_transcribe` | Start/stop real-time transcription | Low — but recording consent required |
| `meeting_notes` | Generate structured notes from transcript | Low |
| `meeting_minutes` | Generate formal minutes document | Low |
| `meeting_extract_tasks` | Extract action items from transcript | Low |
| `meeting_schedule` | Create/modify calendar events | Medium — affects others' calendars |

### Recording Consent and Compliance

Meeting recording is a legal minefield. The agent must handle this correctly:

- **Announcement**: When joining, the agent should announce its presence and that it will be recording/transcribing (configurable per org policy — some jurisdictions require all-party consent)
- **Consent tracking**: Record which participants were present and whether consent was obtained
- **Jurisdiction awareness**: Different rules apply in different locations (one-party vs. all-party consent states/countries)
- **Retention**: Meeting transcripts and recordings follow org retention policy
- **Redaction**: Ability to redact sensitive portions of transcripts before distribution
- **Opt-out**: Any participant can request the agent stop recording or leave the call

### Calendar Integration Model

```
agent_calendars
  id               UUID PK
  agent_id         UUID FK → agents
  provider         TEXT — "google", "outlook", "caldav"
  provider_config  JSONB — OAuth tokens, CalDAV URL, etc. (encrypted at rest)
  calendar_id      TEXT — the specific calendar to read/write
  auto_join        BOOLEAN — automatically join meetings from this calendar
  organization_id  UUID FK → organizations
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

The calendar becomes a scheduling interface for the agent: put a meeting on its calendar and it shows up. This is how humans work — agents should work the same way.

---

## What Needs Full Design

1. **Provider abstraction layer** — unified interface for send/receive across email, SMS, WhatsApp, voice
2. **Thread correlation** — mapping external conversation IDs to Nessie threads across reconnects and platform switches
3. **Contact model** — who the agent talks to externally (contacts, organizations, relationship history)
4. **Outbound approval workflow** — how drafts are reviewed before sending
5. **Cost accounting** — per-agent, per-channel spend tracking and budgets
6. **Compliance** — email retention policies, call recording consent, GDPR for contact data
7. **Identity provisioning** — how new identities are created, verified, and assigned to agents
8. **Multi-identity routing** — when someone emails AND WhatsApps the same agent about the same topic
9. **Handoff** — agent escalates to human, human takes over the external conversation seamlessly
10. **Available hours** — agents that only respond during business hours, with voicemail/auto-reply outside
11. **Meeting participation protocol** — how agents join, behave in, and leave conference calls (SIP integration, WebRTC fallback, DTMF for meeting codes)
12. **Speaker diarization pipeline** — real-time speaker identification and attribution during multi-party calls
13. **Minutes template system** — org-configurable templates for different meeting types (standup, planning, retro, 1:1, all-hands)
14. **Calendar sync** — bidirectional sync with Google Calendar, Outlook, CalDAV; conflict resolution when agent has overlapping meetings
15. **Task extraction model** — NLP pipeline for reliably extracting action items with owner, deadline, and priority from natural conversation
