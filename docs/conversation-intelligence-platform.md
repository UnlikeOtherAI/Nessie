# Conversation Intelligence Platform

Nessie is not a transcript processor or an automation tool. It is an event-driven conversation intelligence engine with pluggable ingestion and agent workflows.

The core loop:

```
Conversations in → normalized → routed through agents → written into memory → actions out
```

Every conversation source — Teams meetings, Zoom calls, Twilio voice, WhatsApp threads, email, Slack, custom integrations — is treated identically by the platform. Intelligence lives in the agents, not the connectors. Connectors are dumb pipes that ingest and normalize.

Related documents:
- [the-agents.md](the-agents.md) — agent architecture, execution, skills
- [multi-agent-memory-system.md](multi-agent-memory-system.md) — memory types, retrieval, feedback
- [research/agent-identity-and-channels.md](research/agent-identity-and-channels.md) — agent external identity
- [research/voip-twilio-implementation.md](research/voip-twilio-implementation.md) — Twilio VOIP (one connector implementation)

---

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │         Plugin / Connector Layer      │
                    │  (Teams, Zoom, Twilio, Email, Slack,  │
                    │   WhatsApp, custom enterprise plugins) │
                    └──────────────┬────────────────────────┘
                                   │ raw events
                                   ▼
                    ┌─────────────────────────────────────┐
                    │        Normalization Layer            │
                    │  Raw source data → Conversation model │
                    └──────────────┬────────────────────────┘
                                   │ normalized events
                                   ▼
                    ┌─────────────────────────────────────┐
                    │       Identity Resolution Layer       │
                    │  External identity → SSO → user_id    │
                    └──────────────┬────────────────────────┘
                                   │ enriched events
                                   ▼
                    ┌─────────────────────────────────────┐
                    │          Event Bus                    │
                    │  conversation.started                 │
                    │  conversation.message                 │
                    │  conversation.completed               │
                    │  conversation.action_required         │
                    └──────────────┬────────────────────────┘
                                   │ events
                                   ▼
                    ┌─────────────────────────────────────┐
                    │        Trigger / Workflow Engine      │
                    │  Event → conditions → agent routing   │
                    └──────────────┬────────────────────────┘
                                   │ agent assignments
                                   ▼
                    ┌─────────────────────────────────────┐
                    │       Agent Orchestration Layer       │
                    │  Route to agents, execute, evaluate   │
                    └──────────┬────────────┬──────────────┘
                               │            │
                    ┌──────────▼──┐  ┌──────▼───────────┐
                    │   Memory     │  │   Action Layer    │
                    │   System     │  │   (CRM, email,    │
                    │   (capture)  │  │    calendar, etc.) │
                    └─────────────┘  └────────────────────┘
```

---

## 1. Plugin / Connector Layer

Plugins are dumb. They do exactly two things: receive raw data from an external source, and emit it as a normalized event. No intelligence, no routing decisions, no memory access.

### Plugin Interface

```typescript
interface ConversationPlugin {
  /** Unique identifier for this plugin type */
  source: string  // "teams", "zoom", "twilio", "email", "whatsapp", "slack", "custom"
  
  /** Plugin metadata */
  metadata: {
    name: string
    version: string
    author: string
    description: string
    configSchema: JSONSchema  // what the enterprise needs to configure
    capabilities: PluginCapability[]
  }
  
  /** Initialize with enterprise-specific config */
  initialize(config: PluginConfig): Promise<void>
  
  /** Register webhook/listener for incoming events */
  registerWebhook(callbackUrl: string): Promise<WebhookRegistration>
  
  /** Parse raw webhook payload into normalized event */
  normalize(rawPayload: unknown): ConversationEvent
  
  /** Healthcheck */
  healthcheck(): Promise<HealthStatus>
  
  /** Teardown */
  destroy(): Promise<void>
}

type PluginCapability = 
  | "inbound_message"      // receives messages
  | "outbound_message"     // can send messages
  | "inbound_voice"        // receives voice calls
  | "outbound_voice"       // can place voice calls
  | "transcript"           // receives post-hoc transcripts
  | "real_time_stream"     // real-time audio/text stream
  | "file_attachment"      // supports file sharing
  | "reaction"             // supports emoji reactions
  | "thread"               // supports threaded replies
  | "presence"             // shows online/offline status
```

### Plugin Registration

```
connector_plugins
  id               UUID PK
  organization_id  UUID FK → organizations
  source           TEXT — "teams", "zoom", "twilio", etc.
  name             TEXT — display name for this instance
  config           JSONB — encrypted provider-specific config (OAuth tokens, API keys, webhook secrets)
  status           ENUM (active, paused, error, pending_setup)
  capabilities     TEXT[] — what this instance can do
  webhook_url      TEXT — the URL registered with the external service
  health_status    ENUM (healthy, degraded, down, unknown)
  last_health_at   TIMESTAMPTZ
  error_message    TEXT — last error if status = error
  created_by       UUID
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ

  @@unique([organization_id, source, name])
```

### Pre-Built Connectors

Nessie ships with connectors for common platforms. Enterprises can also build custom connectors against the plugin interface.

| Connector | Capabilities | Status |
|---|---|---|
| **Twilio Voice** | inbound_voice, outbound_voice, real_time_stream | Designed — see [voip-twilio-implementation.md](research/voip-twilio-implementation.md) |
| **Email (SES/SMTP)** | inbound_message, outbound_message, file_attachment, thread | Planned |
| **WhatsApp (Meta Cloud API)** | inbound_message, outbound_message, file_attachment | Planned |
| **Slack** | inbound_message, outbound_message, reaction, thread, presence | Planned |
| **Microsoft Teams** | inbound_message, outbound_message, transcript, thread, presence | Planned |
| **Zoom** | transcript, real_time_stream | Planned |
| **Google Meet** | transcript | Planned |
| **SMS (Twilio/Telnyx)** | inbound_message, outbound_message | Planned |
| **Telegram** | inbound_message, outbound_message, file_attachment | Planned |
| **Discord** | inbound_message, outbound_message, reaction, thread | Planned |
| **Custom Webhook** | inbound_message | Available — raw JSON webhook, enterprise normalizes |

### Custom Enterprise Plugins

Enterprises integrate their own systems by implementing the `ConversationPlugin` interface:

```
Enterprise has internal communication tool "CorpChat"
  │
  ├── 1. Enterprise builds a CorpChat connector using the plugin SDK
  │     Implements: normalize(rawPayload) → ConversationEvent
  │
  ├── 2. Enterprise registers the connector via API
  │     POST /api/connectors
  │     { source: "custom", name: "CorpChat", config: { webhookSecret: "..." } }
  │
  ├── 3. Enterprise configures CorpChat to POST to the registered webhook URL
  │
  └── 4. Events flow through the same pipeline as any built-in connector
```

The plugin SDK provides:
- TypeScript/Python interface definitions
- Validation helpers for the normalized event format
- Test harness for plugin development
- Documentation and examples

---

## 2. Normalization Layer

Everything becomes one format. This is the core data contract. All agents consume this — they never see raw source data.

### Normalized Conversation Model

```typescript
interface Conversation {
  id: string                    // unique conversation ID
  external_id: string           // ID in the source system
  source: string                // "teams", "zoom", "twilio", etc.
  type: ConversationType        // "meeting", "call", "chat", "email", "thread"
  
  participants: Participant[]
  messages: Message[]
  
  started_at: DateTime
  ended_at?: DateTime           // null if ongoing
  
  metadata: {
    title?: string              // meeting title, email subject, channel name
    channel_id?: string         // Nessie channel this maps to
    thread_id?: string          // Nessie thread this maps to
    recording_url?: string      // if recorded
    transcript_url?: string     // if post-hoc transcript available
    source_metadata: Record<string, unknown>  // pass-through from source
  }
}

interface Participant {
  id: string                    // resolved internal user_id (after identity resolution)
  external_id: string           // identity in source system (email, phone, username)
  display_name: string
  role: "host" | "participant" | "observer" | "agent"
  joined_at?: DateTime
  left_at?: DateTime
}

interface Message {
  id: string
  speaker_id: string            // resolved participant ID
  content: string               // text content (transcribed if voice)
  type: "text" | "transcription" | "system" | "action"
  timestamp: DateTime
  
  attachments?: Attachment[]
  reply_to?: string             // parent message ID for threads
  
  metadata?: {
    confidence?: number         // transcription confidence
    language?: string
    sentiment?: string          // if pre-analyzed by source
  }
}

interface Attachment {
  type: "file" | "image" | "audio" | "video" | "link"
  url: string
  name: string
  mime_type: string
  size_bytes?: number
}
```

### Conversation Events

The normalization layer emits events, not raw data. The event bus distributes them.

```typescript
type ConversationEvent = {
  id: string                    // unique event ID
  type: ConversationEventType
  organization_id: string
  conversation_id: string
  source: string
  timestamp: DateTime
  payload: Conversation | Message | Participant
}

type ConversationEventType =
  | "conversation.started"       // new conversation opened
  | "conversation.message"       // new message in conversation
  | "conversation.completed"     // conversation ended (meeting over, call hung up)
  | "conversation.participant_joined"
  | "conversation.participant_left"
  | "conversation.recording_ready"
  | "conversation.transcript_ready"
  | "conversation.action_required"  // system detected something needing attention
```

---

## 3. Identity Resolution Layer

External identities must resolve to internal users. Without this, memory and permissions don't work.

### Resolution Flow

```
External identity (from source)
  │  e.g., "john@company.com" from Teams, "+14155551234" from Twilio
  │
  ├── 1. Look up in identity_mappings table
  │     Match by (source, external_id, organization_id)
  │
  ├── 2. If found → resolved. Use internal user_id.
  │
  ├── 3. If not found → SSO resolution
  │     ├── Azure AD: look up by email/UPN
  │     ├── Google Workspace: look up by email
  │     ├── SAML: look up by attribute
  │     └── If found → create mapping, use internal user_id
  │
  ├── 4. If SSO fails → external contact
  │     Create or match in contacts table
  │     Mark as external (limited permissions, no memory access)
  │
  └── 5. Enrichment
        Attach: role, team, department (from SSO directory)
        Attach: agent permissions (from Nessie user record)
        Attach: personalization model (if exists)
```

### Identity Mapping Table

```
identity_mappings
  id               UUID PK
  organization_id  UUID FK → organizations
  user_id          UUID FK → users (nullable — null for unresolved externals)
  contact_id       UUID FK → contacts (nullable — for external contacts)
  
  source           TEXT — "teams", "zoom", "twilio", "email", etc.
  external_id      TEXT — the identity in the source system
  external_type    TEXT — "email", "phone", "username", "slack_id"
  display_name     TEXT
  
  verified         BOOLEAN DEFAULT false
  verified_at      TIMESTAMPTZ
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([organization_id, source, external_id])
  @@index([user_id])
```

### Contact Model (External Participants)

People outside the organization who appear in conversations:

```
contacts
  id               UUID PK
  organization_id  UUID FK → organizations
  
  name             TEXT
  email            TEXT
  phone            TEXT
  company          TEXT
  role             TEXT
  
  first_seen_at    TIMESTAMPTZ
  last_seen_at     TIMESTAMPTZ
  conversation_count INT DEFAULT 0
  
  metadata         JSONB — CRM data, relationship history, notes
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([organization_id, email])
```

---

## 4. Event Bus and Trigger System

All normalized events flow through an event bus. Triggers define what happens when specific events occur.

### Event Bus

Events are stored durably and distributed to subscribers:

```
conversation_events
  id               UUID PK
  organization_id  UUID FK → organizations
  conversation_id  TEXT
  type             TEXT — event type
  source           TEXT — connector source
  payload          JSONB — the normalized event data
  
  status           ENUM (pending, dispatched, processed, failed)
  dispatched_at    TIMESTAMPTZ
  processed_at     TIMESTAMPTZ
  error            TEXT
  
  created_at       TIMESTAMPTZ
  
  @@index([organization_id, type, created_at])
  @@index([conversation_id])
```

No polling. Everything is webhook-first. Events are pushed to triggers, not pulled.

### Trigger Definitions

Triggers are the "Zapier triggers" of the platform. They match events to agent workflows.

```
workflow_triggers
  id               UUID PK
  organization_id  UUID FK → organizations
  name             TEXT
  description      TEXT
  
  event_type       TEXT — "conversation.completed", "conversation.message", etc.
  source_filter    TEXT[] — only from these sources (null = all sources)
  
  conditions       JSONB — additional filtering rules:
                   {
                     "conversation_type": ["meeting", "call"],
                     "participant_count_min": 2,
                     "has_external_participants": true,
                     "keywords": ["deal", "contract", "pricing"]
                   }
  
  action           JSONB — what to do when triggered:
                   {
                     "type": "route_to_agent",
                     "agent_id": "uuid",
                     "skill_id": "uuid",        // optional — run this specific skill
                     "priority": "normal",
                     "context_override": {}      // additional context for the agent
                   }
  
  enabled          BOOLEAN DEFAULT true
  created_by       UUID
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

### Trigger Evaluation

```
Event arrives on bus
  │
  ├── 1. Match event_type against all active triggers for this org
  │
  ├── 2. For each matching trigger, evaluate conditions
  │     ├── Source filter: event.source IN trigger.source_filter
  │     ├── Type filter: conversation.type matches
  │     ├── Participant filter: count, external presence
  │     ├── Keyword filter: content contains specified terms
  │     └── Custom conditions: evaluated as expressions
  │
  ├── 3. For each trigger that passes conditions
  │     ├── Create agent task from trigger.action
  │     ├── Inject conversation data as context
  │     └── Enqueue for agent execution
  │
  └── 4. Multiple triggers can fire for the same event
        (e.g., a sales call triggers both a note-taker and a CRM updater)
```

### Example Triggers

```json
{
  "name": "Sales call → extract action items",
  "event_type": "conversation.completed",
  "source_filter": ["twilio", "zoom"],
  "conditions": {
    "conversation_type": ["call", "meeting"],
    "has_external_participants": true,
    "keywords": ["deal", "pricing", "contract", "proposal", "follow-up"]
  },
  "action": {
    "type": "route_to_agent",
    "agent_id": "sales-assistant-uuid",
    "skill_id": "extract-action-items-uuid"
  }
}
```

```json
{
  "name": "All meetings → generate minutes",
  "event_type": "conversation.completed",
  "source_filter": null,
  "conditions": {
    "conversation_type": ["meeting"],
    "participant_count_min": 2
  },
  "action": {
    "type": "route_to_agent",
    "agent_id": "meeting-assistant-uuid",
    "skill_id": "generate-minutes-uuid"
  }
}
```

```json
{
  "name": "Support email → triage",
  "event_type": "conversation.message",
  "source_filter": ["email"],
  "conditions": {
    "keywords": ["help", "issue", "broken", "bug", "error"]
  },
  "action": {
    "type": "route_to_agent",
    "agent_id": "support-triage-uuid"
  }
}
```

---

## 5. Agent Routing

When a trigger fires, the conversation must be routed to the right agent. This connects to the existing channel orchestrator but extends it for external conversation sources.

### Routing Decisions

```
Trigger fires with action { agent_id, skill_id }
  │
  ├── If agent_id specified → route directly to that agent
  │
  ├── If agent_id is null → intelligent routing
  │     ├── Analyze conversation content (type, topic, participants)
  │     ├── Match against agent capabilities and skills
  │     ├── Consider agent load and budget
  │     └── Select best agent (LLM-based, same as channel orchestrator)
  │
  └── Create run
        ├── Thread: create or find thread for this conversation
        ├── Message: inject normalized conversation as agent input
        ├── Context: include trigger metadata, participant info, conversation history
        └── Execute: normal agent run loop
```

### Conversation → Thread Mapping

External conversations map to Nessie threads:

```
conversation_thread_mappings
  id               UUID PK
  organization_id  UUID FK → organizations
  conversation_id  TEXT — external conversation ID
  source           TEXT
  thread_id        UUID FK → threads
  channel_id       UUID FK → channels (optional)
  
  created_at       TIMESTAMPTZ
  
  @@unique([organization_id, conversation_id, source])
```

If the same external conversation produces multiple events (e.g., real-time messages during a meeting), they all map to the same thread. The agent sees a coherent conversation, not disconnected events.

---

## 6. Memory Integration

Conversations from external sources are first-class memory inputs. The agent processes them through the same memory pipeline as any interaction.

### Memory Flow from External Conversations

```
Conversation arrives (via trigger)
  │
  ├── 1. Agent processes conversation
  │     ├── Extract: decisions, action items, commitments, entities
  │     ├── Reason: why were decisions made, what tradeoffs discussed
  │     └── Summarize: compressed intelligence, not raw transcript
  │
  ├── 2. Memory capture (via existing pipeline)
  │     ├── Semantic: facts, decisions, key information
  │     ├── Reasoning: why decisions were made, alternatives considered
  │     ├── Episodic: situation-action-outcome for the meeting/call
  │     ├── Procedural: if agent discovered a workflow, capture it
  │     └── Framing: if agent learned about a new domain/project
  │
  ├── 3. Scope assignment
  │     ├── Organization: always set
  │     ├── Channel: if conversation maps to a Nessie channel
  │     ├── Project: if conversation relates to a known project
  │     ├── Visibility: based on participant list (audience = participants)
  │     └── Sensitivity: auto-classified or manually set
  │
  └── 4. Memory is available to ALL agents
        Subject to normal scoping rules (org boundary, audience compatibility)
```

### Raw Transcript Storage

Raw transcripts are stored separately from memory:

```
conversation_transcripts
  id               UUID PK
  conversation_id  TEXT
  organization_id  UUID FK → organizations
  source           TEXT
  
  content          TEXT — full transcript text
  structured       JSONB — speaker-attributed segments
  
  retention_days   INT — org-configurable, default 90
  expires_at       TIMESTAMPTZ
  
  created_at       TIMESTAMPTZ
```

Raw transcripts are **not** memory. They are audit/compliance artifacts. Memory is the compressed intelligence extracted by agents. The transcript is the evidence trail.

---

## 7. Action Layer

Agents don't just consume conversations — they act on them. Actions flow outward through the same connector layer.

### Outbound Actions

| Action | Description | Connector Used |
|---|---|---|
| Send email follow-up | Agent drafts and sends email to participants | Email connector |
| Create CRM record | Agent creates/updates deal, contact, activity | CRM connector (Salesforce, HubSpot) |
| Create tasks | Agent extracts action items → task management | Task connector (Jira, Linear, Asana) |
| Update calendar | Agent schedules follow-up meetings | Calendar connector (Google, Outlook) |
| Send Slack message | Agent posts summary to a channel | Slack connector |
| Reply in thread | Agent responds in the original conversation | Same connector as source |
| Create document | Agent generates meeting minutes, reports | Document connector (Notion, Google Docs) |

### Action Interface

```typescript
interface ActionPlugin {
  target: string  // "salesforce", "jira", "google_calendar", etc.
  
  /** Execute an action */
  execute(action: AgentAction): Promise<ActionResult>
  
  /** Validate action before execution */
  validate(action: AgentAction): Promise<ValidationResult>
}

interface AgentAction {
  type: string          // "create_task", "send_email", "update_crm", etc.
  target: string        // which system
  payload: unknown      // action-specific data
  agent_id: string      // who initiated
  run_id: string        // which run
  approval_required: boolean
}
```

Action plugins follow the same pattern as conversation plugins — dumb connectors, enterprise-configurable, swappable.

---

## 8. Design Principles

### 1. Everything is event-driven
No polling. Webhooks in, webhooks out. Events are the universal interface between layers.

### 2. Plugins are dumb
Connectors ingest, normalize, and deliver. They contain zero business logic. Intelligence lives in agents.

### 3. Normalization is sacred
Every source becomes the same data model. Agents never see raw source formats. If a new source can't be normalized, it can't be ingested.

### 4. Identity resolution is mandatory
Every participant must resolve to an internal user or external contact. Without identity, there is no permission model and no memory scoping.

### 5. Memory is structured early
Agents extract structured intelligence (decisions, actions, entities) from conversations immediately. Don't store raw text as memory. Raw transcripts are audit artifacts, not knowledge.

### 6. Agents own the intelligence
The platform routes conversations to agents. Agents decide what to extract, what to remember, and what actions to take. The platform provides the plumbing.

### 7. Multi-trigger is normal
One event can fire multiple triggers. A sales call can simultaneously trigger note generation, CRM update, and follow-up scheduling. These are independent agent tasks.

---

## 9. Enterprise Deployment Model

### Pre-Built Integration Packages

Enterprises select from pre-built packages on sign-up:

| Package | Includes | Use Case |
|---|---|---|
| **Voice AI** | Twilio connector + meeting skills | AI agents on calls |
| **Email Intelligence** | Email connector + triage skills | AI email processing |
| **Meeting Assistant** | Teams/Zoom/Meet connectors + minutes/tasks skills | AI meeting notes |
| **Sales Intelligence** | Voice + Email + CRM connectors + sales skills | AI sales assistant |
| **Support** | Email + Chat connectors + support skills | AI support triage |
| **Full Platform** | All connectors + all skills | Everything |

### Custom Integration

Enterprises that need connectors for internal systems:

1. Use the plugin SDK to build a connector
2. Register it via API
3. Configure triggers
4. Agents work identically — they don't know or care what source produced the conversation

### Multi-Provider Strategy

The platform is not locked to any provider. Enterprises choose:
- Voice: Twilio, Telnyx, Vonage, or self-hosted
- Email: SES, SendGrid, custom SMTP
- Chat: Slack, Teams, Discord, or custom
- CRM: Salesforce, HubSpot, Pipedrive, or custom
- Tasks: Jira, Linear, Asana, or custom
- Calendar: Google, Outlook, CalDAV

The connector layer abstracts all of this. Swapping providers means changing a connector config, not rewriting agent logic.

---

## What Needs Full Design

1. **Plugin SDK** — TypeScript/Python packages with interface definitions, validation, test harness
2. **Event bus implementation** — PostgreSQL-backed initially, move to dedicated message broker at scale (NATS, Kafka)
3. **Trigger condition DSL** — structured conditions beyond simple field matching (time windows, aggregations, rate-based)
4. **Action plugin registry** — same pattern as conversation plugins but for outbound actions
5. **Identity resolution service** — SSO integration (Azure AD, Google, SAML), contact matching, dedup
6. **Conversation state machine** — lifecycle management for long-running conversations (multi-day email threads, recurring meetings)
7. **Cost attribution** — track costs per connector, per trigger, per agent execution
8. **Rate limiting per connector** — respect external API limits (Teams throttling, Twilio rate limits)
9. **Retry and dead-letter for events** — failed event processing must not lose data
10. **Admin UI for trigger management** — visual trigger builder, test mode, event log
