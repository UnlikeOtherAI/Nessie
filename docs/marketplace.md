# Marketplace and Agent Library

One marketplace. One library. MCP servers, skills, and workflow templates are all capabilities that agents can use. The marketplace is where you discover them. The library is where you manage what's installed. The agent editor is where you assign them.

This document describes the unified experience. The underlying systems are documented separately:
- [skills.md](skills.md) — skill structure, security verification, community catalog
- [external-tool-integration.md](external-tool-integration.md) — MCP servers, credential flow, context loading
- [tool-registry-spec.md](tool-registry-spec.md) — tool registry, grants, execution enforcement

---

## 1. Unified Capability Model

From the user's perspective, there are three types of capabilities — and they all behave the same way: you find them, add them to your library, and assign them to agents.

| Capability | What It Is | Source | Example |
|---|---|---|---|
| **MCP Server** | A service that exposes tools via the MCP protocol | Marketplace catalog or self-hosted URL | "PostgreSQL", "Stripe", "GitHub" |
| **Skill** | A packaged behaviour — instructions + tools + plan | Platform, community, or org-created | "Deploy to Staging", "Generate Minutes", "Acme CRM Integration" |
| **Workflow Template** | An orchestrated pipeline: trigger + agents + skills | Platform, community, or org-created | "Sales Call Follow-Up", "Sprint Standup Pipeline" |

MCP servers expose tools. Skills use tools to accomplish tasks. Workflow templates compose skills and agents into automated pipelines.

**API Connectors** are not a separate system — they are a UI category in the marketplace. Under the hood, an API connector is a **library item that groups related tools together** with a credential binding. When you add a "Stripe API" connector, its 24 endpoints become 24 tools in the tool registry — same as MCP server tools. The execution engine handles the HTTP calls directly (no LLM overhead for the request itself). The agent just calls `stripe_create_customer` with arguments, same as any other tool. See [external-tool-integration.md § 3](external-tool-integration.md) for how the endpoint-to-tool mapping and credential injection work.

---

## 2. The Marketplace

The marketplace is a single page with tabs. Every tab has the same layout: browse, search, filter, and install.

### Marketplace Tabs

```
┌──────────────────────────────────────────────────────────────┐
│  MARKETPLACE                                                  │
│                                                                │
│  [ All ]  [ MCP Servers ]  [ API Connectors ]  [ Skills ]  [ Workflows ]     │
│                                                                │
│  Search: [_________________________________] [Filter ▾] [Sort ▾]│
│                                                                │
│  Categories: databases | devtools | crm | communication |      │
│              analytics | deployment | documentation | sales |  │
│              support | custom                                  │
│                                                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ ⬡ PostgreSQL     │  │ ◆ Deploy to     │  │ ⬢ Stripe API │ │
│  │   MCP Server     │  │   Staging        │  │   Connector  │ │
│  │                  │  │   Skill          │  │              │ │
│  │ 12 tools         │  │ Tools: Bash,     │  │ 24 endpoints │ │
│  │ ★ 4.8 (142)     │  │        WebFetch  │  │ ★ 4.6 (89)  │ │
│  │ ✓ Verified      │  │ ★ 4.9 (247)     │  │ ✓ Verified   │ │
│  │                  │  │ ✓ Verified      │  │              │ │
│  │ [+ Add to       │  │                  │  │ [+ Add to    │ │
│  │    Library]      │  │ [+ Add to       │  │    Library]  │ │
│  └──────────────────┘  │    Library]      │  └──────────────┘ │
│                        └──────────────────┘                    │
│                                                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ ⬡ GitHub         │  │ ◆ Review PR     │  │ ⬢ HubSpot   │ │
│  │   MCP Server     │  │   Skill          │  │   Connector  │ │
│  │ ...              │  │ ...              │  │ ...          │ │
│  └──────────────────┘  └──────────────────┘  └──────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Card Anatomy (Consistent Across Types)

Every capability card shows the same structure regardless of type:

```
┌────────────────────────────────────┐
│ [icon] Name                        │
│ Type badge: MCP Server | API Connector | Skill | Workflow
│                                    │
│ One-line description               │
│                                    │
│ Metadata:                          │
│   MCP Server → "12 tools"          │
│   Skill → "Tools: Bash, WebFetch"  │
│   API Connector → "24 endpoints"   │
│   Workflow → "3 steps, 2 agents"   │
│                                    │
│ Rating: ★ 4.8 (142 reviews)       │
│ Security: ✓ Verified | ⚠ Review Required | ✕ Blocked
│ Source: Platform | Community | Org  │
│                                    │
│ [+ Add to Library]                 │
└────────────────────────────────────┘
```

### Detail Page (Consistent Layout)

Clicking any card opens the detail page with the same structure:

```
┌──────────────────────────────────────────────────────────────┐
│ [icon] PostgreSQL MCP Server              [+ Add to Library] │
│ ★ 4.8 (142 reviews)  |  Platform  |  ✓ Verified             │
│                                                               │
│ TABS: [ Overview ] [ Tools/Endpoints ] [ Security ] [ Reviews ]│
│                                                               │
│ Overview:                                                     │
│   Full description, author, version, changelog                │
│   Required configuration (what you need to provide)           │
│   Dependencies (other capabilities needed)                    │
│                                                               │
│ Tools/Endpoints:                                              │
│   MCP Server → list of tools it exposes                       │
│   Skill → step-by-step plan preview                           │
│   API Connector → list of endpoints with methods              │
│                                                               │
│ Security:                                                     │
│   Security scan results                                       │
│   Risk rating                                                 │
│   Findings (if any)                                           │
│                                                               │
│ Reviews:                                                      │
│   User ratings and written reviews                            │
└──────────────────────────────────────────────────────────────┘
```

### "All" Tab — Unified Search

The "All" tab searches across all three types simultaneously. Results are ranked by relevance regardless of type. A search for "create contact" might return:

1. **Acme CRM API** (connector) — has `acme_create_contact` endpoint
2. **Sales Workflow** (skill) — creates contacts as part of a larger flow
3. **HubSpot** (MCP server) — has contact creation tools

This is the most useful view for agents and users who know what they want to accomplish but don't know which type of capability provides it.

---

## 3. The Library

The library is what the organization has installed. Marketplace items become library items when you click "Add to Library."

### Library Page

```
┌──────────────────────────────────────────────────────────────┐
│  MY LIBRARY                                                   │
│                                                                │
│  [ All ]  [ MCP Servers ]  [ API Connectors ]  [ Skills ]  [ Workflows ]     │
│                                                                │
│  Search: [_________________________________] [Filter ▾]        │
│                                                                │
│  Scope: [ Organization ▾ ]                                     │
│         (or: specific project, team, channel, user)            │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ⬡ PostgreSQL          Active    Org-wide    12/12 tools  │ │
│  │   Last used: 2h ago   ★ 4.8    Assigned to: 3 agents    │ │
│  │   [ Configure ] [ Manage Tools ] [ Assign to Agent ]      │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ◆ Deploy to Staging   Active    #engineering  v3         │ │
│  │   Last used: 1d ago   ★ 4.9    Assigned to: 2 agents    │ │
│  │   [ Edit ] [ View Runs ] [ Assign to Agent ]              │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ⬢ Acme CRM API        Active    Sales team   24 endpts  │ │
│  │   Last used: 30m ago  ★ 4.6    Assigned to: 1 agent     │ │
│  │   [ Configure ] [ Manage Endpoints ] [ Assign to Agent ]  │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ◆ Generate Minutes     Active    Org-wide    v2          │ │
│  │   Last used: 3h ago   ★ 4.7    Assigned to: 5 agents    │ │
│  │   [ View Runs ] [ Assign to Agent ]                       │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  [+ Browse Marketplace]  [+ Create Custom Connector]           │
│  [+ Create Skill]                                              │
└──────────────────────────────────────────────────────────────┘
```

### Library Item States

Every library item has a consistent state model:

```
                    ┌──────────┐
                    │ Pending  │  ← just added, needs setup/approval
                    │ Setup    │
                    └────┬─────┘
                         │ configured + approved
                         ▼
    ┌───────┐      ┌──────────┐      ┌──────────┐
    │ Error │ ◄──► │  Active   │ ──── │  Paused  │
    └───────┘      └──────────┘      └──────────┘
                         │
                         ▼
                   ┌──────────┐
                   │ Removed  │
                   └──────────┘
```

- **Pending Setup**: Added from marketplace, needs configuration (credentials, scope, approval)
- **Active**: Working, available to assigned agents
- **Paused**: Temporarily disabled by admin (agents can't use it but it's not deleted)
- **Error**: Health check failing or credential expired
- **Removed**: Uninstalled from library (agents lose access, audit trail preserved)

### Adding to Library Flow

```
User clicks [+ Add to Library] on a marketplace item
  │
  ├── MCP Server:
  │     1. Configuration modal: enter credentials, select scope
  │     2. System connects, discovers tools
  │     3. Admin reviews/approves discovered tools
  │     4. Active in library → assignable to agents
  │
  ├── Skill:
  │     1. If Platform skill: immediately active (pre-verified)
  │     2. If Community skill: enters as draft → security scan → review → active
  │     3. If Org skill (from another scope): grant created → active
  │     4. Active in library → assignable to agents
  │
  └── API Connector:
        1. Configuration modal: enter base URL, credentials, select scope
        2. If OpenAPI spec found: auto-import endpoints
        3. If not: manual endpoint definition
        4. Admin reviews endpoints, sets risk levels
        5. Active in library → assignable to agents
```

---

## 4. Agent Editor Integration

The agent editor is where you configure what capabilities an agent has. The library feeds directly into this.

### Agent Capabilities Tab

```
┌──────────────────────────────────────────────────────────────┐
│  AGENT: Sales Assistant                                       │
│                                                                │
│  [ General ] [ Capabilities ] [ Memory ] [ Policies ]          │
│                                                                │
│  CAPABILITIES                                                  │
│                                                                │
│  ┌─ Assigned from Library ──────────────────────────────────┐ │
│  │                                                          │ │
│  │  ⬡ HubSpot MCP Server                        [Remove]   │ │
│  │    Tools enabled: 8/15  [Manage ▾]                       │ │
│  │                                                          │ │
│  │  ◆ Extract Action Items                       [Remove]   │ │
│  │    v2, org-wide                                          │ │
│  │                                                          │ │
│  │  ◆ Generate Meeting Minutes                   [Remove]   │ │
│  │    v3, org-wide                                          │ │
│  │                                                          │ │
│  │  ⬢ Acme CRM API                              [Remove]   │ │
│  │    Endpoints enabled: 12/24  [Manage ▾]                  │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─ Inherited from Role: "sales-agent" ─────────────────────┐ │
│  │                                                          │ │
│  │  ◆ Summarize Email Thread          (from role, read-only)│ │
│  │  ⬡ Slack MCP Server                (from role, read-only)│ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─ Available from Scope (channel/team/project) ────────────┐ │
│  │                                                          │ │
│  │  ◆ Sales Playbook             #sales-team    [+ Assign]  │ │
│  │  ⬢ Salesforce API             sales-project  [+ Assign]  │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  [+ Add from Library]  [+ Browse Marketplace]                  │
└──────────────────────────────────────────────────────────────┘
```

### Capability Assignment

Three sources for an agent's capabilities:

1. **Direct assignment**: Admin explicitly assigns a library item to this agent
2. **Role inheritance**: Agent's role includes certain capabilities (read-only in agent editor, managed at role level)
3. **Scope availability**: Capabilities shared to the agent's channel/team/project are available but not auto-assigned — admin opts in per agent

### Per-Agent Capability Configuration

When assigning a capability to an agent, the admin can configure:

**For MCP Servers:**
- Which tools from the server are enabled (checkbox per tool)
- Per-tool config overrides (timeouts, rate limits)
- Credential override (use agent-specific or personal credentials instead of org default)

**For Skills:**
- Input parameter defaults (pre-fill common values)
- Execution constraints (max duration, approval required)
- Auto-execute triggers (run this skill automatically on certain events)

**For API Connectors:**
- Which endpoints are enabled (checkbox per endpoint)
- Per-endpoint config overrides
- Credential override

---

## 5. Unified Data Model

Under the hood, all three capability types register into the same tool registry. The library is a view over this.

### Library Item Table

```
library_items
  id               UUID PK
  organization_id  UUID FK → organizations
  
  -- What this is
  item_type        TEXT — "mcp_server" | "api_connector" | "skill" | "workflow"
  item_id          UUID — FK to mcp_server_instances, api_connectors, skills, or workflow_templates
  -- NOTE: MCP servers and API connectors both produce tools in the tool registry.
  -- API connectors are backed by endpoint-to-tool mappings (see external-tool-integration.md § 3),
  -- not a separate connector system. They exist as a marketplace category for discoverability.
  
  -- Marketplace source
  catalog_ref      TEXT — marketplace catalog ID (null if org-created)
  
  -- Scoping
  scope_type       TEXT — "system" | "organization" | "project" | "team" | "channel" | "user"
  scope_id         TEXT
  
  -- State
  status           ENUM (pending_setup, active, paused, error, removed)
  error_message    TEXT
  
  -- Display
  name             TEXT
  description      TEXT
  icon_url         TEXT
  category         TEXT
  tags             TEXT[]
  
  -- Stats
  assigned_agent_count INT DEFAULT 0
  last_used_at     TIMESTAMPTZ
  
  -- Metadata
  installed_by     UUID FK → users
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([organization_id, item_type, item_id])
  @@index([organization_id, status])
  @@index([organization_id, scope_type, scope_id])
```

### Unified Assignment Table

```
capability_assignments
  id               UUID PK
  library_item_id  UUID FK → library_items
  
  -- Target
  target_type      TEXT — "agent" | "role"
  target_id        UUID
  
  -- Config
  enabled_tools    TEXT[] — which tools/endpoints are enabled (null = all)
  config_overrides JSONB — per-assignment configuration
  credential_ref   TEXT — override credential (null = use library item default)
  
  -- State
  enabled          BOOLEAN DEFAULT true
  
  assigned_by      UUID FK → users
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([library_item_id, target_type, target_id])
```

For skills specifically, the `skill_assignments` table in skills.md provides additional per-agent config overrides. `capability_assignments` is the unified model; `skill_assignments` extends it with skill-specific fields (config_overrides, enabled flag).

### How It Connects

```
Marketplace catalog
  │
  ├── User clicks "Add to Library"
  │   → Creates: library_items row (status: pending_setup)
  │   → Creates: underlying record (mcp_server_instances, api_connectors, skills, or workflow_templates)
  │
  ├── Admin configures + approves
  │   → library_items status: active
  │   → Tools registered in ToolRegistryEntry
  │
  ├── Admin assigns to agent
  │   → Creates: capability_assignments row
  │   → Creates: ToolGrant rows for each enabled tool
  │
  └── Agent uses capability
      → Agent discovers via Tier 1 directory
      → Loads via load_tools / load_skill
      → Executes
      → Outcome → procedural memory
```

---

## 6. Marketplace API

### Browsing

```
GET /api/marketplace
  ?type=mcp_server|api_connector|skill|workflow — filter by type
  &category=devtools                        — filter by category
  &q=search+terms                           — full-text + semantic search
  &source=platform|community|org            — filter by source
  &sort=popular|rating|newest|most_used     — sort order
  &limit=25&cursor=...                      — pagination

Response: {
  items: [
    {
      id: "uuid",
      type: "mcp_server",
      name: "PostgreSQL",
      description: "...",
      category: "databases",
      source: "platform",
      rating: 4.8,
      review_count: 142,
      security_status: "verified",
      metadata: {
        tool_count: 12,         // MCP server
        // or: required_tools: [...],  // skill
        // or: endpoint_count: 24,     // API connector
      }
    },
    ...
  ],
  pagination: { cursor: "...", total: 47 }
}
```

### Library Management

```
POST   /api/library                         — add marketplace item to library
GET    /api/library                         — list library items
GET    /api/library/{id}                    — get library item detail
PATCH  /api/library/{id}                    — update config/status
DELETE /api/library/{id}                    — remove from library (soft delete)

POST   /api/library/{id}/assign             — assign to agent/role
DELETE /api/library/{id}/assign/{aid}        — remove assignment
GET    /api/library/{id}/assignments         — list assignments

GET    /api/agents/{id}/capabilities         — all capabilities for an agent (unified view)
```

---

## 7. Design Principles

### 1. One marketplace, consistent UX
Users don't care about the technical distinction between MCP servers, API connectors, skills, and workflows. They care about what they can do. The marketplace presents all capabilities uniformly. MCP servers and API connectors are both "apps that provide tools" — the difference is just how they connect (standardized protocol vs HTTP endpoint definitions). Both produce tools in the same registry.

### 2. Library is the gate
Nothing reaches an agent without going through the library. The library is where scoping, configuration, approval, and credential management happen. The marketplace is just discovery.

### 3. Agent editor is assignment
The agent editor doesn't install or configure capabilities — it assigns library items to agents and optionally narrows which tools/endpoints are enabled. Configuration lives at the library level.

### 4. Security is consistent
Every capability type goes through the same security pipeline. MCP servers have their tools scanned. Skills go through the 4-stage verification. API connectors have their endpoints risk-classified. The security tab on the detail page shows the same structure regardless of type.

### 5. Scope flows down, assignment is explicit
Library items are scoped (system/organization/project/team/channel/user). An agent in scope can see available capabilities. But seeing is not having — capabilities must be explicitly assigned to an agent before the agent can use them. Scope makes them available; assignment makes them active.

---

## 8. Workflow Templates

Workflow templates are the highest-level capability in the marketplace. While MCP servers, skills, and API connectors give agents individual capabilities, workflow templates wire everything together into end-to-end automated pipelines.

### What a Workflow Template Is

A workflow template is a blueprint that combines:
- **Trigger(s)** — what event starts the workflow
- **Steps** — an ordered sequence of agent tasks, each using skills and/or tools
- **Routing** — which agent handles each step (or "best available")
- **Connectors** — which MCP servers / API connectors the workflow requires
- **Variables** — typed workflow inputs and resource selectors resolved at install time or run time
- **Execution environments** — optional VM/container/workspace templates for coding, triage, test, and deploy steps
- **Output actions** — what happens when the workflow completes

### Workflow Template Schema

```
workflow_templates
  id               UUID PK
  organization_id  UUID FK → organizations
  
  name             TEXT
  description      TEXT
  version          INT
  status           ENUM (draft, testing, active, paused, deprecated, archived)
  
  -- The blueprint
  triggers         JSONB — array of trigger definitions (event type + conditions)
  steps            JSONB — ordered execution steps (see below)
  
  -- Dependencies
  required_skills  TEXT[] — skills this workflow uses
  required_tools   TEXT[] — tools needed (from MCP servers or connectors)
  required_connectors TEXT[] — connectors by slug
  required_environment_templates TEXT[] — environment templates by slug
  
  -- Typed variables / bindings
  variable_schema  JSONB — typed workflow variables and selectors
  binding_schema   JSONB — constrained bindings to installed capabilities/resources

  -- Configuration
  default_config   JSONB — default parameters for the workflow
  config_schema    JSONB — JSON Schema for configurable parameters
  
  -- Security
  security_scan_id UUID FK → skill_security_scans (same scan pipeline as skills)
  risk_level       TEXT — "low" | "medium" | "high"
  
  -- Metadata
  category         TEXT
  tags             TEXT[]
  author_id        UUID FK → users
  source           TEXT — "platform" | "community" | "org"
  
  -- Stats
  run_count        INT DEFAULT 0
  success_rate     FLOAT
  avg_duration_s   FLOAT
  last_run_at      TIMESTAMPTZ
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([organization_id, name])
```

### Step Definition

Each step in a workflow defines what happens:

```typescript
type WorkflowStep = {
  id: string                     // unique step identifier
  name: string                   // "Extract action items"
  order: number                  // execution order (steps with same order run in parallel)
  
  // What to execute
  type: "skill" | "agent_task" | "action" | "condition" | "wait"
  
  // For type: "skill"
  skill_name?: string            // which skill to run
  skill_input?: Record<string, unknown>  // parameters (can reference prior step outputs)
  
  // For type: "agent_task"
  agent_id?: string              // specific agent, or null for intelligent routing
  agent_role?: string            // route to any agent with this role
  task_description?: string      // what the agent should do
  
  // For type: "action"
  action_type?: string           // "send_email" | "create_task" | "update_crm" | "post_message"
  action_config?: Record<string, unknown>
  
  // For type: "condition"
  condition?: {                  // branch based on prior step output
    field: string                // e.g., "steps.extract_items.output.action_count"
    operator: "eq" | "gt" | "lt" | "contains" | "exists"
    value: unknown
    then_step: string            // step ID to jump to if true
    else_step?: string           // step ID if false (or skip to next)
  }
  
  // For type: "wait"
  wait_config?: {
    duration_minutes?: number    // wait N minutes
    until_event?: string         // wait for specific event type
    timeout_minutes?: number     // max wait time before failing
  }
  
  // Error handling
  on_failure: "stop" | "skip" | "retry" | "fallback"
  retry_count?: number
  fallback_step?: string         // step ID to run on failure
  
  // Output
  output_key?: string            // key name for this step's output (referenced by later steps)
}
```

### Typed Variables and Secure Resource Selection

Workflow configuration must not rely on arbitrary free-text identifiers for sensitive resources. A workflow needs typed variables that resolve only to resources already visible to the installing user and already allowed by scope/policy.

Use two layers:

- `variable_schema`: typed values used by the workflow at runtime
- `binding_schema`: constrained selectors that bind a workflow to installed connectors, repos, boards, mailboxes, environment templates, channels, and secret refs

Example variable kinds:

- `string`, `number`, `boolean`
- `enum`
- `json`
- `secret_ref`
- `connector_ref`
- `connector_resource_ref`
- `environment_template_ref`
- `agent_ref`
- `channel_ref`
- `repo_ref`

Example binding rule:

- A `repo_ref` for GitHub is not entered as free text
- The install UI queries the assigned GitHub connector under the current actor context
- The user can only pick repositories the connector can already see and the current policy allows
- The saved binding stores provider metadata such as `{ connector_slug, external_id, display_name }`, not arbitrary text

This is how workflows stay universal while still secure:

- the template declares what kind of thing it needs
- the install flow resolves candidates from assigned capabilities
- the user selects from an allowlisted set
- runtime uses the saved binding, not fresh free-text input

Example schema:

```json
{
  "variable_schema": {
    "type": "object",
    "properties": {
      "target_repo": {
        "type": "repo_ref",
        "provider": "github",
        "source": "connector_binding",
        "description": "Repository the workflow may act on"
      },
      "issue_label_to_start_fix": {
        "type": "string",
        "default": "do-pr"
      },
      "customer_contact": {
        "type": "connector_resource_ref",
        "provider": "crm",
        "resource_type": "contact"
      },
      "coding_environment": {
        "type": "environment_template_ref",
        "capabilities": ["shell", "git", "node", "codex"]
      }
    },
    "required": ["target_repo", "coding_environment"]
  }
}
```

### Execution Environment Bindings

Workflow steps may request interactive or non-interactive execution environments:

- `localhost` folder/process
- `docker` container
- cloud VM or job provider such as GCE, EC2, or Droplet

The workflow never hardcodes provider credentials or raw machine IDs. It binds to an allowed environment template and launches an instance through the platform.

Environment bindings should support:

- template selection from visible environment templates
- provider-neutral capability requirements
- secret ref attachments as explicit bindings
- terminal/SSH observability where enabled
- ephemeral lease + teardown policy

Secret injection must use secret refs, not plaintext:

- workflow stores `secret_ref` bindings
- launch resolves them at attach time
- secrets may be mounted as env vars, files, SSH keys, or cloud credentials
- audit logs record the binding and mount target, never the secret value

### Example: Sales Call Follow-Up Workflow

```json
{
  "name": "Sales Call Follow-Up",
  "description": "After a sales call completes, extract action items, update CRM, send follow-up email, and schedule next meeting",
  
  "triggers": [
    {
      "event_type": "conversation.completed",
      "source_filter": ["twilio", "zoom"],
      "conditions": {
        "conversation_type": ["call", "meeting"],
        "has_external_participants": true
      }
    }
  ],
  
  "steps": [
    {
      "id": "generate_minutes",
      "name": "Generate meeting minutes",
      "order": 1,
      "type": "skill",
      "skill_name": "generate-minutes",
      "skill_input": { "transcript": "{{trigger.conversation}}" },
      "on_failure": "stop",
      "output_key": "minutes"
    },
    {
      "id": "extract_items",
      "name": "Extract action items",
      "order": 1,
      "type": "skill",
      "skill_name": "extract-action-items",
      "skill_input": { "transcript": "{{trigger.conversation}}" },
      "on_failure": "skip",
      "output_key": "action_items"
    },
    {
      "id": "check_items",
      "name": "Check if there are action items",
      "order": 2,
      "type": "condition",
      "condition": {
        "field": "steps.extract_items.output.count",
        "operator": "gt",
        "value": 0,
        "then_step": "update_crm",
        "else_step": "send_minutes"
      }
    },
    {
      "id": "update_crm",
      "name": "Update CRM with call notes and action items",
      "order": 3,
      "type": "agent_task",
      "agent_role": "sales-assistant",
      "task_description": "Update the CRM deal record with call notes and action items: {{steps.minutes.output}} / {{steps.action_items.output}}",
      "on_failure": "skip",
      "output_key": "crm_update"
    },
    {
      "id": "schedule_followup",
      "name": "Schedule follow-up meeting",
      "order": 3,
      "type": "action",
      "action_type": "create_calendar_event",
      "action_config": {
        "title": "Follow-up: {{trigger.conversation.title}}",
        "attendees": "{{trigger.conversation.participants}}",
        "when": "next_available_slot",
        "duration_minutes": 30
      },
      "on_failure": "skip"
    },
    {
      "id": "send_minutes",
      "name": "Email minutes to participants",
      "order": 4,
      "type": "action",
      "action_type": "send_email",
      "action_config": {
        "to": "{{trigger.conversation.participants[role=internal].email}}",
        "subject": "Minutes: {{trigger.conversation.title}}",
        "body": "{{steps.minutes.output.formatted}}"
      },
      "on_failure": "retry",
      "retry_count": 2
    }
  ],
  
  "required_skills": ["generate-minutes", "extract-action-items"],
  "required_connectors": ["crm", "email", "calendar"],
  "category": "sales",
  "tags": ["sales", "follow-up", "crm", "meetings"]
}
```

### Example: Sprint Standup Pipeline

```json
{
  "name": "Sprint Standup Pipeline",
  "description": "After standup meeting, generate notes, create tasks for blockers, and post summary to team channel",
  
  "triggers": [
    {
      "event_type": "conversation.completed",
      "conditions": {
        "conversation_type": ["meeting"],
        "metadata.title_contains": ["standup", "daily sync", "daily scrum"]
      }
    }
  ],
  
  "steps": [
    {
      "id": "summarize",
      "name": "Generate standup summary",
      "order": 1,
      "type": "agent_task",
      "agent_role": "meeting-assistant",
      "task_description": "Summarize this standup. For each participant: what they did yesterday, what they're doing today, any blockers.",
      "output_key": "summary"
    },
    {
      "id": "extract_blockers",
      "name": "Extract blockers as tasks",
      "order": 2,
      "type": "skill",
      "skill_name": "extract-action-items",
      "skill_input": { "transcript": "{{trigger.conversation}}", "filter": "blockers" },
      "on_failure": "skip",
      "output_key": "blockers"
    },
    {
      "id": "create_tickets",
      "name": "Create Jira tickets for blockers",
      "order": 3,
      "type": "action",
      "action_type": "create_task",
      "action_config": {
        "system": "jira",
        "project": "{{config.jira_project}}",
        "items": "{{steps.blockers.output}}"
      },
      "on_failure": "skip"
    },
    {
      "id": "post_summary",
      "name": "Post summary to team channel",
      "order": 4,
      "type": "action",
      "action_type": "post_message",
      "action_config": {
        "channel": "{{config.team_channel}}",
        "message": "{{steps.summary.output.formatted}}"
      },
      "on_failure": "retry",
      "retry_count": 1
    }
  ],
  
  "required_skills": ["extract-action-items"],
  "required_connectors": ["jira", "slack"],
  "config_schema": {
    "type": "object",
    "properties": {
      "jira_project": { "type": "string", "description": "Jira project key for blocker tickets" },
      "team_channel": { "type": "string", "description": "Slack channel for standup summaries" }
    },
    "required": ["jira_project", "team_channel"]
  }
}
```

### Example: GitHub Issue Triage → Fix → Customer Follow-Up

This is the canonical software-delivery workflow template:

1. GitHub issue webhook arrives
2. Triage agent classifies the issue and attempts repro in a disposable environment
3. Agent comments back with findings and labels the issue
4. User applies `do-pr`
5. Fix agent launches a coding environment, implements the fix, and opens a PR
6. PR merge event fires
7. Customer-facing agent sends a tailored notification through email/CRM/helpdesk

Example shape:

```json
{
  "name": "Issue Triage to PR to Customer Follow-Up",
  "required_connectors": ["github", "email", "crm"],
  "required_environment_templates": ["coding-vm"],
  "variable_schema": {
    "type": "object",
    "properties": {
      "target_repo": {
        "type": "repo_ref",
        "provider": "github",
        "source": "connector_binding"
      },
      "triage_label_bug": { "type": "string", "default": "bug" },
      "triage_label_needs_info": { "type": "string", "default": "needs-info" },
      "fix_label": { "type": "string", "default": "do-pr" },
      "coding_environment": {
        "type": "environment_template_ref",
        "capabilities": ["shell", "git", "codex", "claude"]
      },
      "notify_channel": {
        "type": "channel_ref"
      }
    },
    "required": ["target_repo", "coding_environment"]
  },
  "triggers": [
    {
      "event_type": "github.issue.opened"
    },
    {
      "event_type": "github.issue.labeled",
      "conditions": {
        "label": "{{config.fix_label}}"
      }
    },
    {
      "event_type": "github.pull_request.merged"
    }
  ],
  "steps": [
    {
      "id": "triage_issue",
      "type": "agent_task",
      "agent_role": "issue-triage",
      "task_description": "Assess the issue, decide whether it is a real bug, and decide whether repro is required.",
      "output_key": "triage"
    },
    {
      "id": "launch_triage_env",
      "type": "action",
      "action_type": "launch_environment",
      "action_config": {
        "template": "{{config.coding_environment}}",
        "mode": "ephemeral",
        "attach_secrets": ["github_token_ref", "package_registry_ref"]
      },
      "output_key": "triage_env"
    },
    {
      "id": "attempt_repro",
      "type": "agent_task",
      "agent_role": "issue-triage",
      "task_description": "Use the launched environment to reproduce the issue and capture exact findings.",
      "output_key": "repro"
    },
    {
      "id": "comment_and_label",
      "type": "action",
      "action_type": "github_issue_update",
      "action_config": {
        "repo": "{{config.target_repo}}",
        "comment": "{{steps.repro.output.summary}}",
        "labels": "{{steps.triage.output.labels}}"
      }
    },
    {
      "id": "fix_and_open_pr",
      "type": "agent_task",
      "agent_role": "issue-fixer",
      "task_description": "When the fix label arrives, use a coding environment to implement the fix, run checks, and open a PR.",
      "output_key": "fix_result"
    },
    {
      "id": "notify_customer",
      "type": "action",
      "action_type": "send_customer_update",
      "action_config": {
        "issue_repo": "{{config.target_repo}}",
        "message": "We fixed the issue you reported. A build will be with you shortly."
      }
    }
  ]
}
```

### Installing a Workflow Template

```
User clicks [+ Add to Library] on a workflow template
  │
  ├── 1. Dependency check:
  │     ├── Are all required_skills in the library? If not → "Install these skills first: ..."
  │     ├── Are all required_connectors in the library? If not → "Install these connectors first: ..."
  │     └── Are all required_tools available? If not → "Missing tools: ..."
  │
  ├── 2. Configuration:
  │     ├── Show config_schema form (e.g., "Which Jira project?", "Which Slack channel?")
  │     ├── Show typed selectors from variable_schema / binding_schema
  │     ├── User picks from allowed resources already visible through assigned connectors and scope
  │     ├── User fills in non-sensitive workflow parameters
  │     └── Select scope (which agents/teams this workflow applies to)
  │
  ├── 3. Trigger registration:
  │     ├── For each trigger in the template → create workflow_triggers record
  │     │   (see conversation-intelligence-platform.md § 4)
  │     └── Triggers are initially disabled until admin activates
  │
  ├── 4. Security scan:
  │     ├── Workflow steps scanned same as skill instructions
  │     ├── Cross-step data flow analyzed for leaks (does data flow to unexpected places?)
  │     ├── External action targets validated
  │     └── Variable bindings verified: no unresolved free-text bindings for protected resources
  │
  ├── 5. Review + activate:
  │     ├── Admin reviews workflow steps, triggers, and security scan
  │     ├── Activates → triggers become live
  │     └── Workflow runs automatically when triggers fire
  │
  └── 6. Monitoring:
        ├── Each workflow run creates a parent task with child tasks per step
        ├── Visible in workflow run history
        └── Stats feed back into marketplace ratings
```

### Workflow vs Skill

| | Skill | Workflow Template |
|---|---|---|
| **Scope** | Single agent performs a task | Multiple agents, triggers, and actions orchestrated |
| **Trigger** | Agent decides to use it | Automatic — event-driven via trigger system |
| **Dependencies** | Requires tools | Requires skills + tools + connectors |
| **Execution** | Agent follows instructions | Platform orchestrates step-by-step |
| **Configuration** | Input parameters | Org-specific config (channels, projects, systems) |
| **Example** | "Extract action items from a transcript" | "When a sales call ends, extract items, update CRM, email participants, schedule follow-up" |

Skills are building blocks. Workflow templates compose them into automated pipelines.

### Workflow Template API

```
POST   /api/workflows                       — create workflow template
GET    /api/workflows                       — list workflows
GET    /api/workflows/{id}                  — get workflow detail
PATCH  /api/workflows/{id}                  — update workflow
DELETE /api/workflows/{id}                  — archive workflow

POST   /api/workflows/{id}/activate         — enable triggers
POST   /api/workflows/{id}/pause            — disable triggers
POST   /api/workflows/{id}/run              — manual trigger (for testing)

GET    /api/workflows/{id}/runs             — execution history
GET    /api/workflows/{id}/runs/{rid}       — specific run detail with step results
```

---

## What Needs Full Design

1. **Marketplace search ranking** — how to rank results across three different capability types in a single search
2. **Capability recommendations** — "agents like yours also use..." based on role, existing capabilities, and usage patterns
3. **Bulk assignment** — assign a capability to all agents with a certain role in one action
4. **Capability bundles** — pre-packaged sets of MCP servers + skills + connectors for common use cases ("Sales Bundle", "DevOps Bundle")
5. **Version update notifications** — when a marketplace item has a new version, notify library owners
6. **Usage analytics dashboard** — per-capability usage, cost, success rate, agent adoption
7. **Capability conflict detection** — two library items that provide overlapping tools (e.g., two CRM connectors)
8. **Offline/degraded mode** — what happens to assigned capabilities when the underlying service is down
9. **Marketplace vendor portal** — for third-party developers to publish and manage their marketplace listings
10. **Capability cost estimation** — before adding to library, show estimated monthly cost based on org size and usage patterns
