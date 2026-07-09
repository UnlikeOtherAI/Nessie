# DeepSignal Integration — External Agent over MCP

Status: Proposal (2026-07-09). Counterpart doc: `deepsignal.live/docs/plans/nessie-integration.md`
(the DeepSignal-side work). Related: `docs/plans/2026-07-08-esc-integration-unification-plan.md`
(ESC framework this plan builds on).

## Goal

Surface **DeepSignal** (objective-first decision intelligence, hosted at its own URL,
`UnlikeOtherAI/deepsignal.live`) inside Nessie as a **per-user activatable external agent**:

1. **Peer of the Personal Assistant, not a tool inside it.** DeepSignal appears as its own
   DM-style conversation surface, at the same level as the PA.
2. **Nessie's LLM is never in the loop.** When the user talks to DeepSignal, the turn goes
   *directly* to the DeepSignal service over MCP. Nessie proxies, renders, and audits — it does
   not run inference, does not spend Nessie model tokens, and does not re-interpret replies.
3. **Per-user opt-in.** Not everyone needs DeepSignal. Activation is per individual user
   (gated by team enablement, like other ESC products).
4. **DeepSignal is the source of truth.** Conversation history, tool activity, insights, and
   pursuits live in DeepSignal; Nessie loads and displays them — including turns that happened
   on other surfaces (DeepSignal console, mobile).
5. **Shared identity.** Both products are relying parties of the same SSO — the Unlike Other
   Authenticator (UOA, `authentication.unlikeotherai.com`) — so user / team / org identifiers
   are the *same identifiers* on both sides. No partner-style user mapping.

Out of scope: embedding any DeepSignal code in Nessie; DeepWater deep-research integration
(separate ESC track — see §7 for the boundary).

## What The Existing Repos Already Provide

### Nessie

- **ESC / Integrations subsystem** — `IntegratedProduct`, `ProductAccountLink` (per-user link
  state incl. `uoaSub`), `ProductTeamEnablement` (`api/prisma/schema.prisma:721-795`),
  plugin manifests (`api/src/services/integration-plugin-manifests.ts`), routes
  (`api/src/routes/integrations.ts`), admin Integrations page. Deep Water / DeepTest / buildme
  are the precedents; DeepSignal becomes the fourth product row.
- **MCP connector management** (`@nessie/mcp-manage`) — catalog + instances, **user-scope
  installs that are visible only to the installing user** (`worker/src/run/mcp-toolset.ts`,
  `scopeMatchesRun`), dynamic OAuth (RFC 9728/8414 discovery, RFC 7591 DCR, PKCE, per-user
  token placement, auto-refresh), encrypted secret store, SSRF guard, curated library
  (`packages/mcp-manage/src/library.ts` `CURATED_MCP_LIBRARY`) and first-party catalog
  migrations (`api/prisma/migrations/20260708161000_first_party_mcp_catalog_entries/`).
- **PA surface pattern** — per-user private DM channel (`dmKey = pa:${orgId}:${userId}`,
  `systemChannelType = personal_assistant`, single `ChannelMember`), system-managed `Agent`
  row, ordinary `Channel → Thread → Message` storage
  (`api/src/services/personal-assistant.ts`).
- **Rendering & streaming** — `Message.metadata.uiCards` + `MessageUiCards.tsx` for
  card-shaped activity; SSE thread streaming (`GET /api/threads/:threadId/stream`,
  `ThreadStreamEvent`, `realtimeHub`) consumed by `useThreadStream`.

### DeepSignal (today)

- Fastify API (`api/`), agent built on `@deep/agent` with server-side per-principal memory
  (remember.ninja). `POST /v1/chat` returns `{ reply, activities, cards }` — activities are
  typed tool/skill events, cards are generative UI specs.
- UOA relying-party auth (`api/src/auth/uoa.ts`, `routes/sso.ts`): PKCE browser flow,
  `Principal { user, team (tenant), organization, role, memberships }`.
- Insight delivery: signed webhooks (`insight.surfaced`, HMAC), Slack/email channels,
  pull digest (`GET /v1/insight/digest`).
- An MCP server exists but is **stdio-only and runs as a static dev principal**
  (`api/src/mcp.ts`) — unusable by Nessie as-is.
- **No conversation persistence or history read API** — chat is stateless single-turn.

The DeepSignal-side gaps (network MCP transport, UOA-authenticated principals, conversation
persistence + history surface) are specified in the counterpart doc and are prerequisites for
Phases 2+ here.

## Architecture

### 1. Product registration (reuse ESC verbatim)

- New `IntegratedProduct` row `deepsignal` (migration, mirroring the deep-water row) and a
  `NessieIntegrationPlugin` manifest entry in `integration-plugin-manifests.ts`.
- First-party `McpCatalogEntry` for DeepSignal — `protocol: http` (streamable HTTP; SSE
  fallback), `authMethod: oauth2` — back-linked from the product row
  (`integrated_products.mcp_catalog_entry_id`), same migration pattern as
  `20260708161000_first_party_mcp_catalog_entries`. Also appended to `CURATED_MCP_LIBRARY`
  so it is discoverable in the Library tab and installable conversationally via the PA's
  `connector_install`.

### 2. Identity — one SSO, per-user tokens (no partner mapping)

Both products trust UOA, so the user's `sub`, team, and org are identical on both sides.
The connection is authorized per user with standard OAuth against UOA:

- The DeepSignal MCP endpoint publishes **RFC 9728 protected-resource metadata** naming UOA
  as its authorization server; UOA publishes **RFC 8414 AS metadata** (+ RFC 7591 DCR or a
  pre-registered Nessie client).
- With that in place, Nessie's **existing dynamic-OAuth machinery does the rest**: install →
  "Sign in" → UOA consent (one click — the user already has a UOA session) → per-user token
  placement in the encrypted secret store → automatic refresh at probe/dispatch. No new auth
  code paths in Nessie.
- Every MCP request therefore carries a UOA access token **minted for that Nessie user with
  audience DeepSignal**; DeepSignal resolves it to the same `Principal` its own console
  would use. Nessie never impersonates users and holds no shared service credential for chat.
- `ProductAccountLink` (`organizationId, userId, productSlug='deepsignal'`, `uoaSub`,
  `status`) records link state for the Integrations UI, kept in sync by the existing
  `syncUoaProductAccountLinks` flow.

### 3. Per-user activation

Activation = three idempotent steps behind one button (Integrations page) or one PA sentence
(`connector_install`):

1. **Team gate:** `ProductTeamEnablement` for `deepsignal` must be on for the user's team
   (owner/admin controlled — this is how an org limits who *can* activate).
2. **User-scoped `McpServerInstance`** (`scopeType: user`, `scopeId: userId`) created from the
   first-party catalog entry + OAuth sign-in (§2). User-scope semantics already guarantee the
   connector is invisible to every other user and to shared agent runs.
3. **Conversation channel bootstrap** (§4).

Deactivation: uninstall the instance (revokes tokens), mark the `ProductAccountLink`
`revoked`, archive the channel. The catalog entry participates in the existing admin
lock mechanism if an org wants to forbid installs entirely.

### 4. Conversation surface — external-agent DM channel

Mirror the PA channel pattern with a new system channel type:

- `ChannelSystemType` gains `external_agent`; the bootstrap creates a private DM channel
  `dmKey = extagent:deepsignal:${orgId}:${userId}` with exactly one member, labelled
  "DeepSignal".
- A system-managed `Agent` row represents DeepSignal in bindings/UI, with a new
  **`executionMode = external_mcp`** column (default `inference` for all existing agents).
  `agentKind` stays orthogonal (this is not a PA; `connector_*` builtins remain PA-only).
- The channel stores ordinary `Thread`/`Message` rows, so feed rendering, notifications,
  search, and SSE streaming all work unchanged.

### 5. Execution — the external conversation driver (the new piece)

Today every chat path runs `runExecutionAgentLoop → runInferenceGraph`; MCP is only ever a
*toolset inside* that loop. This plan adds a second, much simpler run mode in the worker:

- When a message is posted to a channel whose bound agent has `executionMode = external_mcp`,
  the worker routes to `runExternalConversation` instead of the agent loop.
- The driver resolves the user's **user-scoped DeepSignal MCP instance** (same resolution +
  credential path as `buildMcpToolset`, including auto-refresh and the SSRF guard), and calls
  the DeepSignal MCP tool **`chat`** with `{ conversationId, input }`.
  - `conversationId` is stored on the thread (`Thread.metadata.deepsignal.conversationId`);
    first turn omits it and stores the id DeepSignal returns.
- While the call is in flight the driver emits `stream.start` (and `agent.status`) so the
  existing "thinking" bubble renders; MCP **progress notifications** from DeepSignal (activity
  events: tool started/completed, effect, visibleStatus) are forwarded as incremental card
  updates.
- On completion the driver persists one assistant `Message`:
  - `content` = DeepSignal's `reply` (markdown, rendered verbatim — never re-generated),
  - `metadata.uiCards` = DeepSignal `activities` + `cards` mapped onto
    `IntegrationUiCardSchema` (product `deepsignal`; statuses map 1:1 — planned/queued/
    running/needs_input/complete/failed already align with the card status vocabulary),
  - `metadata.external = { product: 'deepsignal', conversationId, turnId }` for idempotent
    history sync (§6),
  and emits `stream.done`.
- **No inference, no token-ledger model spend.** Each turn writes a `ConnectorUsageEvent`
  (connector type `mcp`, product-tagged) so usage is visible in the ESC usage surface; cost
  accounting for the model spend belongs to DeepSignal's side of the wall.
- Failure modes are surfaced honestly in-channel: token expired → `needs_setup` card with a
  re-auth action; DeepSignal unreachable → `failed` card with retry; never a silent fallback
  to Nessie's own LLM.

### 6. History & proactive signals — DeepSignal is the source of truth

- **History hydration:** on channel open (and on a slow background cadence), the API calls
  DeepSignal's history surface (`conversation_history` MCP tool / `GET /v1/conversations/:id`)
  for the thread's `conversationId` and upserts any turns Nessie hasn't seen —
  `metadata.external.turnId` is the idempotency key. Turns made from the DeepSignal console
  or mobile therefore appear in the Nessie channel. Nessie-originated turns are already
  persisted at send time (§5) and are skipped by the same key.
- **Proactive insights ("the things you don't want to miss"):** Nessie registers one
  DeepSignal **webhook** per linked org (`insight.surfaced`, HMAC-verified) at
  `POST /api/integrations/deepsignal/events`. The receiver resolves the target user by
  `uoaSub`, posts an agent message with an insight `uiCard` (headline, why-it-matters,
  actions: open in DeepSignal / mark done / snooze — the latter proxied back over MCP) into
  that user's DeepSignal channel, and lets normal channel notifications do delivery. This is
  what makes DeepSignal feel autonomous *inside* Nessie.
- Deeper surfaces (pursuit boards, digest page) can later hang off the same MCP tools
  (`pursuit_list`, `insight_digest`) as read-only ESC `ui.pages`; not in the first cut.

### 7. DeepWater boundary (parallel integration — do not overlap)

DeepWater (deep research) is being integrated into Nessie **directly** as its own ESC product
by a separate effort. DeepSignal also *consumes* DeepWater internally, but only ever holds
**report references (ids)** — it never embeds report content. Boundary rules:

- Research initiated **by DeepSignal** (autonomously or in its chat) stays on DeepSignal's
  org key, billing, and audit; Nessie just renders the reference card, deep-linking into the
  DeepWater report (dedupe key = DeepWater report id).
- Research initiated **in Nessie** uses Nessie's own DeepWater integration, untouched by this
  plan. No shared code, no shared credentials, no double-billing.

## Execution Plan

- **Phase 0 — DeepSignal service prerequisites** *(pending; specified in the counterpart
  doc)*: streamable-HTTP MCP endpoint with UOA bearer auth resolving real per-user
  principals; conversation persistence + `chat(conversationId)` / `conversation_history` /
  `conversation_list` tools; RFC 9728 metadata; UOA audience support.
- **Phase 1 — Registration & activation (Nessie)** *(pending)*: `deepsignal` product row +
  manifest + first-party catalog entry + curated library entry; team enablement; per-user
  install → OAuth link → `ProductAccountLink`; Integrations page card with Activate flow.
- **Phase 2 — Conversation surface & driver (Nessie)** *(pending)*: `external_agent` channel
  type + bootstrap; `Agent.executionMode = external_mcp`; worker `runExternalConversation`
  (request/response first — thinking bubble + final message with uiCards); channel labels in
  `ChannelMessageFeed`. Kelpie-verify the channel UI.
- **Phase 3 — History & proactive delivery** *(pending)*: history hydration on channel open;
  webhook receiver → insight cards in-channel; snooze/done actions proxied over MCP.
- **Phase 4 — Streaming & polish** *(pending)*: MCP progress notifications → live activity
  cards / incremental status; usage metering surfaced in ESC usage UI; admin lock/e2e tests;
  update `CLAUDE.md`/`AGENTS.md` (MCP surface + new run mode) and `docs/functionality.md`.

## Non-Negotiable Boundaries

- **Nessie's LLM never processes a DeepSignal conversation.** `external_mcp` runs bypass
  `runInferenceGraph` entirely; there is no fallback path to local inference.
- **Per-user privacy:** the DeepSignal connector is user-scoped; its tools and its channel
  are reachable only by the linked user. No shared/org-scope install of the chat surface.
- **Per-user identity:** every MCP call carries the acting user's own UOA token. No service
  account impersonation, no partner-token user mapping.
- **DeepSignal owns the data.** Nessie mirrors turns for display/notification only, keyed by
  DeepSignal ids; edits/actions flow back over MCP, never applied locally-only.
- All existing MCP guardrails apply unchanged: SSRF guard on the endpoint, stdio banned,
  encrypted secret store, `ConnectorUsageEvent` accounting.

## Open Questions

1. **UOA scope model** — exact OAuth scopes/audience UOA mints for "Nessie acting for user X
   against DeepSignal" (DeepSignal's own docs flag MCP token scopes as an open decision).
   Needs a UOA decision before Phase 0 completes.
2. **Streaming fidelity** — are MCP progress notifications enough for perceived liveness, or
   does DeepSignal need token-level streaming (SSE side-channel) in a later phase? Start
   request/response; measure.
3. **History depth** — hydrate full history or last N turns with paging? Recommend last 50 +
   backfill-on-scroll.
4. **Per-user spend caps** — `Budget` has no user scope; DeepSignal spend is on DeepSignal's
   side anyway, so v1 relies on DeepSignal-side quotas + `ConnectorUsageEvent` visibility.
   Revisit if orgs ask for Nessie-side per-user caps.

## Definition Of Done

- A team-enabled user can activate DeepSignal in one flow (Integrations page or PA chat),
  sign in via UOA once, and get a private "DeepSignal" DM channel.
- Chatting in that channel round-trips through DeepSignal's MCP endpoint under the user's own
  identity, with zero Nessie inference calls (assert in tests), rendering reply + activity
  cards.
- Turns made on the DeepSignal console appear in the Nessie channel after hydration;
  proactive insights arrive in-channel via webhook.
- Other users see nothing: no connector, no tools, no channel.
- Docs updated (`CLAUDE.md`, `AGENTS.md`, `docs/functionality.md`,
  `docs/external-tool-integration.md`) in the same turns as the code.
