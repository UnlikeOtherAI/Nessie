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

Current UOA/auth finding:

- UOA already owns Slack-style workspace/team identity. Its `Team` is the
  workspace, `Organisation` is the higher grouping, and `/auth/select-team`
  carries the chosen workspace into access/refresh tokens.
- Nessie's current UOA integration only reads `email`/display claims and does
  not request UOA `org_features`, workspace selection, or consume the
  `active { orgId, teamId }` claim yet.
- Therefore, do not add Nessie team creation or team-product write APIs until
  Nessie consumes UOA active workspace context. First-registration create/join
  is an SSO/Auth-window concern in UOA, not a Nessie-owned onboarding fork.

### 3. Interface Surface Contract

Nessie should display product work in three UI surfaces, all declared by product
or plugin metadata rather than hard-coded product internals:

- **custom pages** for durable product workflows and history, such as Deep Water
  research runs, DeepTest local runner state, or BuildMe board pairing;
- **chat cards** for transient agent/user work inside conversations, such as
  research progress, security review summaries, cost, sources, and safe report
  links;
- **custom controls** for launch/configuration state, such as Deep Water depth
  and budget, DeepTest review profile and local-runner target, or BuildMe column
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
- team/workspace enablement is deliberately not implemented in this slice
  because UOA already owns workspace identity and Nessie does not yet consume
  UOA `active.teamId`.

Manifest skeleton:

```json
{
  "apiVersion": "integrations.nessie.io/v1",
  "kind": "NessieIntegrationPlugin",
  "manifestRef": "first-party/deep-water",
  "productSlug": "deep-water",
  "install": [{ "mode": "remote_mcp_oauth", "availability": "both" }],
  "mcp": {
    "catalogTemplate": {
      "name": "deep-water",
      "protocol": "http",
      "authMethod": "oauth2",
      "transport": { "transport": "http", "urlEnv": "DEEP_WATER_MCP_URL" }
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

- month-to-date calls/spend for that product;
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
   - cancel research;
   - get sources;
   - get usage.
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
- Create a Deep Water plugin manifest spec and confirm OAuth/MCP setup.
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
- Add UOA active-workspace consumption, then add a connected-products
  entitlement API or projection keyed to UOA `active.teamId`.
- Add health checks for link-only products and MCP-backed products.

### Phase 2: Deep Water Native Plugin

- Add Deep Water MCP catalog entry and install flow.
- Add credential setup and tool approval flow.
- Add a Deep Water run wrapper in Nessie jobs/runs.
- Add result import into Knowledge and FileService-backed attachments.
- Add connector usage ledger rows for job cost.
- Add UI panels for research history, report link, sources, and spend.

### Phase 3: DeepTest Link-Out And MCP

- Add DeepTest link-out product card.
- Add local MCP install instructions and plugin manifest.
- Expose the recommended `deeptest_review` flow as the primary approved tool.
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
