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

- **Slice A — Registry foundation** *(done, 2026-07-12)*: additive optional `surfaces`
  discriminated union on `IntegrationPluginManifestSchema`
  (`packages/schemas/src/integrations.ts`); `deepsignal` (chat_assistant + Signals nav_page)
  and `deep-water` (Research documents_section, gated on `connectorActive`) manifests
  populated; `useProductSurfaces` (`admin/src/facades/integrations/useProductSurfaces.ts`) as
  the single read seam (joins products + per-slug manifests via `useQueries`, gates on
  `requires`, groups by type); and the three generic shell render points wired to it:
  - **Chat under PA** — `SidebarDmSection` renders resolved `chat_assistant` surfaces as
    pinned entries right after the PA; `useAdminShell` resolves each to its external-agent
    channel (label match) and de-dupes it out of `sidebarAgentDms`. A linked product whose
    channel isn't bootstrapped yet is simply hidden (activation bootstraps the channel).
  - **Left rail + route** — `SidebarRail` appends active `nav_page` surfaces; `router.tsx`
    routes their paths (e.g. `/signals`) to the generic `ProductPageHost`, which renders a
    concrete page from `product-page-registry` or a gated placeholder. `useAdminShell`
    exposes `isProductPageRoute` so `AdminShellLayout` gives these pages no secondary nav.
  - **Documents** — `KnowledgeProvider` gains `activeProductView`/`selectProductView`;
    `KnowledgeSidebarNav` renders `documents_section` surfaces as pinned entries;
    `KnowledgeWorkspace` branches to the generic `ProductDocumentsView` host
    (`product-documents-registry` + placeholder). `/knowledge-base?view=<view>` deep-links in.

  Integrations page: `ManifestPanel` (inert badges) removed; `ProductSurfacesPanel` renders a
  registry-driven "Where this appears" section — live surfaces as working links for active
  products, "unlocks on activation" hints otherwise. Existing operational panels
  (DeepWaterResearchPanel etc.) are unchanged. Concrete Signals page / Research view are
  slices B/C: register a component in the respective registry — no shell/router change needed.
- **Slice B — DeepSignal surfaces** *(done, 2026-07-12)*: the concrete Signals page + its
  backend, plus confirming the chat-assistant link under the PA. Backend:
  `GET /api/integrations/products/deepsignal/signals` (optional `?include=active|all`) and
  `POST .../signals/:insightId/act` (`{ action: done|snooze|mute|reopen }`) in
  `api/src/routes/integrations/deepsignal-signals.ts`, served by
  `api/src/services/deepsignal-signals.ts`. Both resolve the requesting user's **user-scoped**
  DeepSignal `McpServerInstance` and call the `insight_digest` / `insight_act` MCP tools through
  the shared `resolveUserScopedProductTransport` (`external-agent-instance.ts`) +
  `@nessie/mcp-manage` `callInstanceTool` seam — the same seam history hydration uses, extracted
  here so neither side forks it. Not-linked / auth-needed returns a typed `{ status: 'needs_setup' }`
  (fail-closed, never a 500); tenancy is strictly the authenticated principal. Typed response
  schemas (`DeepSignalSignalRecord`/`…SignalsResponse`/`…SignalActRequest`/`…SignalActResponse`)
  live in `@nessie/schemas`. Frontend: `useDeepSignalSignals()` + `useActOnSignal()`
  (`admin/src/facades/integrations/hooks.ts`), the `SignalsPage`
  (`admin/src/pages/SignalsPage.tsx`) + `SignalCard` row, registered into
  `product-page-registry` at `/signals` (no router/shell change). Loading, empty ("you're all
  caught up"), needs-setup ("Connect DeepSignal", links `/integrations`), and error states are
  all handled. The chat-assistant link is Slice A's generic `SidebarDmSection` path (resolves the
  external-agent channel by label match) and needed no change for DeepSignal.
- **Slice C — DeepWater Research in Documents** *(done, 2026-07-12)*: `DeepWaterResearchView`
  (`admin/src/components/features/knowledge/DeepWaterResearchView.tsx`) registered into
  `product-documents-registry` under the `deep-water-research` view key, so the generic
  `ProductDocumentsView` host renders it when the pinned Documents entry is selected — no
  shell/sidebar/router change. It reuses the presentational `DeepWaterRunHistory` (imported
  directly, single implementation) fed by `useDeepWaterResearchRuns()`, wrapped in a
  `KnowledgePane` titled "Research" with a "New research" deep-link to `/integrations` (where
  the existing `DeepWaterResearchPanel` launch flow lives). Loading, empty ("No researches
  yet"), and not-connected states handled. `/knowledge-base?view=deep-water-research`
  deep-links straight into it via Slice A's `selectProductView`.
- **Slice E — DeepSignal DM as a native thinking assistant** *(done, 2026-07-12)*: reframes the
  external-agent DM as a first-class assistant per the verified Slack agent-design guidance
  (research doc §2 / §8.1), gated strictly to `external_agent` channels so the PA and normal
  channels are untouched. Sourced declaratively from the product manifest so a second external
  agent needs no code change:
  - **Conversation starters** — new optional `conversationStarters?: string[]` (2–4) on
    `IntegrationPluginManifestSchema` (now in `packages/schemas/src/integration-plugin.ts`,
    split out of `integrations.ts` along the manifest/surfaces seam to stay under the 500-line
    cap). The DeepSignal manifest carries three starters. `useExternalAgentIdentity(channel)`
    (`admin/src/facades/integrations/hooks.ts`) resolves the product (by channel-label match) +
    its manifest; `ExternalAgentIntro.tsx` renders the empty-channel state (identity + clickable
    starter chips that send on click) via a new optional `emptyState` prop on
    `ChannelMessageFeed`.
  - **Function-first identity** — new optional `description?` on `ChatAssistantSurfaceSchema`
    (+ existing `iconGlyph`). The DeepSignal chat-assistant surface declares the non-human glyph
    `◎` and "Surfaces the signals and decisions you shouldn't miss". `ChannelHeader` renders the
    product glyph + name + one-line description for external-agent channels.
  - **Status-on-send** — the existing pending "thinking" bubble already fires for dedicated-agent
    conversations; wording refined to plain-language "<Name> is thinking…".
  - **Activity timeline** — external-agent assistant turns render their narrated activities as a
    **collapsed-by-default, expandable** plan/timeline (`AgentActivityTimeline.tsx`) instead of
    flat cards. A tiny additive `role?: 'activity' | 'result'` on `IntegrationUiCardSchema`
    (set by `packages/mcp-manage/src/external-chat.ts`: activities→`activity`, cards→`result`)
    lets `MessageUiCards` split activities into the timeline while result cards stay flat. No
    backend contract change beyond that one optional field.
- **Slice D — Verify & ship** *(pending)*: build/Playwright the new surfaces, docs, merge to main.

## Open Questions

1. Signals page depth — full digest with inline act, or read-only list first? Starting with
   list + done/snooze.
2. Whether `nav_page` products should also get a product-native secondary sidebar
   (`AdminShellLayout` `secNavElement` seam) — deferred; Signals is a single page for now.
