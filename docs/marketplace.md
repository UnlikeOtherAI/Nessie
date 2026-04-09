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

Workflow templates are the highest-level capability in the marketplace. The detailed schema, variable/binding model, execution environment bindings, cost ledger, installation flow, and example workflows now live in:

- [workflow-templates.md](./marketplace/workflow-templates.md)

Keep `marketplace.md` as the top-level capability/index document. Keep workflow-specific implementation detail in the companion doc.

## 9. Generated Plugins

Generated plugins are now documented in a dedicated companion doc:

- [generated-plugins.md](./marketplace/generated-plugins.md)

Keep `marketplace.md` as the overview, and keep generated-plugin lifecycle, schema, builder system, sandboxing, and review flow in the companion doc.

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
