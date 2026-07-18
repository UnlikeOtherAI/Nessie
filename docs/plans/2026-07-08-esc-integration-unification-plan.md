# ESC Integration Unification Plan

Status: active plan.

Working name: **ESC** means "External Services Console" in this document. The
name can change, but the architectural boundary should not: ESC is the unified
Nessie surface for first-party sibling products and installable third-party
capabilities.

## Goal

Make Nessie, Deep Water, DeepTest, buildme.live, and UnlikeOtherAuthenticator
work as one product family without collapsing their codebases or ownership
boundaries.

The target experience:

- users sign in once through UOA and can see which sibling products are linked;
- team/workspace owners enable sibling products once for the active team, then
  users inherit access through shared SSO;
- Nessie shows the sibling products in the left rail as launchable integrations;
- each product can also be installed as a Nessie plugin/capability bundle;
- Nessie agents can use each product through approved MCP tools;
- Deep Water research can be run natively from Nessie and its reports, sources,
  evidence, and cost appear inside Nessie;
- DeepTest can be launched from Nessie for security review, with local/privacy
  boundaries preserved;
- buildme.live can initially link out, then later act as an alternative project
  management data source for Nessie's project boards.

## What The Existing Repos Already Provide

### Nessie

Relevant existing foundations:

- authenticated product UI in `admin/`;
- top-level rail navigation driven by `admin/src/layouts/admin-shell/nav-items.tsx`;
- project boards and Kanban under `/projects`;
- Knowledge spaces and pages in `packages/knowledge`;
- all blob storage through `@nessie/runtime` `FileService`;
- MCP catalog, instance probing, tool projection, tool grants, and dispatch under
  `api/src/services/mcp-*`, `api/src/services/tool-*`, and worker dispatch;
- connector and token usage ledgers in `api/src/services/token-ledger.ts`;
- marketplace/library target-state docs for installable MCP servers, API
  connectors, skills, workflows, and generated plugins.

### Deep Water (`water`)

Observed capabilities:

- async research API and project/version model;
- rich depth/config/cost surface;
- usage and spend reporting;
- hosted OAuth 2.1 + protected HTTP MCP at `/mcp` behind `OAUTH_ENABLED`;
- published MCP package with tools for research creation, polling, sources,
  public reports, API keys, usage, and webhook configuration;
- report artifacts with evidence, sources, citations, and full-report Markdown.

This is the best first native integration.

### DeepTest (`deeptest`)

Observed capabilities:

- local-first HTTP API on `localhost:4877` and MCP as the primary interface;
- recommended `deeptest_review` entry point;
- many lower-level MCP tools for sessions, OpenAPI mapping, repo security scan
  suites, review-profile runs, model-fusion local CLI slices, quality reports,
  share-safe reports, knowledge packs, and content-free metering;
- strong privacy model: target material is local/session-scoped by default;
- UOA account model design already distinguishes UOA identity from DeepTest
  product org/team authorization.

Nessie should initially link out or connect to a user/local DeepTest MCP server.
It should not import raw target material into Nessie by default.

### buildme.live

Observed capabilities:

- current checkout documents a cloud-hosted persistent Linux development
  environment more than a project-management system;
- SSO is delegated to `authentication.unlikeotherai.com`;
- no project-management API or Kanban implementation was visible in this
  checkout beyond docs and POC assets.

Treat buildme.live as a link-out integration first. The later "alternative
project data source" requires an explicit BuildMe project-board API contract.

### UnlikeOtherAuthenticator (`UnlikeOtherAuthenticator`)

Observed capabilities:

- UOA is the shared OAuth/auth service;
- UOA already models domains, orgs, teams, apps, app startup payloads, feature
  flags, and kill switches;
- the Slack-style login/workspace work is present in the repo: workspace chooser
  UI, create-workspace card, invite cards, membership lifecycle, team join
  policies, invite links, and access-token `active { orgId, teamId }` claims;
- no connected-products/product-entitlement table was found in UOA yet.

UOA is the right place for team/workspace creation, workspace selection,
membership lifecycle, and a cross-product connected-app/account-linking screen.
Nessie should consume UOA account and active-workspace context, not re-invent
product identity or team creation.

## Architecture

### 1. Product Registry

Add a Nessie-owned registry for sibling product integrations. This is distinct
from the MCP catalog:

```text
integrated_products
  id
  slug                         # deep-water | deeptest | buildme
  name
  category                     # research | security | development | project-management
  launch_url
  api_base_url
  auth_mode                    # uoa_sso | api_key | oauth_mcp | local_mcp
  default_install_state        # link_only | installable | native
  mcp_catalog_entry_id?
  plugin_manifest_ref?
  health_status
  created_at
  updated_at

product_account_links
  id
  organization_id
  user_id
  product_slug
  uoa_sub
  external_account_id?
  active_org_id?
  active_team_id?
  status                       # linked | needs_auth | revoked | error
  last_verified_at
  metadata_json

product_team_enablements
  id
  organization_id
  team_id
  product_slug
  enabled
  external_org_id?
  external_team_id?
  configured_by_user_id?
  metadata_json
```

`uoa_sub` is nullable in Nessie's local projection so self-hosted/local
installations can represent local MCP or API-key integrations before a UOA
identity is attached. UOA remains the source of truth for hosted cross-product
identity.

Team/workspace product enablement must not create a second team model in Nessie.
The preferred source of truth is a UOA connected-products entitlement keyed to
UOA's active `teamId`. Until UOA exposes that API, Nessie may maintain only a
temporary projection/cache keyed to UOA `active.teamId`, never a separate
workspace creation path. `product_account_links` remains the per-user SSO/account
projection and should not be used as the installation decision. Team-scoped
billing can later aggregate from UOA's active `teamId`.

Current team-enable slice:

- `product_team_enablements` stores the active Nessie team's product switch and
  optional UOA active org/team IDs captured from the user's account link.
- API responses expose `teamEnablement.authority`, currently
  `nessie_projection`, so clients do not infer source-of-truth from ad hoc
  metadata. The enum already reserves `uoa_connected_products` for the later
  UOA-backed entitlement source.
- `GET /api/integrations/products` returns both `accountLink` and
  `teamEnablement`, so the UI can show account state separately from team access.
- `PATCH /api/integrations/products/:productSlug/team-enablement` lets an owner
  enable/disable the active team. It validates that the team belongs to the
  current Nessie organization and does not create or mirror UOA teams.
- This remains a Nessie projection until UOA exposes the connected-products
  entitlement API; at that point the table should become cache/audit state or be
  replaced by a UOA-backed read model.

The product registry powers the ESC UI. The MCP catalog powers agent tools.
They can point to the same product, but they are not the same object.

### 2. ESC Rail Surface

Add a new top-level rail section: **Integrations**.

Desktop placement: left rail, near the top, before or after Projects. It opens
`/integrations`.

Mobile/native placement: do not add a sixth permanent tab until product review;
put Integrations under Admin or expose it from the workspace menu initially.

`/integrations` should have three layers:

- installed products: launch cards for Deep Water, DeepTest, and buildme.live;
- plugin/library state: installed, needs setup, active, paused, error;
- account state: linked through UOA, needs product auth, local-only, or admin
  setup required.

Do not put plugin configuration inside the left rail itself. The rail only
launches the section; product cards and detail pages own configuration.

Current Nessie slice:

- `/integrations` is a full-width shell route with no secondary channel sidebar;
- desktop rail exposes Integrations between Projects and Knowledge;
- mobile web does not add Integrations as a sixth permanent tab;
- the page renders registry-backed product rows, manifest details, native page
  intent, chat cards, custom controls, agent/MCP access, artifacts, and next
  setup step.
- Deep Water and DeepTest product rows now point at public, published MCP
  catalog entries. BuildMe remains unlinked to the MCP catalog until a board API
  and MCP contract exist.
- `GET /api/integrations/products` now includes the active team's shared MCP
  installation summary for each MCP-backed product, preferring team scope and
  then falling back to organization/system scope. The ESC page shows that agent
  connector state and deep-links to the matching MCP catalog entry.
- When an MCP-backed product has no shared connector installed, ESC now links
  directly to `/mcp-app-store?catalogEntryId=...&action=install`, and the MCP
  store opens its validated install dialog for that catalog entry. Install
  scope, credential refs, duplicate checks, probing, and tool approval stay in
  the existing MCP install path rather than being duplicated inside ESC.
- `GET /api/integrations/products` also includes a month-to-date connector
  usage summary for each product. For MCP-backed products, usage is read from
  `connector_usage_events.connector_id = mcp_server_instances.id`; future native
  wrappers can also tag rows with `metadata.productSlug`. ESC renders calls,
  units, spend, last activity, and failures without introducing a second
  accounting path.
- Deep Water now has a native ESC launcher gated by team enablement and an
  active shared MCP connector. **Enabling Deep Water for a team now provisions
  that connector automatically:** `PATCH
  /api/integrations/products/deep-water/team-enablement` (owner-only) creates a
  team-scoped, tool-projecting `McpServerInstance` from the `deep-water` catalog
  entry and projects the plugin manifest's `research_*` tools into
  `ToolRegistryEntry` as `active` (surfaced to agent runs as `mcp_research_*`);
  disabling deactivates and removes it. Because the install is team-scoped it
  reaches **every** agent run inside the team — personal assistant and shared
  agents alike — so the tools are grantable to any permitted agent through its
  per-agent tool policy (default off). Deep Water now routes exclusively through
  Ledger's bearer-authenticated MCP adapter. Nessie's shared ProxyToken
  authenticates the service, while a signed UOA delegation plus Nessie
  org/team/user/agent/run context assigns the job and spend to the verified
  caller. Personal credential overrides are forbidden. Ledger owns research
  isolation, budget enforcement, audit, and booked rate-card charge while the
  deterministic tool contract still comes from the plugin manifest. `POST
  /api/integrations/products/deep-water/research-launch` creates or loads the
  user's Personal Assistant DM, posts a server-built launch message carrying a
  `deep_research` `uiCards` card, and enqueues the PA so it can call the
  approved Ledger MCP tools (`mcp_research_start`, then
  `mcp_research_status` and `mcp_research_report`). This gives the UI a real
  launch path without bypassing MCP approval/grants or Ledger accounting. Nessie
  now also creates a durable
  `product_integration_runs` projection for each Deep Water launch and exposes
  recent active-team runs through `GET
  /api/integrations/products/deep-water/research-runs`. Any granted agent —
  personal assistant or shared — can call the `deep_water_run_update` builtin
  after Deep Water MCP calls to project external run id, status, source count,
  cost, report URL, and Knowledge draft page id into that durable record.
  Terminal write-back now reconciles an authoritative Ledger
  `cost: { amount, currency }` into `connector_usage_events` exactly once when
  returned; it leaves Nessie's mirror empty rather than estimating when Ledger
  omits cost. Autonomous polling and Knowledge import jobs remain Phase 2 work.
- DeepTest now has a privacy-safe ESC handoff panel gated by team enablement and
  an active shared MCP connector. `POST
  /api/integrations/products/deeptest/security-handoff` accepts only controlled
  depth/runner/share-safe-import choices; it rejects target URLs, source code,
  PR diffs, prompts, findings, reports, and other freeform target material by
  schema. It creates a Personal Assistant message carrying a `security_review`
  card and instructs the PA to use the approved local `mcp_deeptest_review`
  tool only after the user has configured the target inside DeepTest/local
  runner. Share-safe import remains the default; raw owner-local artifacts stay
  outside Nessie unless a later explicit import flow is built.
- BuildMe now has an explicit ESC link-out handoff panel gated by team
  enablement and the user's UOA account link. `POST
  /api/integrations/products/buildme/project-handoff` accepts only a controlled
  handoff intent and active-project/team context scope, then creates a Personal
  Assistant message carrying a `project_board` readiness card. It does not
  accept board ids, column mappings, card payloads, workspace files, credentials,
  or sync instructions. Native board rendering remains blocked on the BuildMe
  board-source API/MCP contract in
  `docs/integrations/buildme-board-source-contract.md`.

Current UOA/auth slice:

- UOA already owns Slack-style workspace/team identity. Its `Team` is the
  workspace, `Organisation` is the higher grouping, and `/auth/select-team`
  carries the chosen workspace into access/refresh tokens.
- Nessie's UOA config JWT now requests `org_features.enabled` and
  `allow_user_create_org` so UOA can expose workspace membership/create state
  through its existing SSO flow.
- Nessie's UOA token exchange now decodes `sub`, `org`, and
  `active { orgId, teamId }` claims. It stores them only as external
  product-account projection data; Nessie does not create local teams from UOA.
- UOA login now upserts `product_account_links` for first-party sibling products
  in the current Nessie organization/user context. Those rows carry the UOA
  subject and active external org/team IDs for UX and future handoff, not team
  entitlement authority.
- Team/workspace product enablement now has a Nessie projection for the active
  local team, annotated with UOA active team IDs where available. It still needs
  a UOA connected-products entitlement API before it can become the cross-product
  source of truth.
  The current API/UI labels that distinction explicitly as `nessie_projection`
  rather than treating the local row as permanent authority.
  First-registration create/join remains an SSO/Auth-window concern in UOA, not
  a Nessie-owned onboarding fork.

### 3. Interface Surface Contract

Nessie should display product work in three UI surfaces, all declared by product
or plugin metadata rather than hard-coded product internals:

- **custom pages** for durable product workflows and history, such as Deep Water
  research runs, DeepTest local runner state, or BuildMe board pairing;
- **chat cards** for transient agent/user work inside conversations, such as
  research progress, security review summaries, cost, sources, and safe report
  links;
- **custom controls** for launch/configuration state, such as Deep Water depth
  and import destination, DeepTest review profile and local-runner target, or BuildMe column
  mapping.

Chat cards use the existing `Message.metadata` channel. Product integrations and
agents should emit:

```json
{
  "uiCards": [
    {
      "kind": "deep_research",
      "productSlug": "deep-water",
      "title": "Market scan",
      "status": "running",
      "summary": "Collecting sources",
      "fields": [{ "label": "Budget", "value": "$4.00 cap" }],
      "actions": [{ "label": "Open run", "href": "/integrations", "variant": "primary" }]
    }
  ]
}
```

The supported card kinds are currently `integration`, `deep_research`,
`security_review`, and `project_board`. The supported statuses are `idle`,
`queued`, `running`, `needs_setup`, `completed`, `failed`, and `warning`.

Cards are not a storage layer. Finished reports, source bundles, security
reports, screenshots, and PDFs must still become Knowledge/FileService artifacts
when they need to persist beyond the conversation.

Current Deep Water launcher slice:

- ESC renders Deep Water controls for title, prompt, depth, chapter detail,
  output tier, language, search quality, recency, section count, searches per
  pillar, and artifact destination.
- Ledger's MCP start contract accepts only `query`, optional `context`, depth
  `light|standard|deep|heavy`, and recency `any|recent`. The handoff maps
  `thesis|dissertation` to `heavy`, maps every non-`any` launcher recency to
  `recent`, and carries chapter/output/language/search/section controls inside
  the optional context string rather than sending unsupported top-level args.
- The launch message asks the PA to import the completed report as a Knowledge
  draft and request publication when `artifactDestination=knowledge_draft`.
- ESC now shows recent Deep Water launch records from Nessie's durable
  `product_integration_runs` projection, including status, launch options,
  PA chat destination, report link, Knowledge draft link, status detail, and
  source/cost fields when the PA writes them back. Cost is copied only from
  Ledger's terminal booked rate-card charge; this is not a provider-invoice
  actual and complex runs may reconcile higher upstream.
- Automatic progress polling, cost reconciliation, and import without PA
  mediation still belong to the Phase 2 completion wrapper. The current
  write-back path is explicit PA bookkeeping around the approved MCP flow, not
  an independent background worker. The launch handoff starts the Ledger job,
  persists `running`, optionally checks status once, and ends the bounded agent
  turn; a later user/status turn checks once more and fetches the report only
  after completion. It never busy-polls a roughly 20-minute job. Terminal PA
  write-back mirrors the immutable Ledger-booked terminal rate-card charge into
  Nessie's connector usage ledger with an
  idempotent per-run marker.
- ESC renders DeepTest controls for review depth, runner boundary, and
  share-safe/external-link report handoff. It intentionally has no text field for
  target URLs, repo paths, source, PR diffs, findings, prompts, or raw reports.

### 4. UOA Account Linking

Add a UOA screen, not a Nessie-only screen:

```text
Account -> Connected Products
  Nessie
  Deep Water
  DeepTest
  buildme.live
```

Each row shows:

- product icon/name/domain;
- linked active org/team/workspace;
- account status;
- connect/reconnect/revoke actions;
- what scopes the product is allowed to request.

UOA should expose a backend-readable product-link status endpoint for relying
products:

```text
GET /org/me                  # active org/team and membership context
GET /apps/startup            # app flags/startup status
GET /account/connected-apps  # proposed: cross-product link state
POST /account/connected-apps/:slug/revoke
```

Nessie should store only the local projection it needs for UX, caching, audit,
and per-team setup. UOA remains the source of truth for identity and global
account linking.

### 5. Installable Plugin Model

Every sibling integration must ship in two forms:

- a first-party ESC product card for hosted users;
- an installable plugin/capability bundle for open-source/self-hosted Nessie.

The plugin manifest should declare:

- product slug and display metadata;
- link-out URL templates;
- auth requirements;
- MCP server catalog entry or remote MCP URL;
- exposed UI panels, if any;
- Knowledge import/export behavior;
- usage/cost ledger mapping;
- security review notes.

Current Nessie slice:

- first-party `NessieIntegrationPlugin` manifests exist for Deep Water,
  DeepTest, and buildme.live;
- manifests are API-versioned as `integrations.nessie.io/v1`;
- `GET /api/integrations/products/:productSlug/manifest` returns the selected
  manifest for authenticated users;
- the `/integrations` product detail page renders install modes, MCP/catalog
  intent, declared tools, available UI surfaces, and privacy/import policy;
- the manifest is intentionally product-level. Tool execution still requires
  MCP catalog installation, tool discovery/projection, admin approval, and
  agent/role grants through the existing tool registry.
- UOA active-workspace projection is implemented for first-party
  `product_account_links`.
- Owner-controlled `product_team_enablements` are implemented as a Nessie
  projection for the active team. UOA remains the desired workspace entitlement
  authority once the connected-products API exists.
- DeepTest's manifest now marks the recommended `deeptest_review`, share-safe
  report retrieval, and content-free metering tools as available. The native
  ESC handoff panel is available; durable review history and explicit Knowledge
  import remain later work.

Manifest skeleton:

```json
{
  "apiVersion": "integrations.nessie.io/v1",
  "kind": "NessieIntegrationPlugin",
  "manifestRef": "first-party/deep-water",
  "productSlug": "deep-water",
  "install": [{ "mode": "api_key", "availability": "both" }],
  "mcp": {
    "catalogTemplate": {
      "name": "deep-water",
      "protocol": "http",
      "authMethod": "bearer",
      "transport": { "transport": "http", "urlEnv": "LEDGER_DEEPWATER_MCP_URL" }
    },
    "toolBundleRef": "first-party/deep-water-tools",
    "tools": []
  },
  "ui": { "pages": [], "cards": [], "controls": [] },
  "artifacts": [],
  "privacy": {
    "dataBoundary": "...",
    "defaultImportPolicy": "...",
    "prohibitedByDefault": []
  },
  "usage": {
    "ledger": "connector_usage_events",
    "connectorType": "mcp",
    "costFields": []
  }
}
```

Hosted Nessie can preinstall first-party products. Open-source Nessie should be
able to install the same products manually from the marketplace/library.

### 6. MCP And Agent Access

All product functionality that agents need must enter Nessie through the MCP
catalog/tool registry:

- install MCP server or HTTP API connector;
- probe/discover tools;
- project discovered tools into `ToolRegistryEntry` with `pending_review`;
- admin approves tools;
- grant tools to roles/agents/scopes;
- worker dispatch executes approved tools;
- outcome and cost are recorded.

Nessie agents must not hold product API keys in prompts. Credentials resolve
through the existing secret/credential chain and dispatch plan.

First-party team-enabled products (Deep Water) auto-provision this path: the
owner's `team-enablement` toggle stands in for the manual install + admin
approve steps, so the team-scoped instance's projected tools are marked
`active` (grantable) at enable time. Per-agent grant stays the real gate and
defaults off. Third-party/user connectors keep the full `pending_review` +
admin-approve flow.

### 7. Durable Artifacts

Deep research and security outputs should not live only as chat text.

Use Nessie Knowledge for durable documents:

- Deep Water report page;
- Deep Water sources/evidence pages or attachments;
- DeepTest share-safe report page;
- DeepTest owner-local report links when the local boundary permits it.

Use `FileService` for imported files or generated PDFs. No route, tool, or
import job may bypass `createFileService`.

### 8. Cost And Usage

Use the existing ledgers:

- model/provider calls stay in `token_ledger_events`;
- product/API operations stay in `connector_usage_events`;
- Deep Water imported job cost should become connector usage rows through the
  existing connector enum (`mcp`, `http`, or `other`) plus a product slug /
  connector id in metadata, not a new enum value per product;
- DeepTest content-free metering should remain content-free and should not
  include target labels, URLs, repo names, findings, prompts, or reports.

The ESC product detail page should show:

- month-to-date calls/spend for that product; **implemented from
  `connector_usage_events` for selected MCP instances and product-tagged rows**
- current health;
- recent job/review history;
- which agents can use it.

## Product-Specific Integration Paths

### Deep Water: Native Integration First

Phase 1 native slice:

1. Add Deep Water product card in ESC.
2. Add first-party plugin manifest and MCP catalog entry.
3. OAuth/API-key setup:
   - hosted: UOA/OAuth MCP where available;
   - self-hosted: API key secret ref.
4. Expose tools to agents:
   - create research;
   - get research;
   - list research;
   - run a scoping conversation before launch.
5. Add Nessie job wrapper:
   - create a Nessie async job/run when a user or agent launches research;
   - poll or subscribe to Deep Water progress;
   - write progress into agent activity and run history.
6. Import results:
   - report Markdown -> Knowledge page;
   - source list/evidence -> child Knowledge pages or file attachments;
   - public/deepwater report URL -> metadata;
   - cost -> connector usage ledger.

Acceptance:

- a user can start Deep Water research from Nessie;
- an agent can start and poll research only when granted the tool;
- the finished report appears in a Nessie Knowledge space;
- the Sources and cost are visible in Nessie;
- revoking the plugin removes agent access without deleting imported documents.

### DeepTest: Link-Out And Local MCP First

Phase 1:

1. Add DeepTest product card in ESC.
2. Add link-out to the local/hosted DeepTest workspace.
3. Add plugin manifest for a local MCP server installation:
   - command-based stdio for self-hosted/local Nessie only;
   - remote/local-loopback bridge for hosted Nessie only if it uses the
     remote-worker/MCP runner pattern and preserves DeepTest's privacy boundary.
4. Register a first tool bundle around the recommended `deeptest_review` entry
   point and safe status/report retrieval tools.
5. Keep raw target material out of Nessie unless the user explicitly imports a
   share-safe or owner-local artifact.

Acceptance:

- Nessie can show DeepTest as an integration and open it;
- an agent can invoke DeepTest only through approved MCP tools;
- default imports are share-safe/content-minimized;
- DeepTest metering remains content-free;
- no Nessie cloud route receives target URLs, source code, PR diffs, raw reports,
  findings, evidence, or prompts by default.

### buildme.live: Link-Out, Then Project Data Source

Phase 1:

1. Add buildme.live product card in ESC.
2. Link out to the BuildMe product/admin surface.
3. Track account/link health through UOA.

Phase 2 requires BuildMe to publish a project-board contract. Proposed minimum:

```text
GET /api/projects
GET /api/projects/:id/boards
GET /api/boards/:id/columns
GET /api/boards/:id/cards
PATCH /api/cards/:id
POST /api/cards/:id/move
```

Required card shape:

```json
{
  "id": "external-card-id",
  "project_id": "external-project-id",
  "column_id": "external-column-id",
  "title": "Task title",
  "summary": "Short description",
  "detail": "Long description",
  "assignee": { "id": "uoa-sub-or-external", "name": "..." },
  "priority": "low|medium|high|urgent",
  "due_at": "2026-07-08T00:00:00Z",
  "position": 10,
  "updated_at": "2026-07-08T12:00:00Z"
}
```

Nessie board pairing model:

```text
project_external_sources
  id
  organization_id
  nessie_project_id
  product_slug                  # buildme
  external_project_id
  external_board_id
  mode                          # read_only | mirror | bidirectional
  column_mapping_json           # external column id -> Nessie task column id/status
  assignee_mapping_json         # external account id -> Nessie user/agent id
  conflict_policy               # external_wins | nessie_wins | newest_wins | manual
  last_sync_at
```

Phase 2 should start as `read_only`. Bidirectional sync is only safe after column,
assignee, position, and conflict semantics are proven.

Acceptance:

- Nessie can render BuildMe columns natively in a project board;
- users can pair external columns to Nessie columns;
- read-only import never mutates BuildMe;
- bidirectional mode is opt-in and audited.

## Execution Plan

### Phase 0: Documentation And Contracts

- Create this plan in Nessie.
- Create matching product-link/account-linking plan in UOA.
- Create a Deep Water plugin manifest spec and confirm Ledger bearer MCP setup.
- Create a DeepTest plugin manifest spec that preserves local privacy.
- Create a BuildMe project-board API contract document before native board work.

### Phase 1: ESC Shell In Nessie

- Add `Integrations` top-level route and rail item. **Implemented in current
  slice.**
- Add `integrated_products` and `product_account_links` schema. **Implemented
  in current slice.**
- Seed first-party product rows for Deep Water, DeepTest, and buildme.live.
  **Implemented in current slice.**
- Render product cards with launch URLs and account/plugin status. **Implemented
  in current slice.**
- Render metadata-driven integration cards inside chat messages. **Implemented
  in current slice.**
- Add first-party plugin manifests and expose them in the ESC detail page.
  **Implemented in current slice.**
- Seed and link public MCP catalog entries for MCP-backed first-party products.
  **Deep Water and DeepTest implemented; BuildMe intentionally pending.**
- Surface shared MCP installation readiness in ESC. **Implemented for team,
  organization, and system-scoped MCP instances.**
- Add UOA active-workspace consumption. **Implemented in current slice.**
- Add a connected-products entitlement API or projection keyed to UOA
  `active.teamId`. **Projection implemented in current slice; UOA authority
  remains future work. Responses now expose the projection authority explicitly
  and the route has been split into product-status and handoff modules so the
  UOA-backed switch can land without growing `api/src/routes/integrations.ts`
  beyond the file-size guardrail.**
- Add health checks for link-only products and MCP-backed products. **MCP
  installation readiness is surfaced; active product health polling remains
  pending. Month-to-date connector usage/cost is surfaced in ESC.**

### Phase 2: Deep Water Native Plugin

- Add Deep Water MCP catalog entry and install flow. **Catalog entry seeded;
  ESC now deep-links into the MCP install dialog; credential setup, probing, and
  tool approval remain in the MCP store flow.**
- Add a Deep Water ESC launcher backed by the Personal Assistant and approved
  MCP tools. **Implemented for team-enabled products with active shared MCP
  installations.**
- Add credential setup and tool approval flow.
- Add a Deep Water run wrapper in Nessie jobs/runs. **Initial durable launch
  projection is implemented in `product_integration_runs`; PA write-back can
  now update status/cost/source/report fields; autonomous polling/completion
  reconciliation remains pending.**
- Add result import into Knowledge and FileService-backed attachments.
- Add connector usage ledger rows for job cost.
  **Implemented for terminal PA write-back with reported cost; autonomous
  background reconciliation remains pending.**
- Add UI panels for research history, report link, sources, and spend.
  **Recent launch history, report links, Knowledge draft links, source counts,
  and the booked rate-card charge projection are implemented when the PA writes them back;
  source review remains pending.**

### Phase 3: DeepTest Link-Out And MCP

- Add DeepTest link-out product card.
- Add local MCP install instructions and plugin manifest.
- Add DeepTest MCP catalog entry. **Catalog entry seeded; ESC now deep-links
  into the MCP install dialog. Local-runner endpoint setup and approval flow
  still pending.**
- Expose the recommended `deeptest_review` flow as the primary approved tool.
  **Manifest updated from DeepTest's MCP docs; PA handoff is implemented and
  requires active approved MCP installation.**
- Add share-safe report import into Knowledge.
- Keep owner-local/raw report import behind explicit user action and warning.

### Phase 4: BuildMe Native Project Source

- Implement BuildMe API contract in buildme.live.
- Add Nessie external project source pairing.
- Render read-only BuildMe boards in Nessie project board UI.
- Add sync status and conflict diagnostics.
- Later: add audited bidirectional moves/updates.

### Phase 5: UOA Connected Products

- Add UOA connected-products/account-linking screen.
- Add backend endpoints for link status and revocation.
- Add product icons/metadata to UOA app/domain records.
- Have Nessie, Deep Water, DeepTest, and BuildMe consume the same active
  org/team/workspace identity envelope.

## Non-Negotiable Boundaries

- Do not embed Deep Water or DeepTest internals into Nessie. Integrate through
  product APIs, MCP, and plugin manifests.
- Do not bypass Nessie's MCP approval/grant path for agent-callable tools.
- Do not store or log product credentials in prompts, audit metadata, or plugin
  config JSON. Store secret refs only.
- Do not import DeepTest target material into hosted Nessie by default.
- Do not bypass FileService for report PDFs, source bundles, screenshots, or
  other blob artifacts.
- Do not implement bidirectional BuildMe board sync until read-only pairing,
  column mapping, and conflict handling are proven.

## Open Questions

- What does "ESC" stand for in product copy, or should the UI label simply be
  "Integrations"?
- Is the buildme.live project-management code in another folder/repo, or does it
  still need to be built?
- Should hosted Nessie preinstall the Deep Water plugin globally, or should it
  appear as a one-click first-party marketplace item that teams enable?
- Should DeepTest have a hosted deeptest.live workspace, or remain local-first
  with only link-out/account state in hosted Nessie?
- Should UOA's connected-products screen be user-facing only, or also include a
  team/workspace owner view for product entitlement and revocation?

## Definition Of Done For The Whole Goal

- One UOA login can carry a user across Nessie and the sibling products.
- Nessie's left rail exposes Integrations/ESC.
- Each sibling product is visible in ESC with status, launch, setup, and usage.
- Each product has an installable plugin path for open-source Nessie.
- Every agent-callable product action is available through approved MCP/tool
  registry grants.
- Deep Water research can be launched from Nessie, monitored, costed, and saved
  into Nessie Knowledge.
- DeepTest can be launched or called without violating its local/privacy
  contract.
- BuildMe can be linked out, and later its project board can be paired as an
  external Nessie project data source.
