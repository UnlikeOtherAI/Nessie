# External Tool Integration

> **Status:** aspirational target-state design — not implemented in code.

How Nessie agents connect to third-party services — both MCP servers and arbitrary APIs — without writing code, without seeing credentials, and without permanently consuming context window space.

Related documents:
- [the-agents.md](the-agents.md) — agent architecture, tool policy, execution loop
- [marketplace.md](marketplace.md) — unified marketplace, library, agent editor integration
- [tool-registry-spec.md](tool-registry-spec.md) — tool registry, grants, bundles, prompt layers
- [secret-management-spec.md](secret-management-spec.md) — credential storage, scoping, resolution
- [multi-agent-memory-system.md](done/multi-agent-memory-system.md) — procedural memory, outcome tracking
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

Current implementation security note: user-authored catalog entries and
instances may use HTTP/SSE remote endpoints only. Nessie does not spawn
catalog-provided stdio subprocesses in the cloud API or worker. HTTP/SSE
endpoint URLs and OAuth authorization/token URLs are checked by a DNS-backed
SSRF guard before save or use; private, local, link-local, and metadata-network
targets are rejected. Use Remote MCP Servers for private networks, developer
laptops, or local subprocess-based servers.

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
  protocol         TEXT — "stdio" | "http" | "sse" | "remote"
  endpoint         TEXT — URL, command, or container reference (null for remote)
  transport_config JSONB — protocol-specific config (timeouts, headers, etc.)
  
  -- Authentication
  auth_method      TEXT — "api_key" | "oauth2" | "basic" | "bearer" | "none"
  credential_ref   TEXT — secretRef from secret-management-spec.md (NEVER plaintext)
  
  -- Scoping
  scope_type       TEXT — "system" | "organization" | "project" | "team" | "channel" | "user"
  scope_id         TEXT — the specific scope entity ID
  installed_by     UUID FK → users
  
  -- State
  status           ENUM (active, idle, busy, draining, paused, error, pending_setup, pending_approval, offline, revoked) — idle through revoked apply only to protocol = 'remote'
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
Placement hierarchy (most restrictive → least restrictive):
  user → channel → team → project → organization → system

Rules:
  - "system" scope → platform-managed and visible everywhere
  - "organization" scope → all agents in the org can discover this server
  - "project" scope → only agents bound to that project
  - "team" scope → only agents bound to that team
  - "channel" scope → only agents in that channel
  - "user" scope → only one specific user's agents

By default, placement visibility follows that hierarchy. Additional explicit grants or bindings are a union on top of placement. Do not treat all visibility as inheritance-only; shared resources may also be made visible through binding rows.

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
   │     status = 'pending_review' (shared scopes — admin must approve before agents can use)
   │     status = 'active'         (user-scope installs — self-service, see below)
   │
   └── 8. Admin approves tools → status becomes 'active'
         Agents can now discover and use these tools
```

**User-scope installs are self-service.** Tools discovered from a `user`-scoped
instance project as `active` immediately (and drift re-activates rather than
re-flagging): the installer is the only person whose runs can ever reach those
tools, so an org-owner review gate would only break the "paste a link, start
using it" flow. The worker enforces the reach rule at toolset assembly
(`worker/src/run/mcp-toolset.ts`): user-scope instances surface **only** in
the installing user's delegated personal-assistant runs — never in shared
agents' channels; org/system instances surface to every run in the org; and
team/project/channel instances follow the run's context. An explicit per-agent
`toolPolicy` verdict overrides the scope default in either direction.

### Connector Library & Link Discovery

Non-technical users (and the personal assistant) don't hand-author transport
configs. Three signed-in endpoints, backed by `@nessie/mcp-manage`
(`library.ts`, `discovery.ts`), close the gap:

- `GET /api/mcp/library?search=` — unified search over (a) a **curated list**
  of well-known officially hosted remote servers (key-based: DeepWiki,
  Context7, GitHub, Stripe, Zapier, Hugging Face, PayPal, Square, Cloudflare
  Docs, Semgrep; OAuth sign-in: Notion, Linear, Sentry, Atlassian, Asana) and
  (b) the **official MCP registry** (`registry.modelcontextprotocol.io`),
  filtered to HTTP/SSE remotes (stdio/package-only servers are dropped) with
  auth classified from the registry's header metadata. Registry outages
  degrade to curated-only.
- `POST /api/mcp/discover` `{ url }` — probes a pasted link for an MCP
  endpoint: the URL itself plus well-known suffixes (`/mcp`, `/sse`,
  `/mcp/sse`), streamable HTTP first then legacy SSE, every candidate through
  the SSRF guard. A successful `tools/list` handshake yields an installable
  `authMethod: none` proposal (with tool names); a 401/403 yields an
  `oauth2` proposal when the server publishes genuine RFC 9728/8414 metadata
  (sign-in based, nothing to paste), else a `bearer` proposal with guidance
  to obtain a key. Redirects are never followed.
- `POST /api/mcp/library/import` — turns a library entry / discovery proposal
  into a catalog entry: private self-published for members, or (owners with
  `shareToOrg: true`) published straight into the org store.

The admin Connectors page exposes these as the **Library** tab (search +
"Only have a link?" box + one-click guided install: pick "Just me" / "Whole
organisation", then either paste the API key — stored encrypted — or, for
OAuth connectors, approve access in the sign-in tab that opens; the flow ends
with a connection test + tool discovery either way).

### OAuth (dynamic, MCP authorization spec)

`{ method: "oauth2" }` on a catalog entry — with no static client — activates
the dynamic flow in `@nessie/mcp-manage` (`oauth-discovery.ts`,
`mcp-oauth.ts`):

1. **Discovery**: the instance endpoint's 401 challenge (`WWW-Authenticate:
   Bearer resource_metadata=…`, RFC 9728) → protected-resource metadata →
   authorization-server metadata (RFC 8414, OIDC discovery fallback; legacy
   servers fall back to the spec's default `/authorize` + `/token` +
   `/register` endpoints). Every URL is SSRF-checked; redirects never
   followed.
2. **Dynamic Client Registration** (RFC 7591): a public client
   (`token_endpoint_auth_method: none`) is registered once per
   (organization × issuer) and persisted in `mcp_oauth_clients`; secrets a
   server issues anyway go behind an encrypted `secret_*` ref.
3. **Authorization code + PKCE (S256) + RFC 8707 `resource`**: state is
   one-shot and Postgres-backed (`mcp_oauth_states`, 10-min TTL) so a flow
   minted by the worker's personal assistant completes at the API callback.
4. **Token placement**: the user's own user-scope instance takes the token as
   its connection credential (probes work immediately); shared instances get
   a per-user override, so every user keeps their own identity.
5. **Refresh**: the encrypted bundle carries refresh metadata; the shared
   resolver renews expired access tokens in place (refresh_token grant,
   rotation-aware) transparently at probe/dispatch time.

Static configs (pre-registered `authorizationUrl`/`tokenUrl`/`clientId`) keep
the original flow for vendors without dynamic registration.
`POST /api/mcp/instances/:id/oauth/start` is open to any signed-in user who
can reach the instance — the minted token only ever lands on the caller's own
identity. Probe/test paths accept a `probeUserId` so each user's connection
test runs with their own credential.

### Personal-Assistant Connector Management

The personal assistant can run the whole lifecycle conversationally via
PA-only builtin tools (defined in
`packages/runtime/src/builtin-connector-tools.ts`, handlers in
`worker/src/run/pa-tools/connectors.ts`, all re-checking the acting user's
rights through the same `@nessie/mcp-manage` helpers as the routes):

| Tool | Purpose |
| --- | --- |
| `connector_list` | Instances the user can reach (own + shared), state + tool counts |
| `connector_library_search` | Org catalog + curated library + official registry, by service name |
| `connector_discover` | Probe a pasted URL for an MCP endpoint + auth requirements |
| `connector_install` | Install from catalog id, or register + install from url/transport/auth; owners/admins may target `organization`/`team`/`channel` scope; OAuth connectors get their sign-in link minted immediately |
| `connector_authorize` | Mint an OAuth sign-in link for the user to open in their browser (dynamic discovery + registration under the hood) |
| `connector_test` | Probe + project tools with the acting user's credential, report discovered tool names |
| `connector_set_secret` | Store a chat-provided credential encrypted (never echoed; redacted from tool summaries) and re-test |
| `connector_uninstall` | Remove a manageable instance + its registry entries |

**Admin locking.** Owners/admins can lock a catalog entry
(`POST /api/mcp/catalog/:id/lock` / `/unlock`, or the Lock button on the
entry). A locked connector cannot be installed by members — and its endpoint
URL cannot be re-registered by them under a fresh name (`findApplicableLock`
matches by endpoint) — while owners/admins remain exempt. Locking is an
install-time gate: already-installed instances keep working until removed.
Locked entries render with a 🔒 pill and a disabled Install button in the
admin UI, and the personal assistant reports them as locked in
`connector_library_search` / refuses `connector_install` with the reason.

Scope-management rights are role-derived and shared with the API routes
(`canManageInstanceScope`): `owner` manages every scope, `admin` manages the
shared scopes (organization/project/team/channel) — this is how "an admin
makes a connector available to the whole team/org" — and everyone manages
their own `user` scope. Instance listing for non-owners returns their own
installs plus shared-scope installs they can reach.

### Self-Hosted MCP Servers

Organizations can connect MCP servers not in the marketplace:

```
POST /api/mcp-servers
{
  "name": "Internal Analytics DB",
  "protocol": "http",
  "endpoint": "https://mcp.company.example/analytics",
  "auth_method": "bearer",
  "credential_ref": "secret_analytics_token_xyz",
  "scope_type": "project",
  "scope_id": "project-uuid-123"
}
```

Same flow as marketplace install, but no catalog_id. The endpoint must be
public-routable and pass SSRF validation. For internal-only hosts, on-prem
networks, or local subprocesses, register a Remote MCP Server instead. The
system still discovers tools, creates registry entries, and requires approval.

### deep.agent Crawl Web Scanning Connector

deep.agent crawl is the preferred first catalog template for agent web scanning
because it exposes browser-backed crawling, markdown extraction, screenshots,
PDF capture, JavaScript execution, and multi-URL crawl as MCP tools. Nessie
should use it through the MCP universal connector, not by embedding Crawl4AI's
Python package or spawning a crawler process inside the API/worker.

Connector shape:

```json
{
  "name": "deep-agent-crawl",
  "protocol": "sse",
  "endpoint": "https://deep-agent.example.com/mcp/sse",
  "auth_method": "bearer",
  "credential_ref": "DEEP_AGENT_CRAWL_BEARER_TOKEN"
}
```

Operational rules:

- Use the SSE endpoint (`/mcp/sse`). Nessie's MCP client does not support a
  crawler WebSocket endpoint yet.
- The endpoint must be reachable from Nessie and must pass the SSRF guard.
  `localhost`, private IP ranges, link-local addresses, and cloud metadata
  addresses are rejected for cloud-side connectors.
- Do not expose an unauthenticated deep.agent crawl service on the public
  internet. Keep bearer/JWT auth enabled or terminate auth at a trusted gateway
  that is still private to the organization.
- Treat deep.agent crawl as an external data-acquisition service. Crawled URLs
  should still be validated by Nessie policy before dispatch where Nessie owns
  the input surface; crawler-side allowlists should mirror the same
  public-web-only boundary because the crawler fetches from its own network.
- After install, Nessie probes `tools/list`, projects discovered crawler tools
  into `ToolRegistryEntry` rows as `pending_review`, and agents can use only the
  approved, granted tools.

### External-Agent Products (DeepSignal)

Some first-party products (e.g. **DeepSignal**) are surfaced not as a *toolset
inside* an agent run but as a **peer conversation** — a per-user DM channel whose
bound agent has `executionMode = external_mcp`. Nessie runs **no inference** for
these turns. The currently implemented transport proxies each message directly
to the product's MCP endpoint under the acting user's own UOA token, and the
reply + activity/generative cards are rendered verbatim.

That OAuth-only application transport is **transitional and superseded as the
target architecture**. DeepSignal must authenticate Nessie with DeepSignal's
own product-bound app API key and receive independently signed UOA
user/organization/team context on each request. The user token can remain part
of end-user authorization during migration, but it is not the app-to-app
credential. DeepSignal's webhook signing secret stays a separate callback
credential and must never be reused as the request key. Implementation seams
are `api/src/services/integration-plugin-manifests.ts`,
`api/src/services/external-agent-activation.ts`,
`api/src/services/external-agent-instance.ts`,
`api/src/services/deepsignal-signals.ts`, and
`worker/src/run/external-conversation.ts`. Full design:
`docs/plans/2026-07-09-deepsignal-integration.md`.

The connector plumbing is the ordinary MCP path — a first-party catalog entry, a
user-scoped `McpServerInstance`, dynamic OAuth, the encrypted secret store, and
the SSRF guard all apply unchanged. What differs is execution + two extra
surfaces, both of which reuse the shared `@nessie/mcp-manage` "connect + call one
tool" seam (`resolveInstanceMcpTransport` / `callInstanceTool`, alongside
`probeConnection`):

- **History hydration** — `POST /api/channels/:channelId/external-sync` pulls the
  thread's conversation from the product (`conversation_list` to adopt the most
  recent conversation, then `conversation_history`) and mirrors unseen turns into
  the channel, idempotent on `Message.metadata.external.turnId`. The product is the
  source of truth; Nessie mirrors for display/notification only.
- **Proactive insights** — `POST /api/integrations/deepsignal/events` is an
  unauthenticated, per-org **HMAC-verified** webhook receiver (`X-DeepSignal-Signature`,
  timing-safe). The per-org signing secret is set by an admin/owner via
  `PUT /api/integrations/products/:productSlug/webhook-secret` (stored encrypted in
  `product_webhook_secrets`); DeepSignal returns that secret once at webhook
  registration and the admin pastes it. On `insight.surfaced` the receiver posts one
  idempotent agent-authored insight card into each linked recipient's channel.
- **Signals digest** — `GET /api/integrations/products/deepsignal/signals`
  (optional `?include=active|all`) reads the user's insight digest via the
  `insight_digest` tool, and `POST .../signals/:insightId/act`
  (`{ action: done|snooze|mute|reopen }`) proxies an action via `insight_act`. Both
  resolve the requesting user's user-scoped instance through the same seam
  (`resolveUserScopedProductTransport` → `callInstanceTool`); tenancy is strictly
  the authenticated principal and a not-linked user gets a typed
  `{ status: 'needs_setup' }` (fail-closed, never a 500). Rendered as the admin
  **Signals** page (surface-registry plan §4).

### First-Party Team-Enabled Products (DeepWater)

DeepWater is the inverse of the DeepSignal pattern: instead of proxying turns to
an external agent, its `research_*` tools are exposed as a **grantable toolset**
that any *permitted* agent can call. Enabling DeepWater for a team (owner-only
`PATCH /api/integrations/products/deep-water/team-enablement`) provisions a
**team-scoped** tool-projecting `McpServerInstance` from the `deep-water`
catalog entry (`api/src/services/deepwater-activation.ts`,
`ensureDeepWaterTeamInstance`), resolves the Ledger-only MCP adapter from the
manifest-declared **`LEDGER_DEEPWATER_MCP_URL`** env var (canonical hosted
endpoint `https://ledger.unlikeotherai.com/v1/mcp/deepwater`), installs an
`{ transport: 'http', url }` bearer transport, and projects `research_start`,
`research_status`, `research_report`, `research_list`, and `research_cancel`
into `ToolRegistryEntry`; disabling removes the instance and its tool rows.
There is deliberately no direct-provider fallback.

- **Default OFF — explicit per-agent grant required.** The projected DeepWater
  rows are flagged `requiresExplicitGrant` (metadata) and the
  `deep_water_run_update` builtin sets the same flag on its
  `BuiltinToolDefinition`. Team scope alone does **not** expose them: an agent
  (personal assistant or shared) sees them ONLY when its per-agent `toolPolicy`
  carries an explicit allow (`toolPolicy[key] === true`) **and** the
  team-scoped instance reaches that run. A grant is an additional gate, never a
  way around tenancy; an absent/inherited verdict is a denial. This is the "any
  agent can use DeepWater only as long as it allows it" gate — see `isExposed`
  (`worker/src/run/mcp-toolset.ts`) and
  `authorizeToolCall` (`worker/src/run/tool-policy.ts`). **Other connectors are
  unchanged** — they remain exposed by install scope unless a policy denies them;
  only `requiresExplicitGrant`-flagged tools default off. The admin ToolPicker
  renders both DeepWater surfaces off-by-default and writes the explicit allow.
- **Fail loud and transition atomically.** When
  `LEDGER_DEEPWATER_MCP_URL` is unset the enable route returns
  `LEDGER_DEEPWATER_MCP_URL_UNSET` (503) instead of creating a dead or
  direct-provider instance. Missing `LEDGER_PROXY_TOKEN` or UOA signing/client
  settings return `LEDGER_PROXY_TOKEN_UNSET` or
  `LEDGER_IDENTITY_UNCONFIGURED`; a missing linked first-party public catalog
  returns `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE` (all 503). Nessie never
  persists `enabled=true` without a callable, attributable connector. Every
  org/team enable or disable acquires a PostgreSQL
  transaction-scoped advisory lock, serializing opposite transitions across
  API processes; connector rows and the enablement row mutate in that same
  transaction and roll back together. Teardown finds the instance through the
  first-party product's linked public catalog entry so a rename cannot orphan
  it and a private same-name entry cannot be deleted.
- **Projected tools are `active`, not `pending_review`.** DeepWater is a
  first-party entry the team's owner explicitly enabled, so that enable stands
  in for the manual install + admin-approve review that shared-scope projections
  otherwise defer. Re-enable preserves richer probe schemas only when the
  discovered tool-name set exactly matches the current Ledger contract; a
  legacy direct-provider contract is removed, reprojected, and must be
  explicitly re-granted.
- **Deterministic contract, app authentication, signed delegated identity.**
  The team instance has `authMethod=bearer` and resolves
  `LEDGER_PROXY_TOKEN`, which is Nessie's dedicated, product-bound Ledger app
  API key. It authenticates Nessie as the calling application only; it never
  defines research ownership and must not be reused by DeepWater, DeepSignal,
  DeepTest, or another product. Every DeepWater dispatch adds two independent,
  short-lived signed headers:
  `X-Nessie-Context` is an RS256 JWT with the originating
  org/project/team/user/channel/thread/task/run/agent/request envelope. Its
  user/org/team/agent/run fields are always non-null; named system work derives
  stable UUID agent/run values from a persisted user/team origin and fails
  before provider dispatch when that origin cannot be recovered.
  `X-UOA-Delegation` is a five-minute RS256 access token obtained from UOA's
  token-exchange endpoint for the linked `ProductAccountLink.uoaSub`. The
  exchange assertion uses Nessie's existing UOA config-JWT key and domain-hash
  bearer credential, has a maximum 60-second lifetime, and targets Ledger as
  its resource. The stable UOA subject is required. The selected UOA org/team
  comes from `active` or, when UOA auto-skips its chooser, the sole active team
  membership; the centralized resolution is projected into both the Nessie
  workspace and every product account link. Multiple teams without `active`
  remain ambiguous and fail closed. Nessie's signed local organization/team remain the
  authoritative research and spend scope, so the two ID namespaces are never
  compared or substituted. Ledger verifies both assertions before assigning a
  job to the UOA subject. DeepWater's product identity mode is `uoa_sso` even
  though its MCP transport uses Nessie's app API key, ensuring first login
  creates the per-user account link. A missing UOA link fails DeepWater closed.
  Webhook callback signing secrets are separate per-app credentials and are
  never accepted as the outbound Ledger app API key.
  The generic secret REST route and PA `connector_set_secret` refuse managed
  DeepWater instances. Generic instance test, refresh, healthcheck, and delete
  operations fail with `MCP_INSTANCE_MANAGED_BY_INTEGRATION`; PA probe and
  uninstall operations explain the same ownership rule. The Integrations team
  toggle is the sole lifecycle path, so deleting an instance can never leave
  the product toggle enabled and pointing at nothing. The Connectors UI replaces
  normal catalog lifecycle/install/credential/probe controls with an
  Integrations-managed notice, and migration removes old per-user overrides so
  none can shadow the product-bound app API key.
- **Research retries preserve provider idempotency.** Each DeepWater dispatch
  forwards the model provider's stable `tool_call_id` in the signed context.
  `research_start` rejects a missing ID, and retrying the same logical tool call
  reuses the same value instead of generating a new research job.
- **All Nessie inference uses the same Ledger chokepoint.** In hosted
  production, `NESSIE_MODEL_BASE_URL` is
  `https://ledger.unlikeotherai.com/v1/openai` and
  `NESSIE_MODEL_API_KEY` contains Nessie's product-bound Ledger app API key.
  This is the configured
  chokepoint, not a forced provider: the runtime rewrites the final path to
  Ledger's generic `/v1/:serviceId/*` adapter for the actual OpenAI, Kimi,
  MiniMax, or custom stage. The shared model client and
  agentic inference paths attach a fresh `X-Nessie-Context` and, when the
  effective user is UOA-linked, `X-UOA-Delegation` to chat, streaming, raw
  designer, and embedding calls. A deployment-wide base URL still wins over a
  provider-record URL. When no deployment-wide base is configured, routing
  resolves the approved organization provider record first and then decides
  whether to sign: an effective Ledger URL receives the same complete
  attribution, and missing signing identity fails before the network request.
  Nessie's local token and connector ledgers also persist `user_id` separately
  from `actor_id`, because an agent is often the actor while a human is the
  effective caller. Every Ledger request requires non-null
  user/org/team/agent/run fields. Knowledge embedding/extraction jobs persist
  that origin in their queue payload; for a teamless project space the API
  carries the authenticated request's active team rather than guessing from
  project membership. Each Fastify request owns a separate async context rooted
  at `onRequest`, so interleaved uploads cannot borrow another request's user or
  team. A request with no real team returns
  `KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED`, and malformed legacy jobs fail
  validation before storage or model access.
- `deep_water_run_update` (the builtin that writes the durable
  `product_integration_runs` record) is **not PA-only** — any *granted* agent
  (PA or shared) writes the run record back. Its tenancy is taken strictly from
  the run context: the update is scoped to the caller's **team** and the
  **thread** the run is attached to (no unattached-run escape), and any
  `knowledgePageId` is validated to belong to the org before it is stored — so a
  prompt-injected `runId`/`knowledgePageId` cannot mutate another run or corrupt
  billing. Ledger terminal MCP responses expose the immutable booked rate-card
  `cost: { amount, currency }`; the handoff copies those exact values when
  present and otherwise leaves Nessie's mirrored cost empty. Updates take a
  PostgreSQL row lock: identical delivery retries are accepted, while replacing
  an established external run id or booked cost, or moving a terminal run to a
  different status, returns an explicit immutable-conflict error. Reconciliation
  always books it to the run's immutable launch `requestedByUserId`, even when
  a different granted agent or user submits the terminal update. This booked charge
  is not a provider-invoice actual and complex runs may reconcile higher
  upstream without changing the value Nessie mirrors. Nessie never estimates
  cost or treats its cost-free MCP dispatch telemetry as the booked charge.
- **Long-running jobs do not busy-poll.** The launch handoff starts the Ledger
  job, persists its id + `running` state, optionally reads status once, tells the
  user it is running, and ends the bounded agent turn. A later user/status turn
  performs one status read and fetches `research_report` only after completion;
  autonomous polling remains future completion-wrapper work.

### MCP Server Lifecycle

```
pending_setup → active → paused → active (or) → error
                  │                                 │
                  └─ deprovisioned                   └─ auto-retry 3x → paused
```

Health checks run every 5 minutes. If a server fails 3 consecutive health checks, it moves to `error` and its tools are temporarily unavailable. The system retries, and if the server recovers, tools become available again without admin intervention.

### Remote MCP Servers (Self-Hosted Runners)

Nessie runs in the cloud, but users need agents to interact with machines behind firewalls, on-prem servers, developer laptops, or air-gapped environments. Remote MCP servers solve this by **reversing the connection direction** — the remote machine connects *to* Nessie, not the other way around.

This is the same `mcp_server_instances` model with `protocol: "remote"`. Same tool discovery, same credential model, same scoping. The only difference: the machine initiates and maintains the connection.

> **Canonical spec.** This section is the single source of truth for remote workers. The previous standalone `remote-worker-spec.md` has been merged here.

#### How It Works

```
1. Admin creates a remote MCP server registration in Nessie:
   POST /api/mcp-servers
   {
     "name": "Build Server (on-prem)",
     "protocol": "remote",
     "scope_type": "team",
     "scope_id": "team-engineering-uuid"
   }
   → Returns: { server_id: "uuid", registration_token: "nessie_reg_xxx..." }

2. User installs the Nessie CLI on the remote machine:
   $ curl -fsSL https://install.nessie.ai/cli | sh

3. User registers the CLI with the token:
   $ nessie-agent register --token nessie_reg_xxx...
   ✓ Registered as "Build Server (on-prem)"
   ✓ Connected to org "Acme Corp"
   ✓ Advertising 12 tools

4. CLI starts heartbeat polling:
   POST /api/remote-workers/{server_id}/heartbeat  (every 60s)
   → Server responds: { hasWork: false, retryAfterMs: 60000 }
   
   When work arrives:
   → Server responds: { hasWork: true, wsTicket: "...", retryAfterMs: 5000 }
   → CLI opens WebSocket: wss://api.nessie.ai/remote/{server_id}/ws?ticket=...
   → Tool calls flow over the WebSocket
   → When work completes, WebSocket closes, CLI returns to polling
```

#### Connection Model — Poll When Idle, WebSocket When Active

The CLI does **not** hold a permanent WebSocket open. Instead:

- **Idle**: HTTP heartbeat poll every 60s (server may adjust via `retryAfterMs`)
- **Active**: WebSocket opened only when there's pending work, closed when done
- **Why**: Permanent WebSocket wastes resources on machines that may go hours between tool calls. Poll is cheap and keeps the machine discoverable.

```
Remote machine (behind firewall/NAT)              Nessie Cloud
┌───────────────────────────────┐                ┌──────────────────────┐
│  nessie-agent CLI              │                │                      │
│                                │                │                      │
│  IDLE MODE:                    │   HTTP POST    │                      │
│  heartbeat every 60s           │───────────────→│  /heartbeat          │
│  "I'm alive, no policy change" │←──── 200 ─────│  { hasWork: false }  │
│                                │                │                      │
│  ACTIVE MODE (work pending):   │   WSS outbound │                      │
│  opens WebSocket               │───────────────→│  /ws?ticket=...      │
│  receives tool calls           │←── tool call ──│                      │
│  executes locally              │── result ─────→│                      │
│  WebSocket closes when done    │                │                      │
│  returns to idle polling       │                │                      │
└───────────────────────────────┘                └──────────────────────┘

Key: the remote machine only makes OUTBOUND connections.
No inbound ports, no firewall rules, no VPN required.
```

Heartbeat response shape:

```json
{
  "hasWork": true,
  "retryAfterMs": 5000,
  "wsTicket": "short-lived-ticket-abc",
  "sessionId": "sess_123",
  "policyChanged": false,
  "policyVersion": "pol_v12"
}
```

#### Protocol: "remote" on mcp_server_instances

No new table. Remote servers use the existing `mcp_server_instances` schema with these specifics:

```
mcp_server_instances row for a remote server:
  protocol         = "remote"
  endpoint         = null (the CLI connects to us, not the other way around)
  
  -- Remote-specific fields in transport_config:
  transport_config = {
    "registration_token_ref": "secret_reg_token_xxx",  -- secretRef, one-time use
    "heartbeat_interval_s": 60,                         -- default, server may adjust
    "heartbeat_timeout_s": 180,                         -- 3 missed heartbeats → disconnected
    "reconnect_max_backoff_s": 300,                     -- CLI retries with exponential backoff
    "max_concurrent_calls": 5,                          -- limit parallel tool calls
    "machine_id": "build-server-01",                    -- reported by CLI on connect
    "machine_info": {                                   -- reported by CLI
      "os": "linux",
      "arch": "amd64",
      "hostname": "build-01.internal.acme.com",
      "platform": "linux"
    },
    "local_policy_version": "pol_v12",                  -- current local policy digest
    "cloud_policy_version": "pol_v15"                   -- last synced cloud policy
  }
  
  -- Status reflects connection state (extended for remote):
  status = "active"    -- heartbeat received, accepting work
         | "idle"      -- heartbeat received, no active sessions
         | "busy"      -- WebSocket open, executing tool calls
         | "draining"  -- finishing current work, not accepting new
         | "paused"    -- user-paused
         | "offline"   -- no heartbeat within timeout
         | "revoked"   -- admin revoked, CLI must re-register
         | "error"     -- connection or policy error
  
  health_status = "healthy" | "degraded" | "down"
```

#### Three-Layer Policy Model

Every remote tool call is authorized by the intersection of three policy layers. If **any** layer denies, the action is denied. The local machine owner's policy is a hard floor that the cloud can never expand beyond.

```
┌─────────────────────────────────────────────────────────┐
│ 1. LOCAL HARD POLICY (machine owner controls)            │
│    Set in nessie-agent.yaml on the remote machine.       │
│    Cloud CANNOT override or expand these limits.         │
│                                                          │
│    Examples:                                             │
│    - allowed_roots: ["/app", "/var/log"]                 │
│    - denied_roots: ["/etc", "/root", "/home"]            │
│    - command_allowlist: ["make", "npm", "docker"]        │
│    - command_denylist: ["rm -rf", "dd", "mkfs"]          │
│    - disable_write_tools: false                          │
│    - disable_ssh: true                                   │
│    - disable_interactive_sessions: false                 │
│    - max_runtime_s: 3600                                 │
│    - max_output_bytes: 10485760 (10MB)                   │
│    - max_concurrent_sessions: 3                          │
│    - working_hours_only: false                           │
│    - env_allowlist: ["NODE_ENV", "PATH"]                 │
│    - env_denylist: ["AWS_SECRET_*"]                      │
└─────────────────────┬───────────────────────────────────┘
                      │ intersected with
┌─────────────────────▼───────────────────────────────────┐
│ 2. CLOUD POLICY (Nessie admin controls)                  │
│    Set per org/project/team/channel/agent in Nessie.     │
│    Can only NARROW, never expand local policy.           │
│                                                          │
│    Examples:                                             │
│    - agent "deploy-bot" may use shell.run on this worker │
│    - channel "incident-response" gets read-only access   │
│    - project "backend" can discover this worker          │
│    - project "frontend" cannot discover this worker      │
│    - all write operations require approval               │
└─────────────────────┬───────────────────────────────────┘
                      │ intersected with
┌─────────────────────▼───────────────────────────────────┐
│ 3. ACTOR CONTEXT (runtime — who's asking, why)           │
│    Evaluated at execution time per request.              │
│                                                          │
│    Inputs: agent ID, user ID, channel, project,          │
│    tool being called, arguments, time of day             │
│                                                          │
│    Decision: allowed | denied | requires_approval        │
│              | requires_step_up_verification             │
│                                                          │
│    Reason codes:                                         │
│    - REMOTE_WORKER_OFFLINE                               │
│    - LOCAL_POLICY_DENY                                   │
│    - CLOUD_POLICY_DENY                                   │
│    - MISSING_AGENT_BINDING                               │
│    - TOOL_NOT_EXPOSED                                    │
│    - PATH_OUTSIDE_ALLOWED_ROOT                           │
│    - COMMAND_NOT_IN_ALLOWLIST                             │
│    - MAX_CONCURRENT_SESSIONS_REACHED                     │
│    - OUTSIDE_WORKING_HOURS                               │
└─────────────────────────────────────────────────────────┘
```

Policy sync happens on every heartbeat. The CLI sends its local policy digest; the server sends the current cloud policy. If either has changed, capabilities and bindings are re-evaluated before any new work is dispatched.

#### CLI Tool Discovery

The CLI exposes tools to Nessie using the standard MCP `tools/list` protocol. What the CLI exposes depends on what's installed/configured on the remote machine and what local policy allows:

```
nessie-agent can expose these capability surfaces:

  1. Shell execution:
     - shell.run: One-shot command execution
     - shell.session: Long-lived interactive terminal session (if enabled by local policy)

  2. File operations:
     - file.read: Read files (within allowed_roots)
     - file.write: Write files (within allowed_roots, if write enabled)
     - file.glob: Search for files by pattern

  3. Process management:
     - process.list: List running processes
     - process.signal: Send signals to processes (if enabled)

  4. SSH (if enabled):
     - ssh.run: Execute commands on another machine via SSH
     - ssh.session: Interactive SSH session

  5. MCP proxy:
     - mcp.proxy: Proxy local MCP servers through the connection to Nessie
     
  6. CLI wrappers (declared in nessie-agent.yaml):
     - Named commands with parameters, timeouts, risk levels

All surfaces are filtered by local hard policy before being advertised.
If local policy says disable_ssh: true, ssh.* surfaces are never exposed.
```

Declared tools in `nessie-agent.yaml`:

```yaml
# Local hard policy
policy:
  allowed_roots: ["/app", "/var/log", "/tmp/builds"]
  denied_roots: ["/etc/shadow", "/root"]
  command_allowlist: ["make", "npm", "docker", "kubectl"]
  disable_ssh: true
  disable_interactive_sessions: false
  max_runtime_s: 3600
  max_output_bytes: 10485760
  max_concurrent_sessions: 3

# Custom tool declarations
tools:
  - name: run_build
    description: "Run the CI build pipeline"
    command: "cd /app && make build"
    timeout: 600
    risk_level: medium
  
  - name: deploy_staging
    description: "Deploy current build to staging"
    command: "/scripts/deploy.sh staging"
    timeout: 300
    risk_level: high
    requires_approval: true
  
  - name: read_logs
    description: "Read application logs"
    command: "tail -n {{lines}} /var/log/app/{{service}}.log"
    parameters:
      lines: { type: integer, default: 100 }
      service: { type: string, enum: [api, worker, scheduler] }
    risk_level: low

# Local MCP servers to proxy
mcp_servers:
  - name: local-postgres
    command: "npx @modelcontextprotocol/server-postgres"
    env:
      DATABASE_URL: "{{secret:local_db_url}}"
```

#### Security Model

Remote servers execute commands on real machines. The security model has multiple layers:

```
1. REGISTRATION
   - One-time token, expires after 24 hours, scoped to one server record
   - After registration, CLI receives short-lived access token + refresh policy
   - Registration token revoked immediately after use
   - Worker-scoped API key — never org-level keys on the machine
   - Long-lived org keys must NEVER be embedded in worker config

2. TOOL APPROVAL
   - All tools discovered from a remote server start as pending_review
   - Admin must approve each tool before agents can use it
   - Tools with risk_level: "high" always require per-invocation approval
   - shell.run requires explicit admin opt-in (disabled by default)
   - shell.session (interactive) requires separate opt-in

3. CREDENTIAL ISOLATION
   - Local credentials (DB passwords, API keys) stay on the machine
   - CLI resolves local secrets from its own config, not Nessie's secret store
   - Nessie never sees local credentials — sends tool call args, CLI injects locally
   - Exception: Nessie-managed secrets resolved and sent over encrypted WebSocket
   - Secrets NEVER pushed in plaintext over chat — only secretRef resolution at execution time

4. NETWORK SECURITY
   - All connections are outbound TLS (WSS for active, HTTPS for heartbeat)
   - Client certificate or short-lived token authentication
   - CLI validates Nessie's server certificate (no self-signed)
   - Worker does NOT accept inbound connections from the public internet

5. POLICY ENFORCEMENT
   - Three-layer policy evaluated on every tool call (see above)
   - Local policy changes are integrity-protected before parent accepts them
   - Policy version mismatch → re-sync before accepting new work

6. AUDIT
   - Every tool call logged in Nessie's audit system with full context:
     actor, project, channel, agent, tool, arguments (redacted secrets)
   - CLI also logs locally to /var/log/nessie-agent/audit.log
   - Admin can view remote execution history in Nessie admin UI

7. REVOCATION
   - Admin can revoke a worker immediately
   - Revocation blocks new sessions and invalidates reconnect tokens
   - Active sessions can be interrupted or drained per policy
```

#### Remote Server Lifecycle

```
Registration:
  Admin creates server → gets token → user runs nessie-agent register
  → CLI starts heartbeat polling → tools discovered → admin approves → ready

Idle:
  CLI polls heartbeat endpoint every 60s
  Server responds: { hasWork: false }
  Nessie knows the machine is alive

Active:
  Server responds: { hasWork: true, wsTicket: "..." }
  CLI opens WebSocket with ticket
  Tool calls flow over WebSocket
  CLI executes → returns results
  When done, WebSocket closes → returns to idle polling

Draining:
  Admin or policy triggers drain
  → CLI finishes current work
  → Does not accept new WebSocket sessions
  → Returns to idle (or offline if deregistering)

Disconnection:
  CLI stops heartbeating (network issue, machine restart, crash)
  → Nessie marks as offline after 180s (3 missed heartbeats)
  → Tools from this server become temporarily unavailable
  → Agents see: "Build Server (on-prem): offline" in capability directory
  → CLI reconnects automatically with exponential backoff (max 300s)
  → On reconnect: tools/list re-run, policy synced, health restored

Revocation:
  Admin revokes the worker
  → CLI receives revocation on next heartbeat or active WebSocket
  → All sessions terminated
  → Reconnect tokens invalidated
  → CLI must re-register with a new token to resume

Deregistration:
  $ nessie-agent deregister
  → CLI closes connection, removes local credentials
  → Or: admin deletes the server in Nessie → CLI receives deregister signal
```

#### Remote Worker API

```
POST   /api/remote-workers/register                     — bootstrap registration
POST   /api/remote-workers/{id}/heartbeat               — heartbeat poll (returns hasWork)
POST   /api/remote-workers/{id}/policy-sync             — sync local ↔ cloud policy
GET    /api/remote-workers/{id}/ws?ticket=...            — WebSocket for active work
POST   /api/remote-workers/{id}/drain                   — graceful drain
POST   /api/remote-workers/{id}/revoke                  — immediate revocation
GET    /api/remote-workers                              — list all workers (admin)
GET    /api/remote-workers/{id}                         — get worker details
GET    /api/remote-workers/{id}/policy/effective         — computed effective policy
POST   /api/remote-workers/{id}/access/check            — test whether a specific call would be allowed
```

#### CLI Management Commands

```
$ nessie-agent register --token <token>     Register with Nessie
$ nessie-agent status                        Show connection status, registered tools, policy
$ nessie-agent tools                         List tools this agent exposes
$ nessie-agent logs                          Tail local execution logs
$ nessie-agent policy                        Show effective policy (local + cloud)
$ nessie-agent deregister                    Disconnect and clean up
$ nessie-agent run                           Start the agent (foreground, for systemd/launchd)
$ nessie-agent install-service               Install as a system service (systemd/launchd)
```

#### Admin UI — Resources Page

Remote workers appear in the admin as **Resources** — a dedicated page showing all connected machines, their status, tools, and policy.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Admin > Resources                                                    │
│                                                                      │
│ Scope: [Organization ▾]  [All statuses ▾]  [Search...]              │
│                                                                      │
│ ┌──────────────────┬──────────┬────────┬───────┬──────────────────┐  │
│ │ Name             │ Status   │ Scope  │ Tools │ Last Seen        │  │
│ ├──────────────────┼──────────┼────────┼───────┼──────────────────┤  │
│ │ Build Server 01  │ 🟢 idle  │ Org    │ 12    │ 30s ago          │  │
│ │ Staging Deploy   │ 🔵 busy  │ Team   │ 5     │ active now       │  │
│ │ Dev Laptop (Joe) │ 🟢 idle  │ Personal│ 8    │ 2m ago           │  │
│ │ GPU Cluster      │ ⚫ offline│ Project│ 3    │ 4h ago           │  │
│ │ Ops Monitor      │ 🟢 idle  │ Channel│ 4    │ 1m ago           │  │
│ └──────────────────┴──────────┴────────┴───────┴──────────────────┘  │
│                                                                      │
│ [+ Register New Resource]                                            │
└─────────────────────────────────────────────────────────────────────┘
```

Resource detail page:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Build Server 01                                    [Drain] [Revoke] │
│                                                                      │
│ Status: 🟢 idle          Machine: linux/amd64                        │
│ Scope: Organization      Hostname: build-01.internal.acme.com        │
│ Registered: 2026-03-15   Last heartbeat: 30s ago                     │
│                                                                      │
│ ┌─ Tools (12) ──────────────────────────────────────────────────┐    │
│ │ ✓ run_build          medium    approved                       │    │
│ │ ✓ deploy_staging     high      approved (requires approval)   │    │
│ │ ✓ read_logs          low       approved                       │    │
│ │ ○ shell.run          high      pending review                 │    │
│ │ ...                                                           │    │
│ └───────────────────────────────────────────────────────────────┘    │
│                                                                      │
│ ┌─ Policy ──────────────────────────────────────────────────────┐    │
│ │ Local policy version: pol_v12                                 │    │
│ │ Cloud policy version: pol_v15                                 │    │
│ │ Allowed roots: /app, /var/log, /tmp/builds                    │    │
│ │ Command allowlist: make, npm, docker, kubectl                 │    │
│ │ SSH: disabled   Interactive: enabled   Write: enabled         │    │
│ └───────────────────────────────────────────────────────────────┘    │
│                                                                      │
│ ┌─ Bindings ────────────────────────────────────────────────────┐    │
│ │ Agent: deploy-bot         → shell.run, deploy_staging         │    │
│ │ Channel: #incident-resp   → read_logs (read-only)             │    │
│ │ Team: Engineering         → all approved tools                │    │
│ └───────────────────────────────────────────────────────────────┘    │
│                                                                      │
│ ┌─ Recent Activity ─────────────────────────────────────────────┐    │
│ │ 14:30  deploy-bot called deploy_staging → success (42s)       │    │
│ │ 14:25  build-agent called run_build → success (3m12s)         │    │
│ │ 13:50  ops-agent called read_logs → success (1s)              │    │
│ └───────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

Scoping works the same as all other capabilities:
- **Organization** scope → all agents in the org can use this resource
- **Project** scope → only agents in that project
- **Team** scope → only agents bound to that team
- **Channel** scope → only agents in that channel
- **User** scope → only one user's agents

Resources that are **system** scoped are visible everywhere and should be platform-managed. Organization-scoped resources are visible within one organization and may still have read-only or restricted tool access via cloud policy. Resources scoped to a team or channel are only discoverable by agents in that scope. The admin who registered the resource controls the scope; the machine owner controls the local policy.

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
  scope_type       TEXT — "system" | "organization" | "project" | "team" | "channel" | "user"
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
   ├── 5. Admin selects scope (system/organization/project/team/channel/user)
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

Same principle. The MCP server instance has a `credential_ref`. When the execution engine connects to the MCP server, it resolves the credential and passes it to the remote endpoint or runner config — never through the agent's message stream.

**Ref resolution is layered and identical on both paths** (probe/test in the
API, dispatch in the worker), via `createMcpSecretResolver` in
`@nessie/mcp-manage`: refs starting `secret_` resolve from the encrypted
Postgres store (AES-256-GCM under the deployment auth secret — OAuth token
bundles use `secret_oauth_*`, user/assistant-provided keys `secret_mcp_*`),
anything else falls back to the env-var convention. Header application is also
shared (`applyAuthSecretToTransport`): `bearer`/`oauth2` → `Authorization:
Bearer …`, `api_key` → the catalog entry's configured header name + value
prefix. User-provided secrets enter through `POST
/api/mcp/instances/:id/secret` (admin UI) or the PA's `connector_set_secret`
tool — one shared implementation (`storeInstanceSecret`): own user-scope
instance → the instance credential; shared instance + manage rights +
`shared: true` → the shared default; otherwise a per-user override.

```
Agent calls MCP tool "stripe_create_customer"
  │
  ├── 1. Look up MCP server instance from transportConfig.serverId
  │
  ├── 2. Resolve credential_ref → get Stripe API key
  │
  ├── 3. Pass to MCP transport:
  │     ├── http: pass as auth header to the MCP server endpoint
  │     ├── sse: include in connection handshake, not in tool calls
  │     └── remote runner: runner injects local credentials under its own policy
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
  principal_type   TEXT — "user" | "agent" | "channel" | "team" | "project" | "organization"
  principal_id     TEXT
  credential_ref   TEXT — secretRef
  
  created_at       TIMESTAMPTZ
  
  @@unique([server_id, principal_type, principal_id])
```

Resolution order:
1. User-specific credential (personal API key for GitHub)
2. Agent-specific credential (agent's own Stripe account)
3. Channel-specific credential
4. Team-specific credential
5. Project-specific credential
6. Organization-specific credential
7. Connector/server default credential (organization-wide)

Example: GitHub MCP server is org-scoped, but each developer has their own PAT. The org installs GitHub MCP once, and each user adds their own credential override. When an agent acts on behalf of user A, it uses user A's PAT. When acting on behalf of user B, it uses user B's PAT.

Generated plugins and execution environments are part of the same capability system. Initial platform-managed execution providers are `docker` and `gcloud`; integrations that need coded runtime behavior should bind to those execution environments rather than assuming direct host execution.

---

## 5. Temporary Context and Tool Resolution

> **Implemented for MCP connectors** (`worker/src/run/mcp-toolset-deferred.ts`):
> up to `NESSIE_MCP_INLINE_TOOL_LIMIT` (default 12) exposed MCP tools are
> inlined as ordinary schemas; above that the toolset presents exactly three
> small meta tools — `mcp_find_tools` (ranked directory search with parameter
> summaries and a per-connector count directory in the description),
> `mcp_load_tools` (loads full schemas into the LIVE tool array the loop
> recomposes each iteration; capped at 15 with oldest-first eviction) and
> `mcp_drop_tools` (frees them again). Known tool names dispatch even when
> their schema is not loaded, and every consumer (main loop, each delegate
> sub-agent) gets an independent view so loads never leak across contexts.
> The resolver-sub-agent variant below remains the fuller design target.

Tool schemas consume context window space. An agent with access to 50 MCP tools and 30 API endpoints would waste thousands of tokens on tool definitions it doesn't need. The solution: a two-part context model where the main agent's context has a **permanent** section (conversation, reasoning, memories) and a **temporary** section (tool schemas loaded on demand and dropped when no longer needed). A cheap resolver sub-agent finds the right tools; the main agent uses them directly.

### The Problem

```
Traditional approach (wasteful):
  Agent starts with ALL available tools in context
  → 80 tools × ~200 tokens per tool schema = 16,000 tokens burned
  → Agent only uses 2-3 tools per task
  → 95% of tool context is waste

Executor sub-agent approach (loses conversation context):
  Main agent spawns a sub-agent to execute tools
  → Sub-agent doesn't have the full conversation context
  → Can't reason about what the user actually needs
  → Has to receive a distilled "task" — information loss
  → Main agent can't steer or adjust mid-execution
```

### The Pattern: Resolver + Temporary Context

The main agent has the full conversation context and executes tools itself. But tool schemas are not permanently in its context — they're loaded into a **temporary context array** when needed, and the agent drops them when done.

A cheap **resolver sub-agent** (cheapest LLM available) handles the selection: given the agent's intent, it picks the right tools from the available capabilities and loads their schemas + companion skills into the main agent's temporary context. The main agent then uses those tools directly, with full conversation context, and calls `drop_context` when it's finished.

```
┌──────────────────────────────────────────────────────────────┐
│  MAIN AGENT CONTEXT                                           │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ PERMANENT CONTEXT                                        │  │
│  │  - System prompt                                         │  │
│  │  - Conversation history with the user                    │  │
│  │  - Capability directory (~50 tokens)                     │  │
│  │  - Procedural memories                                   │  │
│  │  - Built-in tools (Bash, FileRead, Grep, etc.)           │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ TEMPORARY CONTEXT (array — zero or more loaded sections)  │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────┐      │  │
│  │  │ capability:stripe                                │      │  │
│  │  │   Tool schemas: stripe_list_charges, ...         │      │  │
│  │  │   Companion skill: "Amounts in cents, paginate"  │      │  │
│  │  └─────────────────────────────────────────────────┘      │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────┐      │  │
│  │  │ capability:acme_crm                              │      │  │
│  │  │   Tool schemas: acme_update_deal, ...            │      │  │
│  │  │   Companion skill: "Always check deal exists"    │      │  │
│  │  └─────────────────────────────────────────────────┘      │  │
│  │                                                           │  │
│  │  Agent drops any section by calling drop_context(...)     │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### How It Works — End to End

```
Main agent (in conversation with user)
  │
  │  Permanent context:
  │  - Conversation: user asked "What were last week's Stripe sales?"
  │  - Capability directory: "stripe: Payment data (read-only)..."
  │  - Procedural memory: "Stripe amounts are in cents"
  │
  │  Temporary context: [] (empty — no tool schemas loaded yet)
  │
  ├── 1. Main agent decides: "I need Stripe data"
  │     Calls: resolve_capability({ capability: "stripe", intent: "query last 7 days of charges" })
  │
  ├── 2. RESOLVER SUB-AGENT (cheapest model, disposable)
  │     │  Receives: intent + list of enabled tools for "stripe"
  │     │  Loads: full tool schemas + companion skill for Stripe
  │     │  Reasons: "For querying charges, they need stripe_list_charges. 
  │     │            stripe_get_balance might be useful too."
  │     │  Returns: selected tool schemas + companion skill
  │     │  *** Sub-agent discarded — its context is gone ***
  │     │
  │     └── Platform injects returned schemas into main agent's temporary context:
  │           temporary_context.push({
  │             section: "capability:stripe",
  │             tools: [stripe_list_charges schema, stripe_get_balance schema],
  │             companion_skill: "Amounts in cents. Results paginated...",
  │           })
  │
  ├── 3. Main agent now has Stripe tools in its temporary context
  │     It can see the schemas. It can call the tools. It has full conversation context.
  │     
  │     Main agent calls stripe_list_charges({ created: { gte: "2026-04-02" } })
  │     → Platform intercepts, resolves {{secret:stripe_readonly}}, injects credential
  │     → MCP/HTTP call made → result returned to main agent
  │     → Credential erased (never in agent context)
  │     
  │     Main agent sees: 47 charges, has_more: true
  │     Main agent reasons: "Need to paginate" → calls again with starting_after
  │     Main agent processes: sums amounts, converts cents to dollars
  │
  ├── 4. Main agent responds to user:
  │     "Last week's Stripe sales were $14,230 across 47 charges."
  │
  └── 5. Main agent decides it's done with Stripe tools
        Calls: drop_context({ sections: ["capability:stripe"] })
        → Platform removes Stripe schemas from temporary context
        → Context space freed for the next turn
        
  Temporary context: [] (clean again)
```

### The Two Layers

```
┌──────────────────────────────────────────────────────────┐
│  RESOLVER SUB-AGENT (cheapest model, disposable)          │
│  - Receives the agent's intent                            │
│  - Has all tool schemas for the capability                │
│  - Picks the right subset of tools                        │
│  - Returns schemas + companion skill to the platform      │
│  - Discarded immediately after selection                  │
└────────────────────┬─────────────────────────────────────┘
                     │ loads tools into
┌────────────────────▼─────────────────────────────────────┐
│  MAIN AGENT (expensive model, long-lived)                 │
│  - Owns the conversation with the user                    │
│  - Has full conversation context for reasoning            │
│  - Executes tool calls directly (with credential inject)  │
│  - Can paginate, retry, adapt — it's the smart model      │
│  - Decides when to drop temporary context                 │
│  - Calls drop_context when done with a capability         │
└──────────────────────────────────────────────────────────┘

The main agent IS the executor. It has the conversation context,
the user's intent, and the tools — all in one place. No information 
loss from distilling the task into a sub-agent handoff.
```

### Temporary Context Management

The temporary context is an **array of capability sections**, each identified by a key (e.g., `capability:stripe`). The platform manages insertion; the agent manages removal.

```
Platform-side data structure:

  agent_context = {
    permanent: [
      { role: "system", content: "You are agent X..." },
      { role: "user", content: "What were last week's sales?" },
      ...conversation history...
    ],
    temporary: [
      // Each entry is a loaded capability section
      {
        key: "capability:stripe",
        loaded_at: "2026-04-09T14:30:00Z",
        messages: [
          { role: "system", content: "TOOL SCHEMAS (stripe):\n..." },
          { role: "system", content: "COMPANION SKILL (stripe):\n..." },
        ],
        tool_definitions: [...stripe tool JSON schemas...],
      },
      {
        key: "capability:acme_crm",
        loaded_at: "2026-04-09T14:30:05Z",
        messages: [...],
        tool_definitions: [...],
      }
    ]
  }

When building an LLM request:
  messages = [...permanent, ...temporary[0].messages, ...temporary[1].messages, ...]
  tools = [...builtin_tools, ...temporary[0].tool_definitions, ...temporary[1].tool_definitions, ...]

When agent calls drop_context({ sections: ["capability:stripe"] }):
  temporary = temporary.filter(t => !sections.includes(t.key))
  → Next LLM request will not include those schemas or tool definitions
```

### The `drop_context` Tool

The main agent always has this tool in its permanent context:

```json
{
  "name": "drop_context",
  "description": "Remove loaded capability sections from your temporary context. Call this when you no longer need specific tools to free up context space.",
  "parameters": {
    "type": "object",
    "properties": {
      "sections": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Array of capability section keys to drop (e.g., ['capability:stripe', 'capability:acme_crm'])"
      }
    },
    "required": ["sections"]
  }
}
```

The agent decides when to drop. The platform does not force it. This is important: the agent may want to keep Stripe tools loaded across multiple turns if the user is asking follow-up questions about payments.

### Turn-by-Turn Context Hygiene

On every turn, the system prompt includes a reminder when temporary context is loaded:

```
[Injected into system prompt when temporary_context.length > 0]

You currently have the following capability sections loaded in temporary context:
  - capability:stripe (loaded 2 turns ago, 4 tools, ~800 tokens)
  - capability:acme_crm (loaded this turn, 3 tools, ~600 tokens)

If you no longer need any of these, call drop_context to free up context space.
```

This nudge ensures the agent actively manages its context. But the decision is the agent's — it may decide to keep tools loaded if it anticipates needing them again.

### Why This Works

1. **Full conversation context for execution** — The main agent executes tools with the complete conversation history. It knows what the user asked, what was said before, what the nuances are. No information loss from distilling into a sub-agent task.

2. **Agent-controlled context lifecycle** — The agent decides when to load and when to drop. It can keep Stripe tools loaded across 5 turns if the user keeps asking about payments, or drop them immediately after a single query. The platform doesn't impose arbitrary lifecycle rules.

3. **Cheap resolution** — The resolver sub-agent runs on the cheapest model. Its only job: given intent and available tools, pick the right ones. This is a narrow task that cheap models handle well.

4. **Clean separation** — Permanent context (conversation, memories, built-in tools) is always there. Temporary context (external tool schemas) is explicitly loaded and explicitly dropped. The boundary is clear.

5. **Security isolation** — Credentials are still never in the agent's context. The platform intercepts tool calls, resolves `{{secret:...}}` placeholders, injects credentials into the HTTP/MCP request, and erases them after. The agent sees tool schemas (what args to pass) but never credentials.

6. **Parallel capability loading** — The agent can have multiple capability sections loaded simultaneously. Stripe + CRM + Jira tools all in temporary context at once if needed. Drop them independently as each task completes.

### Capability Directory

The main agent always has a compact capability directory in its context — just enough to know what it can delegate:

```
Available capabilities:
  - stripe: Payment data (read-only). Can query charges, balances, customers.
  - acme_crm: Customer relationship management. Can read/create/update contacts and deals.
  - github: Code repositories. Can read issues, PRs, files.
  - slack: Team messaging. Can send messages to channels.
  - jira: Project management. Can create/update tickets.

To use any capability, call resolve_capability with your intent.
```

This costs ~50 tokens for 5 capabilities. Compare to loading full schemas: ~1000+ tokens per capability. The directory is the main agent's "menu" — it picks what it needs, the resolver loads the details into temporary context.

### Companion Skills

Each MCP server or API connector can have **companion skills** — instructions that tell the agent how to use the capability effectively. These are loaded into the agent's temporary context alongside the tool schemas.

```
companion_skills
  id               UUID PK
  library_item_id  UUID FK → library_items — the MCP server or connector
  
  name             TEXT — "Stripe Usage Guide"
  instructions     TEXT — "When querying charges, always include a date range filter.
                          Use stripe_list_charges for transaction lists.
                          Use stripe_get_balance for current balance.
                          Results are paginated — use 'has_more' field to check."
  
  tips             TEXT — "Stripe returns amounts in cents. Divide by 100 for dollars."
  
  common_patterns  JSONB — [
                     { task: "Get recent sales", tools: ["stripe_list_charges"], example_args: { limit: 100 } },
                     { task: "Check balance", tools: ["stripe_get_balance"], example_args: {} }
                   ]
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

Companion skills are created when the MCP server is installed (auto-generated from tool descriptions) and refined by admins or by procedural memory from successful tool usage.

### Credential Injection Syntax

Credential references use a placeholder syntax that the platform resolves at call time. The agent never sees the actual secret value.

```
Placeholder: {{secret:ref_name}}

Example in MCP server config:
  credential_ref: "{{secret:stripe_readonly}}"

Resolution flow:
  1. Credential ref is stored in the capability's config (NOT in agent context)
  2. When the agent calls a tool, the platform intercepts the call
  3. Platform resolves {{secret:stripe_readonly}} via secret management API
  4. Platform injects the resolved value into the MCP server connection / HTTP request
  5. Tool executes with the real credential
  6. Result returned to the agent WITHOUT the credential
  7. Credential erased from platform memory

The placeholder {{secret:...}} appears in:
  - MCP server instance config (transportConfig)
  - API connector auth config
  - Credential override records
  
The placeholder NEVER appears in:
  - Agent message context (permanent or temporary)
  - Tool call arguments
  - Tool call results
  - Conversation history
  - Logs or audit events (replaced with "***" in all logging)
```

### Endpoint Filtering

An MCP server may expose 100+ tools, but most agents only need a few. Endpoint filtering controls which tools the resolver can select and load into temporary context.

```
Configured at assignment time (capability_assignments.enabled_tools):
(see marketplace.md § 5 for the capability_assignments schema)

  Stripe MCP server has 47 tools
  Sales agent assignment: enabled_tools = ["stripe_list_charges", "stripe_get_balance", 
                                            "stripe_list_customers", "stripe_get_customer"]
  → Resolver can only select from these 4 tools, not 47
  → Other 43 tools don't exist in the agent's temporary context
  → Saves ~8,600 tokens of tool schema

  Different agent, different filter:
  Finance agent assignment: enabled_tools = ["stripe_list_payouts", "stripe_get_balance_transactions",
                                              "stripe_list_disputes"]
  → Resolver can select from 3 different tools

When enabled_tools is null → all tools available (use with caution)
```

The main agent's capability directory reflects the filtered set:
```
Instead of: "stripe: 47 tools available"
Shows:      "stripe: Payment queries — charges, balances, customers (4 tools)"
```

### Execution Lifecycle

```
Agent needs an external capability
  │
  ├── 1. RESOLVE PHASE
  │     ├── Main agent calls resolve_capability({ capability: "stripe", intent: "..." })
  │     │
  │     ├── Platform spawns resolver sub-agent (invisible, cheapest model)
  │     │     Context: intent + all enabled tool schemas for capability + companion skill
  │     │     Budget: small (single pass, ~500 output tokens max)
  │     │     Timeout: 5s
  │     │
  │     ├── Resolver selects relevant tools (e.g., 4 out of 47)
  │     │     Returns: selected tool schemas + companion skill
  │     │
  │     └── *** RESOLVER CONTEXT DISCARDED ***
  │           All 47 tool schemas gone. Only the 4 selected schemas survive.
  │           Platform injects them into the main agent's temporary context.
  │
  ├── 2. EXECUTE PHASE (main agent, in conversation)
  │     ├── Main agent now has tool schemas in temporary context
  │     ├── Main agent calls tools directly:
  │     │     ├── Agent reasons about what to call (has full conversation context)
  │     │     ├── Agent makes tool call with arguments
  │     │     ├── Platform intercepts → resolves credential → injects into request
  │     │     ├── HTTP/MCP call executed → result returned to agent
  │     │     ├── Credential erased
  │     │     └── Agent can paginate, retry, adapt — it's the smart model
  │     │
  │     ├── Agent responds to user with results
  │     │
  │     └── Agent continues conversation (tools still in temporary context)
  │
  ├── 3. DROP PHASE (agent-initiated)
  │     ├── Agent calls drop_context({ sections: ["capability:stripe"] })
  │     ├── Platform removes schemas from temporary context
  │     ├── Context space recovered for future turns
  │     └── Or: agent keeps tools loaded for follow-up questions
  │
  └── 4. OUTCOME CAPTURE (see § 6)
        ├── Platform records which tools were called, success/failure, latency
        ├── Stored in memory system (available for future resolution)
        └── Procedural memory updated
```

### Cost Profile

```
Typical capability usage cost:

  Resolver (cheapest model, ~200 tokens intent + ~2000 tokens schemas + ~200 output):
    → ~$0.001 per resolution (gpt-4o-mini pricing)
    → Full schema set discarded immediately after selection
    → Only selected subset enters main agent context

  Execution (main agent — schemas temporarily in context):
    → Schemas add ~200 tokens per tool to the main agent's context
    → 4 tools = ~800 extra tokens per turn while loaded
    → At expensive model pricing: ~$0.003-0.005 per turn with tools loaded
    → Agent drops tools when done → no ongoing cost

  Compare to: keeping ALL tools permanently in context
    → 80 tools × ~200 tokens = 16,000 tokens per turn → $0.05+ per turn
    → Temporary context with 4 tools: 50x cheaper per turn

  Key savings:
    → Resolver filters 47 tools down to 4 (cheap model, one-shot)
    → Agent only pays for tool context while actively using it
    → Dropping context is free and immediate
```

### Tool Call Streaming — Visibility Into What's Happening

Since the main agent executes tool calls directly, the platform streams tool call events to the UI in real time. The user sees what the agent is doing as it happens.

```
Main agent makes tool calls (tools loaded in temporary context)
  │
  ├── Platform intercepts each tool call and streams status events to UI:
  │
  │   Event types:
  │   ├── tool.resolving     { capability: "stripe", intent: "Get last week's sales" }
  │   ├── tool.loaded        { capability: "stripe", tools: ["stripe_list_charges", ...], section: "capability:stripe" }
  │   ├── tool.calling       { tool: "stripe_list_charges", args_summary: "charges from last 7 days" }
  │   ├── tool.result        { tool: "stripe_list_charges", status: "success", summary: "47 charges found" }
  │   ├── tool.calling       { tool: "stripe_list_charges", args_summary: "page 2 (starting_after: ch_xyz)" }
  │   ├── tool.result        { tool: "stripe_list_charges", status: "success", summary: "23 more charges" }
  │   ├── tool.dropped       { section: "capability:stripe", reason: "agent called drop_context" }
  │   └── tool.error         { tool: "stripe_list_charges", error: "Rate limited", retry: true }
  │
  └── What the user sees in the UI:
      
      ┌────────────────────────────────────────────┐
      │ Agent: Let me check Stripe for that data.   │
      │                                              │
      │   ⟳ Loading Stripe tools...                 │
      │     → stripe_list_charges, stripe_get_balance│
      │   ⟳ Querying Stripe...                      │
      │     → Fetching charges (last 7 days)         │
      │     → 47 charges found, paginating...        │
      │     → 70 total charges retrieved              │
      │                                              │
      │ Agent: Last week's Stripe sales totalled     │
      │ $14,230 across 70 charges.                   │
      │                                              │
      │   ✓ Stripe tools unloaded                    │
      └────────────────────────────────────────────┘
```

#### Stream Transport

Tool call events flow through the existing SSE (Server-Sent Events) channel that powers the chat UI:

```
Platform (intercepting agent tool calls)
  │
  ├── Each tool call generates events on the run's event stream:
  │     event: { type: "tool.calling", run_id: main_run_id, tool: "stripe_list_charges", ... }
  │
  ├── Resolution events (resolver sub-agent) are also streamed:
  │     event: { type: "tool.resolving", run_id: main_run_id, capability: "stripe", ... }
  │
  └── SSE stream to the UI includes:
      - Main agent messages (the conversation)
      - Tool call status events (inline progress indicators)
      - Context load/drop events (capability lifecycle indicators)
      
      The UI renders tool events as inline progress indicators
      within the conversation, collapsed when the agent drops the context.
```

#### What Gets Streamed vs What Stays Private

```
STREAMED to the user UI:
  - Which capability was resolved ("Loading Stripe tools")
  - Which tools were loaded ("stripe_list_charges, stripe_get_balance")
  - Each tool call (tool name + argument summary)
  - Result summaries ("47 charges found")
  - Errors and retries ("Rate limited, retrying in 5s")
  - Context drops ("Stripe tools unloaded")

NOT streamed (never leaves the platform):
  - Credential values
  - Raw API responses (only summarized in events)
  - Resolver sub-agent reasoning
  - Full tool schemas (user sees tool names, not the JSON schema)
  - MCP server connection details
```

#### Multiple Capabilities in Parallel

The agent can resolve and use multiple capabilities simultaneously. The UI shows them as concurrent progress streams:

```
┌────────────────────────────────────────────┐
│ Agent: Let me gather that information.      │
│                                              │
│   ⟳ Loading Stripe tools...                 │
│     → Fetching charges (last 7 days)         │
│     → Done: $14,230 across 70 charges        │
│   ✓ Stripe tools unloaded                    │
│                                              │
│   ⟳ Loading Acme CRM tools...               │
│     → Looking up deal "ACME-2024-Q2"         │
│     → Updating deal stage to "closed-won"    │
│     → Done                                   │
│   ✓ CRM tools unloaded                       │
│                                              │
│ Agent: Done. Stripe shows $14,230 in sales,  │
│ and I've updated the deal stage in the CRM.  │
└────────────────────────────────────────────┘
```

### Asynchronous Tools — Long-Running Operations

Some tools take minutes, hours, or even half a day to complete. A deep research task, a batch data export, a CI/CD pipeline — the agent can't block waiting for a result. Async tools run in the background. The agent (and the user) can check on them, get progress updates, and eventually receive the result — including rich HTML output rendered directly in the chat.

#### Sync vs Async Tool Calls

```
SYNCHRONOUS (default):
  Agent calls tool → waits → gets result → continues
  Latency: milliseconds to seconds
  Example: stripe_list_charges, acme_create_contact

ASYNCHRONOUS:
  Agent calls tool → gets a job handle immediately → continues conversation
  Job runs in the background for minutes/hours
  Progress updates stream to the UI
  Agent gets notified when complete
  Example: deep_research, batch_export, run_ci_pipeline
```

A tool declares itself as async in its schema:

```json
{
  "name": "deep_research",
  "description": "Perform deep research on a topic. Takes 5-30 minutes.",
  "async": true,
  "progress": {
    "supports_progress": true,
    "supports_html_output": true,
    "estimated_duration": "5m-30m"
  },
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Research question" },
      "depth": { "type": "string", "enum": ["quick", "standard", "deep", "exhaustive"] }
    },
    "required": ["query"]
  }
}
```

#### Async Job Lifecycle

```
Agent calls async tool
  │
  ├── 1. SUBMIT
  │     Agent calls: deep_research({ query: "...", depth: "deep" })
  │     Platform returns immediately:
  │       {
  │         job_id: "job_abc123",
  │         status: "running",
  │         permalink: "/jobs/job_abc123",
  │         estimated_completion: "2026-04-09T15:30:00Z"
  │       }
  │     Agent receives the handle. Conversation continues.
  │
  ├── 2. PROGRESS (streamed to UI, not to agent context)
  │     Job sends progress updates via SSE:
  │       { job_id: "job_abc123", progress: 0.15, message: "Searching 12 sources..." }
  │       { job_id: "job_abc123", progress: 0.40, message: "Found 34 relevant papers" }
  │       { job_id: "job_abc123", progress: 0.60, message: "Cross-referencing findings..." }
  │       { job_id: "job_abc123", progress: 0.85, message: "Synthesizing report..." }
  │     
  │     These go directly to the UI — not into the agent's context.
  │     The agent doesn't burn tokens on intermediate progress.
  │
  ├── 3. COMPLETION
  │     Job finishes:
  │       {
  │         job_id: "job_abc123",
  │         status: "completed",
  │         result: { ... structured data ... },
  │         html_output: "<div class='research-report'>...</div>",
  │         summary: "Found 34 papers across 12 sources. Key finding: ..."
  │       }
  │     
  │     Platform injects the SUMMARY into the agent's context (not the full result).
  │     The full result + HTML are available via the permalink.
  │     Agent is notified and can reference the result in conversation.
  │
  └── 4. FAILURE / TIMEOUT
        Job fails:
          { job_id: "job_abc123", status: "failed", error: "Source API rate limited" }
        Agent is notified. Can retry or inform the user.
```

#### Async Job Tracking

```
async_jobs
  id               UUID PK
  organization_id  UUID FK → organizations
  agent_id         UUID FK → agents
  run_id           UUID FK → agent_runs — the conversation run that started this
  
  tool_name        TEXT — "deep_research"
  capability       TEXT — "capability:research"
  input_summary    TEXT — redacted summary of the input args
  
  status           ENUM (submitted, running, progress, completed, failed, cancelled, timed_out)
  progress         FLOAT — 0.0 to 1.0
  progress_message TEXT — human-readable progress
  
  result           JSONB — structured result data
  html_output      TEXT — sanitized HTML output (see § HTML Rendering)
  summary          TEXT — compact summary for agent context injection
  error_message    TEXT
  
  permalink        TEXT — "/jobs/{id}" — stable URL to view result
  
  submitted_at     TIMESTAMPTZ
  started_at       TIMESTAMPTZ
  completed_at     TIMESTAMPTZ
  timeout_at       TIMESTAMPTZ — hard deadline, job killed if exceeded
  
  -- Provider info
  provider_job_id  TEXT — external job ID from the tool provider
  provider_status  JSONB — raw status from provider (for debugging)
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
  
  @@index([organization_id, agent_id, status])
  @@index([run_id])
```

#### How the Agent Interacts With Async Jobs

The agent has two permanent tools for async operations:

```json
{
  "name": "check_job",
  "description": "Check the status of an async job. Returns current progress and result if complete.",
  "parameters": {
    "properties": {
      "job_id": { "type": "string" }
    },
    "required": ["job_id"]
  }
}

{
  "name": "cancel_job",
  "description": "Cancel a running async job.",
  "parameters": {
    "properties": {
      "job_id": { "type": "string" },
      "reason": { "type": "string" }
    },
    "required": ["job_id"]
  }
}
```

The agent doesn't need to poll. When a job completes, the platform injects a notification into the agent's context on the next turn:

```
[System notification — injected at start of next agent turn]

Async job completed:
  Job: deep_research (job_abc123)
  Status: completed
  Summary: "Found 34 papers across 12 sources. Key finding: ..."
  Permalink: /jobs/job_abc123
  
  The full result and visual report are available at the permalink.
  You can reference the summary in your response to the user.
```

If the user asks about the job before it completes, the agent calls `check_job` and relays the progress.

#### UI Rendering — In-Chat Progress and Results

Async jobs have their own visual treatment in the chat, distinct from synchronous tool calls:

```
┌────────────────────────────────────────────────────────┐
│ User: Can you research the latest developments in       │
│ quantum error correction?                               │
│                                                         │
│ Agent: I'll start a deep research task on that.         │
│ This usually takes 10-20 minutes.                       │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 🔬 Deep Research: Quantum Error Correction           │ │
│ │                                                      │ │
│ │ ████████████░░░░░░░░░░░░░░░  40%                    │ │
│ │ Found 34 relevant papers                             │ │
│ │ Cross-referencing findings...                        │ │
│ │                                                      │ │
│ │ Started 8 minutes ago · Est. 12 min remaining        │ │
│ │ [View details →]                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ User: While that's running, can you also check our       │
│ team's sprint velocity?                                  │
│                                                         │
│ Agent: Sure, let me pull that from Jira...               │
│   ⟳ Loading Jira tools...                               │
│   ...                                                    │
└────────────────────────────────────────────────────────┘
```

When the job completes, the progress card transforms into a result card:

```
┌─────────────────────────────────────────────────────┐
│ ✓ Deep Research: Quantum Error Correction            │
│                                                      │
│ ┌──────────────────────────────────────────────────┐ │
│ │                                                   │ │
│ │   [Custom HTML output rendered here]              │ │
│ │   - Designed by the tool provider                 │ │
│ │   - Interactive charts, formatted tables,         │ │
│ │     collapsible sections, citations               │ │
│ │   - NOT in an iframe — native DOM elements        │ │
│ │                                                   │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ Completed in 18 minutes · 34 papers · 12 sources     │
│ [Permalink: /jobs/job_abc123]                        │
└─────────────────────────────────────────────────────┘
```

The conversation continues below the result card. The agent can reference the findings in subsequent messages.

#### Custom HTML Output — Rendering Model

Async tool providers can return custom HTML that renders directly in the chat. This is **not an iframe** — the HTML is injected into the chat DOM. This gives providers full control over the visual presentation of complex results (research reports, data visualizations, interactive tables).

**Why not iframe?** Iframes create scroll-within-scroll, break the chat flow, can't adapt to theme/styling, and feel disconnected from the conversation. Direct DOM injection means the output feels like a native part of the chat.

**The security cost:** Every provider that returns HTML is injecting code into the user's UI. This requires strict vetting.

```
HTML output pipeline:

  1. Tool provider returns html_output in the job result
     │
  2. Platform sanitization layer:
     │  ├── Allowlisted tags only (see below)
     │  ├── All attributes validated against allowlist
     │  ├── No <script>, no event handlers (onclick, onerror, etc.)
     │  ├── No external resource loading (img src, link href to external domains)
     │  ├── All URLs validated (no javascript:, no data: with executable types)
     │  ├── CSS scoped to the output container (no global style leakage)
     │  └── DOMPurify (or equivalent) as the final sanitization pass
     │
  3. Platform wraps in scoped container:
     │  <div class="async-tool-output" data-provider="{provider_id}" 
     │       data-job="{job_id}" style="all: initial;">
     │    {sanitized HTML}
     │  </div>
     │
  4. Rendered in chat as native DOM
```

**Allowlisted HTML tags:**

```
Layout:     div, span, section, article, header, footer, nav, main, aside
Text:       p, h1-h6, strong, em, b, i, u, s, mark, small, sub, sup, br, hr
Lists:      ul, ol, li, dl, dt, dd
Tables:     table, thead, tbody, tfoot, tr, th, td, caption, colgroup, col
Code:       pre, code, kbd, samp, var
Media:      img (src must be data: image/* or provider-hosted allowlisted domain)
            svg (heavily restricted — no foreignObject, no script, no use with external href)
Links:      a (href must be https:// to allowlisted domains, always target="_blank" rel="noopener")
Semantic:   blockquote, cite, abbr, time, details, summary, figure, figcaption

NEVER allowed:
  script, style (inline only via allowlisted properties), iframe, object, embed, 
  form, input, textarea, button, select, video, audio, canvas, 
  template, slot, portal, dialog
```

**Allowlisted CSS properties** (inline only, via style attribute):

```
Layout:     display, flex, grid, gap, margin, padding, width, height, max-width, 
            max-height, min-width, min-height, overflow, position (relative only)
Text:       font-size, font-weight, font-style, font-family (system fonts only),
            line-height, text-align, text-decoration, letter-spacing, word-spacing, color
Visual:     background-color, border, border-radius, box-shadow, opacity
Table:      border-collapse, border-spacing, vertical-align

NEVER allowed:
  position: fixed/absolute/sticky, z-index, content, cursor, pointer-events,
  animation, transition, transform, filter, clip-path, background-image (url()),
  any url() value, any expression() value, any -moz-binding value
```

#### Provider Vetting for HTML Output

Any tool provider that sets `supports_html_output: true` goes through additional security review. This is not automatic — it requires manual vetting by the Nessie team or the organization's security admin.

```
async_tool_providers
  id               UUID PK
  organization_id  UUID FK → organizations (null for platform-level providers)
  
  provider_name    TEXT — "Nessie Deep Research", "Acme Analytics"
  provider_slug    TEXT UNIQUE
  
  -- What this provider can do
  supports_html    BOOLEAN DEFAULT false
  html_approved    BOOLEAN DEFAULT false — requires explicit approval
  html_approved_by UUID FK → users
  html_approved_at TIMESTAMPTZ
  
  -- Vetting status
  vetting_status   ENUM (pending, under_review, approved, rejected, revoked)
  vetting_notes    TEXT — reviewer notes
  last_audit_at    TIMESTAMPTZ — when the provider's HTML output was last reviewed
  audit_frequency  INTERVAL DEFAULT '90 days' — how often to re-audit
  
  -- What domains this provider can link to / load images from
  allowed_domains  TEXT[] — ["cdn.acme-research.com", "charts.acme.com"]
  
  -- Security constraints
  max_html_size    INT DEFAULT 102400 — 100KB max per output
  max_img_count    INT DEFAULT 20 — max images per output
  sandbox_level    TEXT DEFAULT 'strict' — "strict" | "standard" | "permissive"
  
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ
```

**Vetting process:**

```
Provider submits tool with supports_html_output: true
  │
  ├── 1. AUTOMATIC CHECKS
  │     ├── Static analysis of sample HTML outputs
  │     ├── Sanitizer dry run — does the output survive sanitization intact?
  │     ├── Size and complexity checks
  │     └── Domain analysis — where do links/images point?
  │
  ├── 2. MANUAL REVIEW (required)
  │     ├── Security reviewer examines sample outputs
  │     ├── Checks for obfuscation, unusual patterns
  │     ├── Verifies the provider's identity and reputation
  │     ├── Reviews the provider's allowlisted domains
  │     └── Decision: approve / reject / request changes
  │
  ├── 3. ONGOING MONITORING
  │     ├── Every HTML output is sanitized at runtime (always, even for approved providers)
  │     ├── Outputs that trigger sanitizer warnings are flagged for review
  │     ├── Periodic re-audit per audit_frequency
  │     └── Anomaly detection: if HTML patterns change significantly → auto-pause + review
  │
  └── 4. REVOCATION
        If a provider is found to be injecting malicious content:
        ├── Immediate revocation (html_approved = false)
        ├── All pending/running jobs from this provider are paused
        ├── Admin notified with details of the violation
        └── Provider must re-submit for vetting
```

#### Async Job API

```
POST   /api/jobs                    — list async jobs (with filters: status, agent, capability)
GET    /api/jobs/{id}               — get job details, progress, result
GET    /api/jobs/{id}/html          — get sanitized HTML output for rendering
POST   /api/jobs/{id}/cancel        — cancel a running job
DELETE /api/jobs/{id}               — delete a completed/failed job
GET    /api/jobs/{id}/events        — SSE stream of progress events for this job

GET    /api/providers               — list async tool providers
GET    /api/providers/{id}          — get provider details + vetting status
POST   /api/providers/{id}/approve  — approve provider for HTML output (admin only)
POST   /api/providers/{id}/revoke   — revoke provider approval (admin only)
```

#### What Lives Where

Not everything goes through the resolve → load → drop cycle. Built-in tools (Bash, FileRead, Grep, WebSearch) are lightweight and frequently used — they stay in permanent context.

```
PERMANENT CONTEXT (always present):
  - Built-in tools (~6 tools, ~1,200 tokens)
  - Conversation history
  - Capability directory
  - Procedural memories
  - resolve_capability, drop_context, check_job, cancel_job tools

TEMPORARY CONTEXT (loaded on demand, agent-managed):
  - MCP server tool schemas (loaded via resolver)
  - API connector tool schemas (loaded via resolver)
  - Companion skills for loaded capabilities
  - Dropped by agent when no longer needed

ASYNC (runs outside of context entirely):
  - Long-running jobs (deep research, batch ops, CI pipelines)
  - Progress streamed to UI, not to agent context
  - Summary injected into agent context only on completion
  - Full result + HTML accessible via permalink
```

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

When a capability is resolved and loaded into temporary context, relevant procedural memories are injected alongside the tool schemas:

```
Resolver loads "acme_crm" into temporary context
  │
  ├── Tool schemas loaded (input/output definitions)
  │
  ├── Companion skill loaded
  │
  └── Procedural memory injected (if exists):
        "Previous experience with acme_create_contact:
         - Works reliably with email + name
         - 422 error means duplicate — search first
         - Rate limit: 60/min
         - Typical response time: ~300ms"
```

When the agent drops the capability context, the tool schemas and companion skill are removed. The procedural memory stays in the permanent memory system — available for future retrieval when the agent considers using the capability again.

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
  ├── Agent checks capability directory:
  │     "acme_crm: Customer relationship management. Can read/create/update contacts and deals."
  │     → Agent knows which capability to resolve
  │
  ├── Agent checks procedural memory:
  │     "I've used acme_update_deal before — it works for changing deal stages"
  │     → Agent has context for how to use it
  │
  ├── Agent calls resolve_capability({ capability: "acme_crm", intent: "update deal stage" })
  │     → Resolver selects acme_update_deal + acme_get_deal
  │     → Schemas + companion skill loaded into temporary context
  │
  ├── Agent executes the tool calls directly (with full conversation context)
  │
  ├── Agent calls drop_context({ sections: ["capability:acme_crm"] })
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
MCP servers and API connectors are scoped to system/organization/project/team/channel/user. An agent can only discover and use tools visible at its scope level. Credentials can be overridden at any scope level for multi-tenant scenarios.

### 6. External knowledge bases are just connectors
Nessie is not in the business of building wikis or knowledge bases. Every company already has one — Confluence, Notion, GitHub Wiki, SharePoint, Google Docs, or something custom. These are just connectors in the marketplace, no different from a CRM or calendar connector.

Agents use knowledge base connectors for **long-term, human-readable knowledge**: documentation they produce, runbooks they write, decisions they record. This is distinct from Nessie's internal memory system:

| | Nessie Internal Memory | External Knowledge Base |
|---|---|---|
| **Purpose** | Operational agent memory — what the agent needs to do its work | Persistent, human-readable knowledge — documentation, wikis, decision records |
| **Audience** | Agents (and humans via admin UI) | Humans (and agents via connectors) |
| **Format** | Structured thoughts, embeddings, procedural records | Wiki pages, documents, articles |
| **Lifetime** | Decays, garbage-collected, agent-managed | Permanent until a human deletes it |
| **Examples** | "Deploy tool works with email+name" (procedural), "Team decided to use Valkey" (semantic) | "Valkey Migration Runbook" (Confluence page), "Q2 Architecture Decisions" (Notion doc) |
| **How agents use it** | Automatic retrieval via memory search | Explicit tool calls via knowledge base connector |

The pattern: an agent extracts intelligence from a conversation (internal memory), and if the outcome is significant enough, it writes a structured document to the company's knowledge base via a connector (Confluence, Notion, etc.). The agent doesn't store the wiki page — it stores the fact that it wrote a wiki page and where to find it.

---

## What Needs Full Design

1. **Trusted MCP server process management** — if platform-managed stdio servers are ever reintroduced, define how they are vetted, spawned, supervised, and terminated without enabling user-authored subprocess execution
2. **OAuth2 token lifecycle** — refresh flow, token caching, multi-tenant token isolation
3. **Tool schema versioning** — when an MCP server updates its tools, how to detect and handle schema changes
4. **Rate limit coordination** — multiple agents sharing one API connector must respect shared rate limits
5. **Webhook-based tools** — some APIs push results via webhook instead of returning them synchronously
6. **GraphQL connector** — REST is covered; GraphQL needs its own endpoint definition model (query/mutation strings, variable schemas)
7. **Bulk tool loading** — agent needs a category of tools at once (e.g., "load all CRM tools") without listing each one
8. **Tool dependency chains** — some tools require results from other tools as input; how to express this
9. **Context budget allocation** — how to split context budget between tool schemas, procedural memory, conversation history, and task context
10. **Cross-org tool sharing** — marketplace contributions from one org available to others (with review/trust model)
