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
- Section 10 below — Twilio voice connector (reference plugin implementation)
- [marketplace.md](marketplace.md) — workflow templates register triggers via § 4
- [skills.md](skills.md) — conversation intelligence triggers skills
- [external-tool-integration.md](external-tool-integration.md) — action layer uses connectors

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
| **Twilio Voice** | inbound_voice, outbound_voice, real_time_stream | Designed — see § 10 below |
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

Triggers are the "Zapier triggers" of the platform. They match events to agent workflows. In this document, the authored definition record is named `workflow_trigger_definitions` to distinguish it from installation-time `workflow_triggers` materialized by the marketplace/runtime layer.

```
workflow_trigger_definitions
  id               UUID PK
  organization_id  UUID FK → organizations
  workflow_installation_id UUID (nullable — set when this trigger activates a workflow installation)
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
                   or:
                   {
                     "type": "invoke_workflow_installation",
                     "workflow_installation_id": "uuid",
                     "priority": "normal"
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
  │     ├── If trigger.action.type = "route_to_agent" → create agent task from trigger.action
  │     ├── If trigger.action.type = "invoke_workflow_installation" → create workflow run from trigger.action
  │     ├── Inject conversation data as context
  │     └── Enqueue for execution
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

```json
{
  "name": "GitHub issue opened → triage workflow",
  "event_type": "github.issue.opened",
  "source_filter": ["github"],
  "conditions": {},
  "action": {
    "type": "invoke_workflow_installation",
    "workflow_installation_id": "issue-triage-installation-uuid"
  }
}
```

---

## 5. Agent Routing

When a trigger fires, the conversation must be routed to the right agent. This connects to the existing channel orchestrator but extends it for external conversation sources.

### Routing Decisions

```
Trigger fires with action { type, agent_id?, skill_id?, workflow_installation_id? }
  │
  ├── If action.type = "route_to_agent" and agent_id specified → route directly to that agent
  │
  ├── If action.type = "route_to_agent" and agent_id is null → intelligent routing
  │     ├── Analyze conversation content (type, topic, participants)
  │     ├── Match against agent capabilities and skills
  │     ├── Consider agent load and budget
  │     └── Select best agent (LLM-based, same as channel orchestrator)
  │
  ├── If action.type = "invoke_workflow_installation"
  │   ├── Load workflow installation and resolved bindings
  │   ├── Create workflow run linked to that installation
  │   └── Execute materialized workflow steps
  │
  └── Otherwise create run
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

## 6. Conversation Intelligence Pipeline

This is the core of the platform. When a normalized conversation arrives, the intelligence pipeline breaks it apart, extracts structured knowledge into every applicable memory type, scopes it to the right channels/projects/teams, and makes it available to all agents that should see it.

The pipeline runs per-conversation, not per-message. A completed meeting or call is processed as a whole. Real-time conversations (chat, ongoing threads) can be processed incrementally on `conversation.message` events, but the full extraction runs on `conversation.completed`.

### Pipeline Overview

```
Normalized conversation arrives (from trigger)
  │
  ├── STAGE 1: INTAKE — Store raw, create thread mapping
  │
  ├── STAGE 2: SCOPE RESOLUTION — Who was in this conversation? What channels/projects does it belong to?
  │
  ├── STAGE 3: EXTRACTION — LLM-driven multi-pass extraction into memory types
  │
  ├── STAGE 4: MEMORY CAPTURE — Write extracted intelligence into the memory system
  │
  ├── STAGE 5: ACTION DISPATCH — Create tasks, send follow-ups, update external systems
  │
  └── STAGE 6: SELF-EVAL — Did the extraction produce useful output? What's missing?
```

### Stage 1: Intake

```
Conversation arrives
  │
  ├── Store raw transcript (compliance artifact, not memory)
  │     → conversation_transcripts table
  │
  ├── Create or find Nessie thread for this conversation
  │     → conversation_thread_mappings table
  │     If same conversation_id already has a thread, reuse it
  │
  ├── Create or find Nessie channel
  │     Mapping rules:
  │     ├── Twilio call from agent's VOIP number → agent's default channel
  │     ├── Email to agent's address → agent's email channel
  │     ├── Teams meeting → mapped Teams channel (if configured)
  │     ├── Zoom meeting → mapped project channel (if configured)
  │     └── Unknown → org default intake channel
  │
  └── Create Run record for the processing agent
        The agent assigned by the trigger handles all extraction
```

### Raw Transcript Storage

```
conversation_transcripts
  id               UUID PK
  conversation_id  TEXT
  organization_id  UUID FK → organizations
  source           TEXT
  
  content          TEXT — full transcript text
  structured       JSONB — speaker-attributed segments with timestamps
  participant_map  JSONB — { speaker_label → resolved user_id/contact_id }
  
  retention_days   INT — org-configurable, default 90
  expires_at       TIMESTAMPTZ
  
  created_at       TIMESTAMPTZ
```

Raw transcripts are NOT memory. They are audit/compliance artifacts with a retention window. Memory is the compressed intelligence extracted by the pipeline. The transcript is the evidence trail — it stays around for compliance and can be re-processed if the extraction pipeline improves.

### Stage 2: Scope Resolution

Every piece of extracted intelligence must be scoped correctly. The scope determines who can see it.

```
Conversation participants (resolved via identity layer)
  │
  ├── Determine AUDIENCE
  │     The audience is the set of all resolved internal users in the conversation.
  │     This becomes the visibility boundary for extracted memories.
  │     
  │     Rules:
  │     ├── All-internal meeting (e.g., 3 engineers) → audience = those 3 people
  │     ├── Meeting with external participants → audience = internal participants only
  │     │   (external participants don't get memory access)
  │     ├── 1:1 call with agent → audience = the user + the agent
  │     └── Large company all-hands → audience = org-wide
  │
  ├── Determine CHANNEL
  │     ├── If conversation maps to an existing Nessie channel → use that channel
  │     ├── If participants all belong to one team → scope to team channel
  │     ├── If conversation relates to a known project → scope to project channel
  │     └── Otherwise → org-level intake channel
  │
  ├── Determine PROJECT
  │     ├── If conversation title/content references a known project → associate
  │     ├── If participants are all in one project → associate
  │     └── Otherwise → null (org-scoped only)
  │
  ├── Determine SENSITIVITY
  │     Auto-classification based on content:
  │     ├── Contains PII, financial data, legal terms → "restricted"
  │     ├── Contains personnel info, salary, performance → "sensitive"
  │     └── General business discussion → "normal"
  │     Org can override with manual rules per source/participant/keyword
  │
  └── Determine VISIBILITY
        Based on audience size and channel:
        ├── 1:1 conversation → "private" (only those 2 people)
        ├── Small group (2-10) → "channel" (scoped to the mapped channel)
        ├── Team meeting → "team"
        ├── Cross-team meeting → "project" (if project-associated) or "organization"
        └── All-hands → "organization"
```

The scope resolution output is a `MemoryScope` object that gets attached to every extracted memory:

```typescript
interface MemoryScope {
  organization_id: string       // always set
  channel_id?: string           // if channel-scoped
  project_id?: string           // if project-associated
  team_id?: string              // if team-scoped
  visibility: "private" | "channel" | "team" | "project" | "organization"
  sensitivity: "normal" | "sensitive" | "restricted"
  audience_user_ids: string[]   // the resolved participants — audience compatibility source
}
```

### Stage 3: Extraction

The extraction stage runs the conversation through multiple LLM passes to extract different types of intelligence. Each pass targets a specific memory type.

```
Conversation + scope
  │
  ├── PASS 1: Semantic extraction (facts, decisions, key information)
  │     Input: full transcript (or summary if too long)
  │     Prompt: "Extract facts, decisions, commitments, and key information from this conversation."
  │     Output: array of semantic memory candidates
  │     
  │     Each candidate:
  │     {
  │       content: "The team decided to migrate from Redis to Valkey by end of Q2",
  │       memory_type: "intent",        // or "reason", "constraint", "preference", "fact"
  │       confidence: 0.9,
  │       source_message_ids: ["msg-1", "msg-5"],    // which parts of the transcript
  │       participants_involved: ["user-a", "user-b"]  // who said/decided this
  │     }
  │
  ├── PASS 2: Reasoning extraction (why decisions were made)
  │     Input: transcript + decisions from Pass 1
  │     Prompt: "For each decision, extract the reasoning: what alternatives were considered,
  │              what criteria were applied, what constraints existed, what tradeoffs were made."
  │     Output: array of reasoning records linked to semantic memories
  │     
  │     Each candidate:
  │     {
  │       linked_to: "semantic-candidate-1",   // the decision this reasoning explains
  │       reasoning_type: "decision",
  │       alternatives: ["Keep Redis", "Move to Valkey", "Move to DragonflyDB"],
  │       criteria: ["OSS license", "drop-in compatible", "performance"],
  │       constraints: ["Must complete before Q3 feature freeze"],
  │       tradeoffs: "Valkey is less mature but fully OSS. DragonflyDB is faster but different API.",
  │       confidence: 0.85
  │     }
  │
  ├── PASS 3: Action item extraction (who needs to do what by when)
  │     Input: transcript
  │     Prompt: "Extract all action items, commitments, and follow-ups. 
  │              For each: who owns it, what exactly needs to be done, any deadline mentioned."
  │     Output: array of action items
  │     
  │     Each candidate:
  │     {
  │       description: "Set up Valkey staging cluster for testing",
  │       owner_id: "user-b",           // resolved participant
  │       deadline: "2026-04-18",        // extracted or null
  │       priority: "high",
  │       status: "pending",
  │       source_message_ids: ["msg-12"]
  │     }
  │
  ├── PASS 4: Episodic compression (what happened, what was the outcome)
  │     Input: transcript + extracted decisions + action items
  │     Prompt: "Summarize this conversation as a situation-action-outcome experience."
  │     Output: one episodic memory record
  │     
  │     {
  │       situation: {
  │         summary: "Team meeting to decide Redis replacement strategy",
  │         task_type: "planning",
  │         context: ["infrastructure", "database", "migration"],
  │         participants: ["user-a", "user-b", "user-c"],
  │         constraints: ["Q2 deadline", "must be drop-in compatible"]
  │       },
  │       action: {
  │         summary: "Evaluated three alternatives, decided on Valkey",
  │         key_decisions: ["Migrate to Valkey", "Complete by end of Q2", "Start with staging cluster"],
  │         tools_used: []  // no tools in a meeting, but included for schema consistency
  │       },
  │       outcome: "successful",
  │       duration_seconds: 1800,
  │       lessons: "Team prefers OSS-licensed alternatives even when performance isn't best-in-class"
  │     }
  │
  ├── PASS 5: Procedural detection (did the conversation describe or discover a process?)
  │     Input: transcript
  │     Prompt: "Did this conversation describe, discover, or refine any reusable process or workflow?
  │              Only extract if participants explicitly walked through steps or agreed on a procedure."
  │     Output: procedural memory candidate (often null — most conversations don't contain procedures)
  │     
  │     Only fires if the conversation contains step-by-step discussion. Example:
  │     "When we onboard a new vendor, first we need legal review, then procurement sets up the PO,
  │      then IT provisions access..." → procedural memory candidate.
  │
  └── PASS 6: Entity and relationship extraction
        Input: transcript
        Prompt: "Extract named entities (people, companies, products, projects) and their relationships."
        Output: entities and relationships for the contact model and knowledge graph
        
        {
          entities: [
            { type: "company", name: "ACME Corp", role: "client" },
            { type: "product", name: "Valkey", role: "technology" }
          ],
          relationships: [
            { from: "user-b", to: "ACME Corp", type: "account_owner" }
          ]
        }
```

**Pass optimization**: Not every conversation needs every pass. The pipeline uses a lightweight classifier first:

```
Classifier (cheap model, ~100 tokens output):
  Input: conversation summary (first 500 tokens)
  Output: { 
    has_decisions: bool, 
    has_action_items: bool, 
    has_procedures: bool,
    has_entities: bool,
    conversation_type: "planning" | "status" | "brainstorm" | "support" | "social" | "other"
  }
  
  → Only run passes that the classifier says are likely to produce results
  → "social" conversations skip most passes (minimal extraction)
  → "planning" conversations run all passes
```

**Cost control**: Extraction uses `gpt-4o-mini` for all passes. For conversations longer than 8K tokens, the transcript is summarized first (one cheap LLM call) and the summary is used as input for all passes. Total cost per conversation: ~$0.01–0.05 depending on length and number of passes.

### Stage 4: Memory Capture

Each extraction candidate goes through the existing memory pipeline with the scope from Stage 2.

```
For each extraction candidate:
  │
  ├── 1. Dedup check
  │     SHA-256 fingerprint against existing thoughts in this scope
  │     If duplicate → skip (don't store the same decision twice)
  │
  ├── 2. Create thought record
  │     ├── content: the extracted text
  │     ├── memory_type: determined by extraction pass
  │     ├── embedding: generated via text-embedding-3-small
  │     ├── organization_id, channel_id, project_id, team_id: from scope
  │     ├── visibility: from scope
  │     ├── sensitivity: from scope
  │     └── metadata: pass-specific structured data (JSONB)
  │
  ├── 3. Create source attribution
  │     thought_sources record linking to:
  │     ├── conversation_id
  │     ├── source_message_ids (which transcript segments)
  │     ├── participant_ids (who said it)
  │     └── extraction_pass (which pass produced this)
  │
  ├── 4. Create reasoning records (Pass 2 output)
  │     thought_reasonings linked to the semantic thought
  │     With: alternatives, criteria, constraints, tradeoffs, confidence
  │
  ├── 5. Create thought links
  │     ├── If this decision contradicts an existing memory → CONTRADICTS link
  │     ├── If this supersedes a prior decision → SUPERSEDES link
  │     └── If this supports/extends existing knowledge → SUPPORTS / RELATES_TO link
  │
  └── 6. Create episodic record (Pass 4 output)
        One per conversation, memory_type = 'experience'
        Linked to all semantic memories from this conversation
```

### Stage 5: Action Dispatch

Action items from Pass 3 become real tasks and outbound actions.

```
For each action item:
  │
  ├── 1. Create Nessie task
  │     ├── agent_id: assigned to the agent responsible for follow-up
  │     ├── purpose: the action item description
  │     ├── status: inbox (or assigned if owner is clear)
  │     └── metadata: { deadline, priority, source_conversation_id }
  │
  ├── 2. External system sync (if configured)
  │     ├── Jira/Linear: create ticket
  │     ├── Calendar: schedule follow-up meeting (if deadline implies one)
  │     ├── CRM: update deal stage, log activity
  │     └── Email: send action item summary to participants
  │
  └── 3. Follow-up scheduling
        If deadline exists → schedule reminder at deadline - 1 day
        If no deadline → schedule gentle nudge at owner's next working day
```

### Stage 6: Self-Eval

After extraction, the processing agent evaluates its own work (see multi-agent-memory-system.md § Self-Eval).

```
Self-eval on conversation extraction:
  │
  ├── Did the extraction cover all substantive points?
  │     Compare: number of decisions extracted vs. conversation length and complexity
  │
  ├── Were any participants' contributions missed?
  │     Check: each participant with significant speaking time has at least one attributed memory
  │
  ├── Was the scope correct?
  │     Check: audience matches actual participants, channel/project mapping makes sense
  │
  ├── Were action items concrete enough?
  │     Check: each action item has an owner and a description clear enough to act on
  │
  └── What was missing?
        Missing memories: "No existing framing memory for the Valkey migration project — 
        should create one so future agents have context"
```

### Scope Routing Examples

**Example 1: Engineering standup on Zoom**
```
Participants: 5 engineers, all in #backend-team channel
Source: Zoom transcript
  │
  ├── Scope: team-level, visibility = "team", channel = #backend-team
  ├── Decisions extracted → scoped to #backend-team
  ├── Action items → assigned to specific engineers
  └── Episodic memory → "The team discussed migration blockers and reassigned the DB task"
      Available to: all agents bound to #backend-team or #backend project
```

**Example 2: Sales call via Twilio**
```
Participants: 1 sales rep (internal) + 1 prospect (external)
Source: Twilio voice call
  │
  ├── Scope: private, visibility = "private", no channel mapping
  ├── Audience: only the sales rep (external prospect has no memory access)
  ├── Decisions extracted → private to the sales rep
  ├── Entity extraction → "ACME Corp" contact updated, deal stage updated
  ├── Action items → "Send proposal by Friday" → sales rep's task list
  └── Episodic memory → available to sales agents in this org
      (if sales agents have access to the sales rep's private scope)
      
  NOTE: If the org wants sales memories visible to the whole sales team,
  an admin or the sales rep can promote the channel scope:
    private → team (sales team)
  This is a declassification event and creates an audit record.
```

**Example 3: All-hands meeting on Teams**
```
Participants: 50 people, cross-department
Source: Teams transcript
  │
  ├── Scope: org-level, visibility = "organization"
  ├── Decisions extracted → org-scoped, all agents can see them
  ├── Action items → assigned to specific department leads
  ├── Episodic memory → "Q2 priorities announced: hire 3 engineers, launch v2, enter EU market"
  └── Available to: every agent in the organization
```

**Example 4: Confidential HR meeting**
```
Participants: 1 manager + 1 HR rep
Source: Zoom transcript
  │
  ├── Scope: private, visibility = "private", sensitivity = "restricted"
  ├── Audience: only the manager and HR rep
  ├── Sensitivity override: "restricted" → additional access controls
  ├── NO action items sent to external systems (restricted conversations don't sync to Jira)
  └── Memory available ONLY to agents with restricted access in the audience
      No declassification possible without org admin approval
```

### Multi-Channel Memory Distribution

When a conversation touches multiple teams or projects, extracted memories may need to land in multiple channels:

```
Cross-team planning meeting
  Participants: 2 from backend, 2 from frontend, 1 PM
  Topics discussed: API changes (backend), UI redesign (frontend), timeline (PM)
  │
  ├── Extraction produces 8 semantic memories
  │
  ├── Topic classification (LLM pass):
  │     ├── "New REST endpoint for user profiles" → backend
  │     ├── "Profile page redesign with new components" → frontend
  │     ├── "API contract: JSON schema for profile response" → backend + frontend
  │     └── "Ship by May 15" → project-level
  │
  └── Scope assignment per memory:
        ├── Backend-specific → channel: #backend, visibility: team
        ├── Frontend-specific → channel: #frontend, visibility: team
        ├── Shared contract → channel: #api-contracts, visibility: project
        └── Timeline → project-level, visibility: project
```

The topic classifier determines which channel each memory belongs to. Cross-cutting memories (like shared API contracts) go to a shared scope. The audience compatibility rule still applies — a memory scoped to #backend cannot be surfaced in #frontend unless all #frontend members were in the original meeting.

### Incremental Processing (Real-Time Conversations)

For ongoing conversations (Slack threads, long email chains), the pipeline runs incrementally:

```
conversation.message event arrives
  │
  ├── Lightweight check: is this message substantive?
  │     ├── "ok" / "thanks" / "👍" → skip
  │     └── Contains decision, question, or information → process
  │
  ├── If substantive:
  │     ├── Run semantic extraction on this message only
  │     ├── Check if it contradicts or supersedes existing memories from this thread
  │     └── Store with source attribution to this specific message
  │
  └── On conversation.completed (thread goes quiet for N minutes):
        ├── Run full multi-pass extraction on the entire thread
        ├── Dedup against incrementally extracted memories
        └── Store episodic summary of the full conversation
```

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

## 10. Reference Plugin Implementation — Twilio Voice

This section documents the Twilio voice connector end-to-end as a reference for how plugins integrate with the platform. Twilio is a CPaaS (Communications Platform as a Service) that provides phone numbers, PSTN access, and call control APIs. For Nessie, Twilio is the telecom layer — a dumb pipe with provisioning. The intelligence lives in the agents, not Twilio.

**What Twilio handles:** phone number provisioning (global DID inventory), PSTN connectivity, call routing and signaling, regulatory compliance per country, carrier-grade reliability (~99.95% uptime SLA).

**What the platform handles:** AI agent logic and decision-making, transcription pipeline (cheaper than Twilio's built-in), meeting intelligence (notes, minutes, tasks, calendar), memory integration (episodic memory from calls), cost optimization.

### Global Availability

Twilio provides local numbers in 100+ countries with voice coverage across nearly 200 destinations.

Key markets:
- US — local and toll-free numbers, full voice
- UK — local numbers, full voice
- EU — local numbers across member states (including Czech Republic)
- Most Western world countries covered

Number types:
- **Local** — standard geographic number, best caller ID trust
- **Toll-free** — 1-800 style, no charge to caller
- **Mobile** — limited in EU, often SMS-only, not reliable for voice

Numbers are rented monthly (~$1/month typical). Users select a number from any supported country.

### Plugin Configuration

The Twilio voice connector implements `ConversationPlugin` with capabilities: `inbound_voice`, `outbound_voice`, `real_time_stream`.

```
connector_plugins entry:
  source:        "twilio"
  capabilities:  ["inbound_voice", "outbound_voice", "real_time_stream"]
  config: {
    account_sid:     "AC...",
    auth_token:      "encrypted",
    trunking_domain: "nessie.pstn.twilio.com",   // if SIP trunking
    default_region:  "us1",
    webhook_secret:  "encrypted"
  }
```

### Call Flows

#### Inbound Call

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
        ├── Emit conversation.completed event → normalization layer → pipeline
        ├── Generate call summary
        └── Store as episodic memory
```

#### Outbound Call

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
  └── 5. Same post-call processing and event emission
```

#### Meeting Join

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
  └── 6. Post-meeting:
        ├── Emit conversation.completed → full pipeline extraction
        ├── Generate minutes, extract tasks, update calendar
        └── Distribute via email to attendees
```

### SIP Trunking (Production Architecture)

For high call volume, SIP trunking is preferred over per-call WebSocket streaming:

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

**Why SIP trunking:** lower latency (direct media path, no WebSocket overhead), full media control (recording, mixing, codec selection), multi-provider support (can add Telnyx, local carriers alongside Twilio), cost optimization (SIP is cheaper per minute at volume).

**When to use WebSocket streaming instead:** low volume (< 100 calls/day), quick prototyping, no media server infrastructure available.

### Transcription Pipeline

Twilio offers built-in transcription but it's expensive. The platform runs its own:

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

#### Transcription Cost Comparison

| Provider | Cost per minute | Latency | Notes |
|---|---|---|---|
| Twilio built-in | ~$0.05/min | Real-time | Convenient but expensive |
| Whisper API | ~$0.006/min | ~2s batch | 8x cheaper, slight delay |
| Deepgram | ~$0.0043/min | Streaming | Cheapest, real-time capable |
| Self-hosted Whisper | ~$0.001/min (compute) | ~2s batch | Cheapest, requires GPU infra |

**Recommendation**: Deepgram for real-time transcription during calls (streaming, low latency). Whisper for post-call processing where accuracy matters more than speed.

### Recording and Consent

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

#### Consent Model

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

### Number Provisioning

When an agent needs a phone number:

```
POST /api/agents/{id}/identities
{
  "channel_type": "voip",
  "country": "US",
  "number_type": "local",
  "area_code": "415",
  "display_name": "Alex, Project Manager"
}

Flow:
1. Validate agent has VOIP capability in their role/toolPolicy
2. Check org budget for number provisioning
3. Search Twilio for available numbers matching criteria
4. Purchase number via Twilio API
5. Configure incoming call webhook to Nessie gateway
6. Create agent_identity record
7. Number is immediately active
```

#### Number Lifecycle

```
provisioned → active → suspended → deprovisioned
                │
                └→ ported_out (number transferred to another provider)
```

- **Suspended**: Org can temporarily disable incoming/outgoing without releasing the number
- **Deprovisioned**: Number released back to Twilio. After release, number may be reassigned.
- **Porting**: If org moves to another provider, the number can be ported out (takes 2-4 weeks)

### Calendar Integration for Auto-Join

Agents with VOIP identity + calendar access can auto-join meetings:

```
Background job: every 5 minutes
  │
  ├── For each agent with auto_join = true:
  │     ├── Check upcoming calendar events (next 10 minutes)
  │     ├── For each event with dial-in info:
  │     │     ├── Parse dial-in number + meeting ID + passcode
  │     │     ├── At T-1 minute: initiate meeting_join
  │     │     └── Agent dials in and begins transcription
  │     └── For events without dial-in: skip (no way to join)
  │
  └── On meeting end (scheduled time or hang-up detection):
        ├── Emit conversation.completed → pipeline processes full meeting
        ├── Generate minutes, extract tasks
        ├── Distribute minutes via email to attendees
        └── Store as episodic memory
```

### Agent Voice Personality

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

### Per-Call Cost Model

| Component | Cost | Notes |
|---|---|---|
| Twilio number rental | ~$1/month | Per number |
| Twilio inbound voice | ~$0.0085/min (US) | Varies by country |
| Twilio outbound voice | ~$0.013/min (US) | Varies by destination |
| Transcription (Deepgram) | ~$0.0043/min | Real-time streaming |
| TTS (OpenAI) | ~$0.015/1K chars | Agent speaking |
| AI processing | ~$0.01-0.05/min | Depends on model and tool calls |

#### Budget Controls

- **Per-agent monthly cap**: Max spend on VOIP per agent (e.g., $50/month)
- **Per-call cap**: Max duration per call (e.g., 60 minutes)
- **Rate limiting**: Max concurrent calls per agent (default: 1)
- **Allowlist**: Outbound calls only to approved numbers/patterns
- **Alerts**: Notify org admin when agent reaches 80% of monthly cap

All voice/model-derived costs flow into the `token_ledger` reporting layer with `operation = 'voice_call'`.

### Provider Abstraction

Twilio is the initial provider, but the architecture supports provider switching:

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
  startRecording(callSid: string): Promise<string>
  stopRecording(callSid: string): Promise<void>
}
```

Future providers: **Telnyx** (cheaper per-minute, SIP-native), **Vonage** (good EU coverage, WebRTC), **local carriers** (cheapest, per-country integration), **self-hosted FreeSWITCH/Asterisk** (full control, lowest cost, highest ops overhead).

### Multi-Provider Phasing

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

### Twilio Plugin — What Needs Implementation

1. **Voice gateway** — webhook handler for Twilio incoming/outgoing calls, WebSocket stream manager
2. **Transcription service** — audio → text pipeline with speaker diarization, pluggable ASR backends
3. **Voice agent runtime** — integration between audio stream and agent execution loop (bidirectional)
4. **Number provisioning API** — CRUD for agent VOIP identities via Twilio
5. **Recording service** — record, store, manage consent, enforce retention
6. **Calendar connector** — Google Calendar + Outlook integration for auto-join
7. **DTMF handler** — meeting code/passcode injection for conference bridge dialing
8. **Cost tracking** — per-call cost calculation and budget enforcement
9. **Provider abstraction** — interface layer to support multiple VOIP providers
10. **Voice config** — TTS voice selection, greetings, voicemail per agent

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
