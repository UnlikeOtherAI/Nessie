# Deep Integration — Product Surface Registry

Status: Proposal (2026-07-10). Builds on `docs/plans/2026-07-08-esc-integration-unification-plan.md`
and `docs/plans/2026-07-09-deepsignal-integration.md`.

## Problem

Activating an integrated product today changes almost nothing in the app: every
product's UI is crammed onto the single Integrations page (`IntegrationsPage.tsx`),
dispatched by a hard-coded `slug ===` ladder, and the manifest's `ui.pages/cards/controls`
render only as inert badges in `ManifestPanel`. That is a settings screen, not an
integration. Turning a product on in admin should make **product-native surfaces appear
woven into the real interface** — nav, chat sidebar, Documents — and turn off should remove
them.

## Goal

A **manifest-driven surface registry**: an integrated product declares the surfaces it
contributes; when it is active for the user/team the app renders them in their natural
homes; the Integrations page becomes the switch that lights them up, not the container.

Concretely for the two first consumers:
- **DeepSignal** → a "DeepSignal" assistant link in the chat sidebar directly under the
  Personal Assistant (opens its external-agent channel), plus a **Signals** page showing the
  digest of things you shouldn't miss.
- **DeepWater** → a **Research** section inside Documents listing all your researches
  (reusing the parallel team's existing services + `DeepWaterRunHistory`, not forking).

Reusable because ≥3 products (DeepSignal, DeepWater, buildme) need it — not premature.

## Architecture

### 1. Manifest declares surfaces (additive schema)

Extend `IntegrationPluginManifestSchema` (`packages/schemas/src/integrations.ts`) with an
**optional** `surfaces?: ProductSurface[]` field (additive — existing manifests/consumers
unaffected). `ProductSurface` is a discriminated union on `type`:

- `{ type: 'chat_assistant', channelKind: 'external_agent', label, iconGlyph?, requires }`
  — a pinned assistant link under the PA that opens the product's system channel.
- `{ type: 'nav_page', id, label, route, iconGlyph?, requires }` — a top-level left-rail
  section + page.
- `{ type: 'documents_section', id, label, view, iconGlyph?, requires }` — a pinned entry
  in the Documents (Knowledge) sidebar selecting a product view.

`requires` gates visibility: `{ linked?: boolean, teamEnabled?: boolean, capability?: string,
connectorActive?: boolean }` — evaluated against the `GET /api/integrations/products` record
(`accountLink.status === 'linked'`, `teamEnablement.enabled`, `capabilities`,
`mcpInstallation.lifecycleState === 'active'`).

Populate `surfaces` on the `deepsignal` (chat_assistant + Signals nav_page) and `deep-water`
(Research documents_section) manifests in `integration-plugin-manifests.ts`.

### 2. Frontend registry (single read seam)

A `useProductSurfaces()` hook (`admin/src/facades/integrations/`) joins `useIntegratedProducts()`
(active state) with each product's manifest `surfaces`, filters by `requires`, and returns the
resolved, active surfaces grouped by `type`. Every shell render point reads this one hook —
no per-product code in the shell.

### 3. Shell render points (generic, built once)

- **Chat under PA:** `SidebarDmSection.tsx` renders `chat_assistant` surfaces immediately
  after `PersonalAssistantSidebarEntry`, resolving each product's channel via
  `isExternalAgentChannel` + slug, navigating with `navigateToChannel`.
- **Left rail + routes:** the rail (`nav-items.tsx` / `SidebarRail`) appends `nav_page`
  surfaces; `router.tsx` gains a generic product-page outlet that renders the registered
  page component for the active `nav_page` route.
- **Documents:** `KnowledgeSidebarNav.tsx` renders `documents_section` surfaces as pinned
  entries; `KnowledgeWorkspace.tsx` branches to the product view when selected.

### 4. Product views (the actual pages)

- **DeepSignal Signals page** — new page rendering the insight digest. Data via a new
  `GET /api/integrations/products/deepsignal/signals` route that calls the DeepSignal
  `insight_digest` MCP tool through the user's user-scoped instance (reusing the
  `callInstanceTool` seam from `@nessie/mcp-manage`), returning items rendered as cards with
  done/snooze actions (proxied to `insight_act`). Fail-closed/needs-setup when not linked.
- **DeepWater Research view** — reuse `DeepWaterRunHistory.tsx` verbatim, fed by
  `useDeepWaterResearchRuns()`; a list→report/knowledge/chat deep-link view inside Documents.

### 5. Integrations page becomes the switch

Replace the inert `ManifestPanel` badge list + the `slug ===` ladder with a registry-driven
"Where this appears" section: for an active product, list its live surfaces as **links** into
the app (Open DeepSignal chat, Open Signals, Open Research); for an inactive one, show them as
what activating will unlock. Per-product operational panels stay, dispatched via the registry
rather than a hard-coded ladder.

## Non-Negotiable Boundaries

- Schema change is **additive/optional**; the parallel DeepWater/ESC team's manifests and
  consumers keep working untouched.
- DeepWater work **reuses** `listDeepWaterResearchRuns` + `DeepWaterRunHistory` — no fork, no
  new DeepWater service.
- Surfaces are **gated**: nothing appears for a product a user hasn't activated / a team hasn't
  enabled. Removal on deactivate is automatic (registry is derived from live state).
- No new identity/tenancy paths; the Signals route runs as the user's own principal over their
  user-scoped MCP instance.

## Execution Plan

- **Slice A — Registry foundation** *(pending)*: schema `surfaces`, both manifests populated,
  `useProductSurfaces`, and the three generic shell render points (chat-under-PA, rail+route,
  Documents sidebar) wired to read the registry. Integrations page switched to registry-driven
  "where this appears".
- **Slice B — DeepSignal surfaces** *(pending, after A)*: Signals page + backend signals
  route (insight_digest/insight_act over the user's MCP instance) + the chat-assistant link
  live under the PA.
- **Slice C — DeepWater Research in Documents** *(pending, after A)*: Research documents view
  reusing the run-history component + service.
- **Slice D — Verify & ship** *(pending)*: build/kelpie the new surfaces, docs, merge to main.

## Open Questions

1. Signals page depth — full digest with inline act, or read-only list first? Starting with
   list + done/snooze.
2. Whether `nav_page` products should also get a product-native secondary sidebar
   (`AdminShellLayout` `secNavElement` seam) — deferred; Signals is a single page for now.
