# External Tool Integration

How Nessie agents connect to third-party services — both MCP servers and arbitrary APIs — without writing code, without seeing credentials, and without permanently consuming context window space.

Related documents:
- [the-agents.md](the-agents.md) — agent architecture, tool policy, execution loop
- [marketplace.md](marketplace.md) — unified marketplace, library, agent editor integration
- [tool-registry-spec.md](tool-registry-spec.md) — tool registry, grants, bundles, prompt layers
- [secret-management-spec.md](secret-management-spec.md) — credential storage, scoping, resolution
- [multi-agent-memory-system.md](multi-agent-memory-system.md) — procedural memory, outcome tracking
- [conversation-intelligence-platform.md](conversation-intelligence-platform.md) — plugin architecture

---

## 1. Two Integration Paths

Agents need access to external services. There are exactly two paths:

| Path | Interface | Config Model | Use Case |
|---|---|---|---|
| **MCP Server** | Standardized MCP protocol (JSON-RPC 2.0) | Install from marketplace or URL → configure auth → grant to agents | Third-party tools with MCP support (databases, APIs, SaaS tools) |
| **Custom API Connector** | REST/GraphQL endpoint definitions stored in DB | Define endpoints + auth + schemas in UI → system generates tool interface | Any HTTP API without MCP support |

Both paths produce the same thing: a `ToolRegistryEntry` with `source = 'mcp-remote'` or `source = 'custom'` that agents can discover, load, use, and unload like any other tool.

---

## 2. MCP Server Integration

### MCP Marketplace

Nessie hosts a catalog of verified MCP servers that organizations can install with one click.

```
mcp_catalog
  id               UUID PK
  name             TEXT — "PostgreSQL", "Stripe", "GitHub", "Jira"
  slug             TEXT UNIQUE — "postgresql", "stripe", "github", "jira"
  description      TEXT
  vendor           TEXT — who published this
  version          TEXT — current version
  
  protocol         TEXT — "stdio" | "http" | "sse"
  package_url      TEXT — npm package, Docker image, or binary URL
  config_schema    JSONB — JSON Schema for what the org needs to provide
  auth_methods     TEXT[] — ["api_key", "oauth2", "basic", "bearer", "none"]
  
  capabilities     TEXT[] — tool names this server exposes
  capability_count INT
  
  verified         BOOLEAN DEFAULT false — Nessie team has reviewed
  featured         BOOLEAN DEFAULT false
  category         TEXT — "database", "crm", "devtools", "communication", "analytics", "custom"
  tags             TEXT[]
  
  documentation_url TEXT
  icon_url         TEXT
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

Catalog entries are read-only global data. Organizations install from the catalog into their own environment.

### MCP Server Installation

When an org installs an MCP server:

```
mcp_server_instances
  id               UUID PK
  organization_id  UUID FK → organizations
  catalog_id       UUID FK → mcp_catalog (nullable — null for custom/self-hosted)
  
  name             TEXT — display name for this instance
  slug             TEXT — org-unique identifier
  
  -- Connection
  protocol         TEXT — "stdio" | "http" | "sse"
  endpoint         TEXT — URL, command, or container reference
  transport_config JSONB — protocol-specific config (timeouts, headers, etc.)
  
  -- Authentication
  auth_method      TEXT — "api_key" | "oauth2" | "basic" | "bearer" | "none"
  credential_ref   TEXT — secretRef from secret-management-spec.md (NEVER plaintext)
  
  -- Scoping
  scope_type       TEXT — "organization" | "project" | "team" | "channel" | "personal"
  scope_id         TEXT — the specific scope entity ID
  installed_by     UUID FK → users
  
  -- State
  status           ENUM (active, paused, error, pending_setup, pending_approval)
  health_status    ENUM (healthy, degraded, down, unknown)
  last_health_at   TIMESTAMPTZ
  error_message    TEXT
  
  -- Tool discovery cache
  discovered_tools JSONB — cached output of tools/list call
  tools_refreshed_at TIMESTAMPTZ
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([organization_id, slug])
  @@index([organization_id, scope_type, scope_id])
```

### Scoping Rules

MCP servers are installed at a scope level. Agents can only use servers visible at their scope or above.

```
Scope hierarchy (most restrictive → least restrictive):
  personal → channel → team → project → organization

Rules:
  - "organization" scope → all agents in the org can discover this server
  - "project" scope → only agents bound to that project
  - "team" scope → only agents bound to that team
  - "channel" scope → only agents in that channel
  - "personal" scope → only one specific user's agents

An agent sees the UNION of all servers visible at its scope level and above.

Example:
  Agent bound to #sales-team channel sees:
  - All organization-scoped servers (e.g., "GitHub" for the whole org)
  - All team-scoped servers for the sales team (e.g., "Salesforce" for sales)
  - All channel-scoped servers for #sales-team (e.g., "HubSpot" for that channel)
  - NOT personal servers belonging to individual users
  - NOT servers scoped to other teams/channels
```

### Installation Flow

```
1. User browses MCP marketplace in admin UI
   │
   ├── 2. Selects "Stripe" → sees config_schema requirements:
   │     { api_key: { type: "string", description: "Stripe secret key" } }
   │
   ├── 3. User enters credentials via secure modal (secret-management-spec.md § 3)
   │     → System stores as SecretStorageRecord, returns secretRef
   │     → Credential never touches agent context or chat
   │
   ├── 4. User selects scope: "organization" (all agents can use Stripe)
   │
   ├── 5. System creates mcp_server_instances record
   │     credential_ref = "secret_stripe_abc123"
   │
   ├── 6. System connects to MCP server, calls tools/list
   │     → Discovers available tools: "stripe_create_customer", "stripe_list_charges", etc.
   │     → Caches in discovered_tools JSONB
   │
   ├── 7. For each discovered tool, system creates a ToolRegistryEntry:
   │     source = 'mcp-remote'
   │     transport = 'mcp'
   │     transportConfig = { serverId: instance.id, toolName: "stripe_create_customer" }
   │     status = 'pending_review' (default — admin must approve before agents can use)
   │
   └── 8. Admin approves tools → status becomes 'active'
         Agents can now discover and use these tools
```

### Self-Hosted MCP Servers

Organizations can connect MCP servers not in the marketplace:

```
POST /api/mcp-servers
{
  "name": "Internal Analytics DB",
  "protocol": "http",
  "endpoint": "https://mcp.internal.company.com/analytics",
  "auth_method": "bearer",
  "credential_ref": "secret_analytics_token_xyz",
  "scope_type": "project",
  "scope_id": "project-uuid-123"
}
```

Same flow as marketplace install, but no catalog_id. The system still discovers tools, creates registry entries, and requires approval.

### MCP Server Lifecycle

```
pending_setup → active → paused → active (or) → error
                  │                                 │
                  └─ deprovisioned                   └─ auto-retry 3x → paused
```

Health checks run every 5 minutes. If a server fails 3 consecutive health checks, it moves to `error` and its tools are temporarily unavailable. The system retries, and if the server recovers, tools become available again without admin intervention.

---

## 3. Custom API Connector Builder

For services without MCP support, agents need to call arbitrary HTTP APIs. The connector builder lets admins define API endpoints entirely in the database — no code required.

### API Connector Definition

```
api_connectors
  id               UUID PK
  organization_id  UUID FK → organizations
  
  name             TEXT — "Acme CRM API", "Internal Billing Service"
  slug             TEXT
  description      TEXT
  base_url         TEXT — "https://api.acme.com/v2"
  
  -- Authentication
  auth_method      TEXT — "api_key" | "oauth2" | "basic" | "bearer" | "custom_header" | "none"
  auth_config      JSONB — method-specific config (header name, token placement, etc.)
  credential_ref   TEXT — secretRef (NEVER plaintext)
  
  -- Scoping (same as MCP servers)
  scope_type       TEXT — "organization" | "project" | "team" | "channel" | "personal"
  scope_id         TEXT
  
  -- Default request config
  default_headers  JSONB — { "Content-Type": "application/json", "X-Custom": "value" }
  timeout_ms       INT DEFAULT 30000
  retry_count      INT DEFAULT 0
  rate_limit       JSONB — { "requests_per_minute": 60 }
  
  status           ENUM (active, paused, error, pending_setup)
  created_by       UUID
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([organization_id, slug])
```

### Endpoint Definitions

Each connector has one or more endpoints, each becoming a tool:

```
api_connector_endpoints
  id               UUID PK
  connector_id     UUID FK → api_connectors
  
  name             TEXT — "Create Contact", "List Invoices", "Get Deal"
  tool_name        TEXT — "acme_create_contact" (auto-generated or manual)
  description      TEXT — what this endpoint does (becomes tool description)
  
  -- HTTP definition
  method           TEXT — "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  path             TEXT — "/contacts" or "/contacts/{id}" (path params use {name} syntax)
  
  -- Parameters
  path_params      JSONB — JSON Schema for URL path parameters
  query_params     JSONB — JSON Schema for query string parameters
  request_body     JSONB — JSON Schema for request body (POST/PUT/PATCH)
  response_schema  JSONB — JSON Schema for expected response (for output validation)
  
  -- Request overrides
  headers          JSONB — endpoint-specific headers (merged with connector defaults)
  timeout_ms       INT — override connector default
  
  -- Documentation for the agent
  usage_notes      TEXT — "Use this to create a new contact. Requires at least email or phone."
  example_request  JSONB — example input for the agent
  example_response JSONB — example output so the agent knows what to expect
  
  -- Risk classification
  risk_level       TEXT — "low" | "medium" | "high"
  requires_approval BOOLEAN DEFAULT false — high-risk endpoints need human approval before execution
  
  -- State
  enabled          BOOLEAN DEFAULT true
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@unique([connector_id, tool_name])
```

### How Endpoints Become Tools

Each enabled endpoint is automatically registered as a `ToolRegistryEntry`:

```
api_connector_endpoints row:
  name: "Create Contact"
  tool_name: "acme_create_contact"
  method: POST
  path: "/contacts"
  request_body: { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] }

  ↓ generates ↓

ToolRegistryEntry:
  toolName: "acme_create_contact"
  label: "Create Contact"
  overview: "Create a new contact in Acme CRM"
  source: "custom"
  transport: "http"
  transportConfig: {
    connectorId: "uuid",
    endpointId: "uuid",
    method: "POST",
    path: "/contacts"
  }
  inputSchema: { ... merged path_params + query_params + request_body ... }
  outputSchema: { ... response_schema ... }
```

The agent sees `acme_create_contact` as a tool with an input schema. It calls the tool with arguments. The execution engine:

1. Resolves the connector's `credential_ref` via the secret management system
2. Builds the HTTP request (URL, headers, auth, body) from the endpoint definition
3. Injects the resolved credential into the appropriate location (header, query, body)
4. Makes the HTTP call
5. Returns the response to the agent
6. Immediately erases the resolved credential from memory

The agent never sees the API key. It sees: "I called `acme_create_contact` with `{email: "...", name: "..."}` and got back `{id: "...", status: "created"}`."

### Authentication Methods

```
auth_method: "api_key"
auth_config: { 
  placement: "header",     // "header" | "query" | "body"
  key_name: "X-API-Key"   // header name, query param name, or body field
}
→ System resolves credential_ref, injects value into specified location

auth_method: "bearer"
auth_config: {}
→ System resolves credential_ref, sends as "Authorization: Bearer {value}"

auth_method: "basic"
auth_config: {}
→ credential_ref points to secret with format "username:password"
→ System resolves, base64 encodes, sends as "Authorization: Basic {encoded}"

auth_method: "oauth2"
auth_config: {
  token_url: "https://api.acme.com/oauth/token",
  grant_type: "client_credentials",
  client_id_ref: "secret_acme_client_id",    // secretRef
  client_secret_ref: "secret_acme_client_secret",  // secretRef
  scopes: ["contacts.read", "contacts.write"]
}
→ System handles token lifecycle: request, cache, refresh, retry on 401

auth_method: "custom_header"
auth_config: {
  headers: {
    "X-App-ID": "literal-value",           // literal values allowed
    "X-App-Secret": "{{credential_ref}}"   // resolved from secret store
  }
}
→ Template interpolation for multi-header auth patterns
```

### Connector Builder UI Flow

```
1. Admin clicks "New API Connector"
   │
   ├── 2. Enters base URL and name
   │     System probes for OpenAPI/Swagger spec at common paths:
   │     /openapi.json, /swagger.json, /api-docs, /.well-known/openapi
   │
   ├── 3a. If OpenAPI spec found:
   │     ├── Parse spec → auto-generate all endpoint definitions
   │     ├── Show endpoint list for review
   │     ├── Admin enables/disables specific endpoints
   │     ├── Admin sets risk levels per endpoint (defaults: GET=low, POST/PUT=medium, DELETE=high)
   │     └── Admin classifies which need approval
   │
   ├── 3b. If no spec found:
   │     ├── Admin manually defines endpoints one by one
   │     ├── For each: method, path, parameters, body schema, response schema
   │     ├── Or: paste a cURL example → system parses into endpoint definition
   │     └── Or: paste API documentation → LLM extracts endpoint definitions (with human review)
   │
   ├── 4. Admin configures auth method + enters credentials via secure modal
   │     → Returns secretRef
   │
   ├── 5. Admin selects scope (org/project/team/channel/personal)
   │
   ├── 6. System registers all endpoints as ToolRegistryEntry records
   │     status = 'pending_review'
   │
   └── 7. Admin approves → tools become available to agents within scope
```

### OpenAPI Auto-Import

If the target API has an OpenAPI spec, the system auto-generates endpoint definitions:

```
POST /api/connectors/import-openapi
{
  "name": "Acme CRM",
  "openapi_url": "https://api.acme.com/v2/openapi.json",
  // or "openapi_spec": { ... inline spec ... }
  "auth_method": "bearer",
  "credential_ref": "secret_acme_bearer_xyz",
  "scope_type": "organization"
}

Response:
{
  "connector_id": "uuid",
  "endpoints_created": 47,
  "endpoints": [
    { "tool_name": "acme_list_contacts", "method": "GET", "path": "/contacts", "risk_level": "low" },
    { "tool_name": "acme_create_contact", "method": "POST", "path": "/contacts", "risk_level": "medium" },
    ...
  ]
}
```

---

## 4. Credential Flow — Agent Never Sees the Secret

This is a critical security boundary. The agent reasons about what tool to call and with what arguments. The credential injection happens outside the agent's context, in the execution engine.

### Execution Path

```
Agent decides to call "acme_create_contact" with { email: "john@acme.com", name: "John" }
  │
  │  Agent context contains:
  │  - Tool name and description
  │  - Input schema (what arguments the tool accepts)
  │  - Usage notes
  │  - Agent's arguments for this call
  │
  │  Agent context does NOT contain:
  │  - API key, token, password
  │  - Base URL (the agent doesn't need to know)
  │  - Auth headers
  │
  ├── 1. Tool execution engine receives call
  │
  ├── 2. Look up endpoint definition from transportConfig.endpointId
  │
  ├── 3. Look up connector from endpoint.connector_id
  │
  ├── 4. Resolve credential:
  │     POST /api/secrets/{connector.credential_ref}/resolve
  │     with SecretAccessContext { actor: agent, purpose: "tool_call", toolId: ... }
  │     → Returns plaintext credential (in memory only, never logged)
  │
  ├── 5. Build HTTP request:
  │     URL = connector.base_url + endpoint.path (with path params interpolated)
  │     Headers = connector.default_headers ∪ endpoint.headers ∪ auth headers
  │     Body = agent's arguments mapped to request_body schema
  │     Auth = credential injected per auth_method config
  │
  ├── 6. Execute HTTP request
  │
  ├── 7. Validate response against response_schema (if defined)
  │
  ├── 8. ERASE credential from memory (zero out, don't just dereference)
  │
  └── 9. Return response to agent
        Agent sees: { id: "contact-123", email: "john@acme.com", status: "created" }
        Agent does NOT see: which API key was used, what headers were sent
```

### For MCP Servers

Same principle. The MCP server instance has a `credential_ref`. When the execution engine connects to the MCP server, it resolves the credential and passes it to the server process via environment variable or config — never through the agent's message stream.

```
Agent calls MCP tool "stripe_create_customer"
  │
  ├── 1. Look up MCP server instance from transportConfig.serverId
  │
  ├── 2. Resolve credential_ref → get Stripe API key
  │
  ├── 3. Pass to MCP server process:
  │     ├── stdio: inject as environment variable (STRIPE_API_KEY=sk_...)
  │     ├── http: pass as auth header to the MCP server endpoint
  │     └── sse: include in connection handshake, not in tool calls
  │
  ├── 4. MCP server executes the tool with the credential
  │
  ├── 5. Result returned to agent (just the data, no auth info)
  │
  └── 6. Credential erased from execution context
```

### Credential Scoping for Tools

A single MCP server or API connector can use different credentials depending on who's using it:

```
mcp_server_credential_overrides
  id               UUID PK
  server_id        UUID FK → mcp_server_instances
  scope_type       TEXT — "user" | "agent" | "channel" | "team"
  scope_id         TEXT
  credential_ref   TEXT — secretRef
  
  created_at       TIMESTAMPTZ
  
  @@unique([server_id, scope_type, scope_id])
```

Resolution order:
1. User-specific credential (personal API key for GitHub)
2. Agent-specific credential (agent's own Stripe account)
3. Channel-specific credential
4. Team-specific credential
5. Connector/server default credential (organization-wide)

Example: GitHub MCP server is org-scoped, but each developer has their own PAT. The org installs GitHub MCP once, and each user adds their own credential override. When an agent acts on behalf of user A, it uses user A's PAT. When acting on behalf of user B, it uses user B's PAT.

---

## 5. Context Loading and Unloading

Tool schemas consume context window space. An agent with access to 50 MCP tools and 30 API endpoints would waste thousands of tokens on tool definitions it doesn't need for the current task. The solution: load tool schemas on demand and unload them when done.

### The Problem

```
Traditional approach (wasteful):
  Agent starts with ALL available tools in context
  → 80 tools × ~200 tokens per tool schema = 16,000 tokens burned
  → Agent only uses 2-3 tools per task
  → 95% of tool context is waste
```

### Two-Tier Tool Awareness

Agents operate with two levels of tool knowledge:

**Tier 1 — Tool Directory (always in context)**
A compact list of available tools with just name + one-line description. Costs ~10 tokens per tool.

```
Available tool categories:
  - CRM: acme_create_contact, acme_update_deal, acme_list_contacts (3 tools)
  - DevTools: github_create_issue, github_list_prs, jira_create_ticket (3 tools)
  - Database: postgres_query, postgres_list_tables (2 tools)
  - Communication: slack_send_message, email_send (2 tools)
  
  Use 'load_tools' to load full schemas before calling any tool.
  Use 'unload_tools' to free context when done with a tool category.
```

**Tier 2 — Full Tool Schemas (loaded on demand)**
Complete input/output schemas, usage notes, examples. Only loaded when the agent decides to use a tool.

```
Agent thinks: "I need to create a contact in the CRM"
  │
  ├── Agent calls: load_tools({ tools: ["acme_create_contact"] })
  │
  ├── System injects into context:
  │     acme_create_contact:
  │       description: "Create a new contact in Acme CRM"
  │       input: { email: string (required), name: string, phone: string, company: string }
  │       usage_notes: "Requires at least email. Returns created contact with ID."
  │       example: { email: "...", name: "..." } → { id: "...", status: "created" }
  │
  ├── Agent calls: acme_create_contact({ email: "john@acme.com", name: "John" })
  │     → Response: { id: "contact-123", status: "created" }
  │
  ├── Agent calls: unload_tools({ tools: ["acme_create_contact"] })
  │     → Full schema removed from context, only directory entry remains
  │
  └── Context freed for the next task step
```

### Meta-Tools for Context Management

```
load_tools
  Input: { tools: string[] }  — tool names to load
  Effect: Injects full schemas for specified tools into the agent's context
  Output: { loaded: string[], token_cost: number }
  
  The loaded schemas become available as callable tools.
  If a tool is already loaded, this is a no-op for that tool.
  
  Budget guard: if loading would exceed the agent's context budget,
  the system suggests unloading other tools first.

unload_tools
  Input: { tools: string[] }  — tool names to unload
  Effect: Removes full schemas from context, keeps directory entry
  Output: { unloaded: string[], tokens_freed: number }
  
  After unloading, the agent can still see the tool in the directory
  but cannot call it until re-loaded.

search_tools
  Input: { query: string, tags?: string[], limit?: number }
  Effect: Searches the tool registry (see tool-registry-spec.md § 5)
  Output: { results: ToolSearchDocument[] }
  
  For discovering tools the agent doesn't know about yet.
  Results include overview but NOT full schemas (Tier 1 info only).
```

### Automatic Unloading

The system can auto-unload tools that haven't been used for N turns:

```
Context management policy (per agent or org-wide):
  auto_unload_after_turns: 3      — unload if not used for 3 consecutive turns
  max_loaded_tools: 10            — hard cap on simultaneously loaded tools
  context_budget_tokens: 8000     — max tokens allocated to tool schemas
  
When auto-unloading:
  1. Rank loaded tools by last_used_turn (oldest first)
  2. Unload until within budget
  3. Log which tools were unloaded (agent is informed)
```

### What Gets Preserved After Unloading

When a tool is unloaded, the agent loses the schema details but keeps:
- The tool name and one-line description (Tier 1)
- Any procedural memories about using the tool (see § 6)
- Outcome history: "Last time I used `acme_create_contact`, it succeeded with email+name"

This means the agent can reason about which tool to load without having the full schema. It knows "I've used this before and it worked for X" from procedural memory.

---

## 6. Tool Outcome Memory

Every tool call produces an outcome. The platform captures these outcomes and builds procedural memory so agents learn which tools work, which fail, and how to use them effectively.

### Outcome Capture

After every external tool call (MCP or custom API):

```
Tool call completes
  │
  ├── Record outcome:
  │   {
  │     tool_name: "acme_create_contact",
  │     connector_type: "custom_api",       // or "mcp"
  │     connector_id: "uuid",
  │     
  │     input_summary: "email=john@acme.com, name=John",  // redacted, no secrets
  │     
  │     outcome: "success" | "error" | "timeout" | "auth_failure" | "rate_limited",
  │     status_code: 201,                   // HTTP status or null for MCP
  │     error_message: null,                // or "422: email already exists"
  │     latency_ms: 340,
  │     
  │     agent_id: "uuid",
  │     run_id: "uuid",
  │     timestamp: "2026-04-09T..."
  │   }
  │
  ├── If FIRST successful use of this tool by this agent:
  │     → Create procedural memory:
  │       "acme_create_contact works. Requires email (required), name (optional).
  │        Returns contact object with id and status fields."
  │
  ├── If ERROR:
  │     → Create or update procedural memory:
  │       "acme_create_contact returns 422 if email already exists.
  │        Check for existing contact first with acme_list_contacts."
  │     → If auth_failure: flag to admin (credential may be expired/revoked)
  │     → If rate_limited: back off, record rate limit info for future planning
  │
  └── If PATTERN detected (3+ similar outcomes):
        → Consolidate into refined procedural memory:
          "acme_create_contact: use email+name for best results. 
           Always check for duplicates first. Rate limit is ~60/min.
           Typical latency: 200-400ms."
```

### Procedural Memory Structure

Tool outcome memories follow the procedural memory format from multi-agent-memory-system.md:

```
thought (memory_type = 'procedure')
  content: "How to use acme_create_contact effectively"
  metadata: {
    tool_name: "acme_create_contact",
    connector_type: "custom_api",
    
    -- What works
    successful_patterns: [
      "Provide email + name for reliable creation",
      "Returns id field that can be used in subsequent update calls"
    ],
    
    -- What doesn't work
    failure_modes: [
      { trigger: "email already exists", error: "422", recovery: "search first with acme_list_contacts" },
      { trigger: "missing email field", error: "400", recovery: "email is required" }
    ],
    
    -- Performance
    typical_latency_ms: 300,
    rate_limit: "60 requests/minute",
    
    -- Usage stats
    success_count: 15,
    error_count: 2,
    last_used: "2026-04-09T...",
    
    -- Confidence
    confidence: 0.92,
    source_run_ids: ["run-1", "run-2", "run-3"]
  }
```

### Memory Lifecycle for Tool Outcomes

```
First successful call → create procedural memory (confidence: 0.5)
  │
  ├── 2nd success (same pattern) → confidence: 0.7
  ├── 3rd success → confidence: 0.85, mark as "reliable"
  ├── 5th success → confidence: 0.95, consider promoting to skill
  │
  ├── Error encountered → add failure_mode to existing memory
  │     Does NOT reduce confidence unless errors are frequent (>30% failure rate)
  │
  ├── API changes (new errors on previously working calls):
  │     → Reduce confidence to 0.3
  │     → Flag for review: "acme_create_contact may have changed"
  │     → Agent will re-explore on next use
  │
  └── No use for 90 days → decay confidence by 0.1 per period
        → Eventually garbage collected if unused and low confidence
```

### What the Agent Sees (Context Efficiency)

When an agent is about to use a tool, the system injects relevant procedural memories alongside the tool schema:

```
Agent loads "acme_create_contact"
  │
  ├── Tier 2 schema loaded (input/output definitions)
  │
  └── Procedural memory injected (if exists):
        "Previous experience with acme_create_contact:
         - Works reliably with email + name
         - 422 error means duplicate — search first
         - Rate limit: 60/min
         - Typical response time: ~300ms"
```

When the agent unloads the tool, the full schema is removed but the procedural memory stays in the memory system — available for future retrieval when the agent considers using the tool again.

### Skill Promotion

If procedural memory for a tool reaches high confidence and the usage pattern is consistent, it can be promoted to a skill:

```
Procedural memory (confidence > 0.9, success_count > 10, consistent pattern)
  │
  ├── System proposes skill creation:
  │     "Agent X has a reliable pattern for creating contacts in Acme CRM.
  │      Promote to reusable skill?"
  │
  ├── Skill template generated from procedural memory:
  │     steps: [
  │       "Search for existing contact by email",
  │       "If not found, create with email + name + company",
  │       "Return contact ID"
  │     ]
  │     tools_used: ["acme_list_contacts", "acme_create_contact"]
  │     preconditions: ["Acme CRM connector is active"]
  │     failure_modes: ["Handle 422 duplicate by returning existing contact"]
  │
  └── Follows skill lifecycle: draft → testing → pending_review → approved
        (see the-agents.md § 7)
```

---

## 7. Tool Discovery by Agents

Agents don't need to know upfront which tools exist. They discover tools based on intent.

### Discovery Flow

```
Agent receives task: "Update John's deal stage to 'closed-won' in the CRM"
  │
  ├── Agent checks procedural memory:
  │     "I've used acme_update_deal before — it works for changing deal stages"
  │     → Agent knows which tool to load
  │
  ├── If no procedural memory:
  │     Agent calls search_tools({ query: "update deal stage CRM" })
  │     → Returns: [
  │         { name: "acme_update_deal", overview: "Update a deal's properties in Acme CRM" },
  │         { name: "acme_get_deal", overview: "Get deal details from Acme CRM" }
  │       ]
  │     → Agent loads the relevant tools
  │
  ├── Agent loads: load_tools({ tools: ["acme_update_deal"] })
  │     → Full schema + procedural memory injected
  │
  ├── Agent executes the tool
  │
  ├── Agent unloads: unload_tools({ tools: ["acme_update_deal"] })
  │
  └── Outcome captured → procedural memory updated
```

### Tool Recommendation

For agents with no prior experience, the system can recommend tools based on the task:

```
Agent has no procedural memory for CRM operations
  │
  ├── System analyzes task: "Update deal stage"
  │
  ├── System checks: which tools in the agent's scope match?
  │     ├── Semantic search against tool descriptions
  │     ├── Tag matching: task mentions "CRM" → filter by category="crm"
  │     └── Rank by: relevance × tool health × org usage frequency
  │
  └── System suggests (injected into Tier 1 directory):
        "Recommended for this task:
         - acme_update_deal (CRM, used 47 times by other agents, 98% success rate)
         - acme_get_deal (CRM, useful for looking up deal before updating)"
```

---

## 8. Admin API

### MCP Server Management

```
POST   /api/mcp-servers                     — install MCP server
GET    /api/mcp-servers                     — list installed servers
GET    /api/mcp-servers/{id}                — get server details + discovered tools
PATCH  /api/mcp-servers/{id}                — update config
DELETE /api/mcp-servers/{id}                — uninstall server (revokes all tool grants)
POST   /api/mcp-servers/{id}/refresh        — re-discover tools from server
POST   /api/mcp-servers/{id}/healthcheck    — trigger manual healthcheck
```

### API Connector Management

```
POST   /api/connectors                      — create connector
GET    /api/connectors                      — list connectors
GET    /api/connectors/{id}                 — get connector details
PATCH  /api/connectors/{id}                 — update connector config
DELETE /api/connectors/{id}                 — delete connector + all endpoints

POST   /api/connectors/{id}/endpoints       — add endpoint
GET    /api/connectors/{id}/endpoints       — list endpoints
PATCH  /api/connectors/{id}/endpoints/{eid} — update endpoint
DELETE /api/connectors/{id}/endpoints/{eid} — delete endpoint

POST   /api/connectors/import-openapi       — auto-generate from OpenAPI spec
```

### Credential Override Management

```
POST   /api/mcp-servers/{id}/credentials    — add scope-specific credential override
GET    /api/mcp-servers/{id}/credentials    — list credential overrides (metadata only)
DELETE /api/mcp-servers/{id}/credentials/{cid} — remove override

POST   /api/connectors/{id}/credentials     — same for API connectors
GET    /api/connectors/{id}/credentials
DELETE /api/connectors/{id}/credentials/{cid}
```

---

## 9. Design Principles

### 1. Agent never touches credentials
The execution engine resolves secrets. The agent provides tool name and arguments. The credential injection and HTTP/MCP call happen in a separate execution context that the agent cannot observe.

### 2. Tools are loaded, not given
Agents start with a compact directory. They load what they need, use it, unload it. This keeps the context window efficient and prevents agents from being overwhelmed by irrelevant tool options.

### 3. Everything is database-driven
No code changes to add a new MCP server or API endpoint. Admins configure in the UI, the system generates tool registry entries. The execution engine reads from the database at call time.

### 4. Outcomes become knowledge
Every tool call result feeds back into procedural memory. Agents learn which tools work, how they fail, and how to use them effectively. This knowledge persists across runs and can be shared across agents within scope.

### 5. Scope controls access
MCP servers and API connectors are scoped to org/project/team/channel/personal. An agent can only discover and use tools visible at its scope level. Credentials can be overridden at any scope level for multi-tenant scenarios.

---

## What Needs Full Design

1. **MCP server process management** — how stdio MCP servers are spawned, supervised, and terminated (container vs subprocess vs sidecar)
2. **OAuth2 token lifecycle** — refresh flow, token caching, multi-tenant token isolation
3. **Tool schema versioning** — when an MCP server updates its tools, how to detect and handle schema changes
4. **Rate limit coordination** — multiple agents sharing one API connector must respect shared rate limits
5. **Webhook-based tools** — some APIs push results via webhook instead of returning them synchronously
6. **GraphQL connector** — REST is covered; GraphQL needs its own endpoint definition model (query/mutation strings, variable schemas)
7. **Bulk tool loading** — agent needs a category of tools at once (e.g., "load all CRM tools") without listing each one
8. **Tool dependency chains** — some tools require results from other tools as input; how to express this
9. **Context budget allocation** — how to split context budget between tool schemas, procedural memory, conversation history, and task context
10. **Cross-org tool sharing** — marketplace contributions from one org available to others (with review/trust model)
