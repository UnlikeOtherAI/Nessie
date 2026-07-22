# DeepSignal Integration — External Agent over MCP

Status: Nessie boundary implemented (2026-07-19); matching DeepSignal verifier
must be deployed from the counterpart plan.
Counterpart doc: `deepsignal.live/docs/plans/nessie-integration.md`
(the DeepSignal-side work). Related:
`docs/plans/2026-07-08-esc-integration-unification-plan.md` (ESC framework this
plan builds on).

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
  token placement, auto-refresh), encrypted secret store, SSRF guard, generic curated library
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
  fallback), `authMethod: bearer` — back-linked from the product row
  (`integrated_products.mcp_catalog_entry_id`), same migration pattern as
  `20260708161000_first_party_mcp_catalog_entries`. Also appended to `CURATED_MCP_LIBRARY`
  for discovery. Its instance cannot be installed or mutated through generic
  connector controls; activation owns its lifecycle.

### 2. Identity — application key plus delegated SSO actor

Both products trust UOA, so the user's `sub`, team, and org are identical on
both sides.

- DeepSignal issues Nessie one product-bound `dsk_` key. API and worker load it
  only from `DEEPSIGNAL_MCP_APP_KEY`; the user-scoped instance stores that env
  reference, never plaintext. Hosted/self-hosted processes fail startup when
  the key is absent/malformed, reused by any configured environment/stored
  webhook credential, or UOA signing/exchange config is incomplete. The
  instance must resolve through the canonical product-linked public catalog,
  and the key is signed/dispatched only to `https://api.deepsignal.live`.
- Each outbound MCP call retains
  `Authorization: Bearer <DEEPSIGNAL_MCP_APP_KEY>` and adds
  `X-UOA-Delegation`: exact `product=nessie`, `scope=ai.invoke`, resource
  `https://api.deepsignal.live`, stable subject, and required active UOA
  organization/team.
- The same call adds a fresh RS256 `X-Nessie-Context` with issuer/source
  `api.nessie.works`, DeepSignal audience, and non-null user/org/team/agent/run,
  request, and stable tool-call provenance. Context and delegation never
  overwrite `Authorization`; stale identity headers are rejected regardless of
  casing before fresh headers are attached.
- DeepSignal accepts no user OAuth/access token or personal credential as the
  app-to-app proof. Generic connectors continue to use Nessie's ordinary
  dynamic OAuth implementation.
- `ProductAccountLink` (`organizationId, userId, productSlug='deepsignal'`,
  `uoaSub`, credential epoch, `status`) records stable delegated-account
  liveness for the Integrations UI, kept in sync by
  `syncUoaProductAccountLinks`. Its active org/team columns are last-seen
  metadata only; one user's simultaneous team sessions must not overwrite one
  another's authority.
- The signed session's active org/team must exactly match the selected internal
  team's `externalOrgId`/`externalWorkspaceId`. Enablement derives its external
  tuple from that Team row, and both are revalidated on every call before
  exchange/dispatch; a team switch cannot reuse a channel or conversation from
  the previous workspace.
- DeepSignal's inbound-webhook HMAC secret remains per-org and separate from
  every outbound application key. Nessie rejects an attempted equal secret.

### 3. Per-user activation

Activation = three idempotent steps behind the Integrations-page button:

1. **Team gate:** `ProductTeamEnablement` for `deepsignal` must be on for the user's team
   (owner/admin controlled — this is how an org limits who *can* activate).
2. **System-managed user-scoped `McpServerInstance`** (`scopeType: user`,
   `scopeId: userId`) created from the first-party bearer catalog entry, pinned
   to `DEEPSIGNAL_MCP_APP_KEY`, after confirming the linked UOA subject and
   active workspace (§2). User-scope semantics keep it private; managed-product
   gates block generic OAuth, lifecycle, probe, and secret paths.
3. **Conversation channel bootstrap** (§4), keyed by active UOA team so each
   workspace owns a distinct thread/conversation.

Deactivation removes the managed instance, marks the `ProductAccountLink`
`revoked`, and archives the channel. Reactivation revalidates SSO state and
recreates/normalizes the single instance.

### 4. Conversation surface — external-agent DM channel

Mirror the PA channel pattern with a new system channel type:

- `ChannelSystemType` gains `external_agent`; the bootstrap creates a private DM channel
  `dmKey = extagent:deepsignal:${orgId}:${userId}:${uoaTeamId}` with exactly one member, labelled
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
  credential path as `buildMcpToolset`, with the SSRF guard), verifies the exact
  managed credential ref and active bearer contract, attaches UOA + signed
  provenance without replacing the dsk bearer, and calls the DeepSignal MCP
  tool **`chat`** with `{ conversationId, input }`.
  - `conversationId` is stored on the thread (`Thread.metadata.deepsignal.conversationId`);
    first turn omits it and stores the id DeepSignal returns. First-turn dispatch is
    serialized per thread by an in-process lock (`external-conversation-store.ts`
    `withThreadLock`) so two turns racing before the first `conversationId` write cannot each
    mint a separate DeepSignal conversation and clobber `thread.metadata`; the second turn
    observes the stored id and reuses it. In-process only (private-DM concurrency is rare and
    single-worker in practice).
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
  (connector type `mcp`, product-tagged) for owner-only operational telemetry at
  `/ops/usage`; the public integration response and ESC product page expose no
  local usage summary. Customer credits and cost accounting for model spend
  belong to UOA and DeepSignal's side of the wall.
- Failure modes are surfaced honestly in-channel: missing/wrong managed
  instance → `needs_setup`; rejected app key → failed administrator-repair card;
  DeepSignal unreachable → `failed` card with retry. There is never a user-login,
  generic credential, or Nessie-LLM fallback.

### 6. History & proactive signals — DeepSignal is the source of truth

- **History hydration:** on channel open (and on a slow background cadence), the API calls
  DeepSignal's history surface (`conversation_history` MCP tool / `GET /v1/conversations/:id`)
  for the thread's `conversationId` and upserts any turns Nessie hasn't seen —
  `metadata.external.turnId` is the idempotency key. Turns made from the DeepSignal console
  or mobile therefore appear in the Nessie channel. Nessie-originated turns are already
  persisted at send time (§5) and are skipped by the same key.
- **Pinned cross-seam id contract (both roles).** DeepSignal persists each exchange as **two**
  turns — a `user`-role turn and a `colleague` (assistant)-role turn — and `conversation_history`
  returns both as discrete entries, each with a stable `id` and `role`. Dedupe on re-hydration
  is keyed on `Message.metadata.external.turnId`, so **every** mirrored message of **both** roles
  must carry the DeepSignal turn id it corresponds to. Two invariants make this hold:
  - **Assistant dedupe requires** the `chat` result's `turnId` to equal the colleague turn's
    `id` in `conversation_history`. The worker driver tags the assistant reply message with
    `metadata.external.turnId = <colleague turnId>` at send time (§5).
  - **User dedupe requires** the `chat` result's `userTurnId` to equal the user turn's `id` in
    `conversation_history`. The inbound user message is persisted by the normal send path with
    no `external` key, so the driver additionally tags it with
    `metadata.external = { product, conversationId, turnId: <userTurnId> }` (merging, preserving
    `metadata.mentions`). `userTurnId` is optional on the `chat` result: an older DeepSignal that
    omits it leaves the user message untagged — the only cost is a one-time re-import of that
    user turn on the next channel reopen, never a wrong id.
  Both ids live in the **same DeepSignal turn-id space**, so a live-tagged message and its
  `conversation_history` entry match exactly. The hydration dedupe set is built from **all**
  thread messages carrying `metadata.external.<product>` (both roles), and each hydrated turn is
  inserted tagged with its history `id`, so console-originated turns dedupe on reopen too.
- **Proactive insights ("the things you don't want to miss"):** Nessie registers one
  DeepSignal **webhook** per linked org (`insight.surfaced`, HMAC-verified) at
  `POST /api/integrations/deepsignal/events`. The signed payload's external
  `teamId` must map to the exact enabled Nessie team and its UOA
  organization/workspace binding. The receiver selects only active linked
  members whose UOA link remains on that same team (and narrows by `uoaSub`
  when a future payload supplies recipient subjects), coalesces the insight
  into each recipient's rolling digest, and lets the budgeted channel
  notification path do delivery. Unknown, disabled, or mismatched teams are a
  no-delivery result. Done/snooze/mute/reopen actions flow back through signed
  `insight_act` calls. This is what makes DeepSignal feel autonomous *inside*
  Nessie without one interruption per event.
- Deeper surfaces (for example pursuit boards) can hang off the same signed MCP
  boundary. The digest/Signals Overview and Inbox are already implemented.

### 7. DeepWater boundary (parallel integration — do not overlap)

DeepWater (deep research) is integrated into Nessie as its own ESC product, but every Nessie
research call goes through **Ledger's DeepWater MCP adapter** for token-owned isolation,
budget enforcement, audit, and raw usage metering. UOA alone rates the usage
and supplies customer statements. DeepSignal also
*consumes* DeepWater internally, but
only ever holds **report references (ids)** — it never embeds report content. Boundary rules:

- Research initiated **by DeepSignal** (autonomously or in its chat) stays on DeepSignal's
  org key, billing, and audit; Nessie just renders the reference card, deep-linking into the
  DeepWater report (dedupe key = DeepWater report id).
- Research initiated **in Nessie** uses Nessie's dedicated, product-bound
  Ledger app API key through the team-scoped connector plus a signed UOA
  delegation and Nessie org/team/user/agent/run context. Ledger binds ownership
  and raw usage to the verified delegated subject rather than the transport key.
  There is no double-billing.

## Execution Plan

- **Phase 0 — DeepSignal service prerequisites** *(counterpart deployment)*:
  streamable-HTTP MCP endpoint that verifies the Nessie-only dsk bearer, exact
  UOA delegation, and signed Nessie provenance; conversation persistence +
  `chat(conversationId)` / `conversation_history` / `conversation_list` tools.
- **Phase 1 — Registration & activation (Nessie)** *(backend + admin UI implemented)*:
  `deepsignal` product row + manifest + first-party catalog entry — all shipped
  (`20260709121000_deepsignal_product` migration and
  `integration-plugin-manifests.ts`). DeepSignal is intentionally absent from
  `CURATED_MCP_LIBRARY`: its managed app credential and catalog lifecycle are
  available only through Integrations. Per-user activation backend
  shipped: `POST /api/integrations/products/deepsignal/activate` and
  `.../deactivate` (`external-agent-activation.ts`) — team-gate check → linked
  UOA subject/active workspace check → managed user-scoped bearer instance
  pinned to `DEEPSIGNAL_MCP_APP_KEY` → channel bootstrap, returning
  `{ channelId, instanceId }`. The Integrations card uses the existing SSO
  identity and never opens a secondary OAuth tab.
- **Phase 2 — Conversation surface & driver (Nessie)** *(driver + channel UI
  implemented)*: `external_agent` `ChannelSystemType` value and the
  `Agent.executionMode = external_mcp` enum + column landed additively
  (`20260709120000_agent_execution_mode_external_agent`), plus the idempotent per-user DM
  bootstrap service `external-agent.ts` (system-managed `Agent` + private DM channel keyed
  `extagent:deepsignal:${orgId}:${userId}:${uoaTeamId}` + default thread + binding). The worker
  `runExternalConversation` driver is now shipped (`worker/src/run/external-conversation.ts`
  + `external-conversation-cards.ts`): `run-job` branches on
  `agent.executionMode === 'external_mcp'` **before** any inference setup and hands the turn
  to the driver, which resolves the user-scoped MCP instance (product slug parsed from the
  channel `dmKey`), calls the `chat` tool via the shared MCP plumbing
  (`worker/src/run/mcp-instance-call.ts`, reused by the toolset), emits `stream.start` /
  `stream.done`, records a `ConnectorUsageEvent`, and persists one assistant `Message` with
  `metadata.uiCards` (activities + cards mapped onto `IntegrationUiCardSchema`) and
  `metadata.external = { product, conversationId, turnId }`. The conversation id round-trips
  through `Thread.metadata.<slug>.conversationId` (new additive `threads.metadata` JSONB
  column, `20260709122000_thread_metadata`). Missing/unauthorized connector → `needs_setup`
  card + clean completion; invalid app credential → admin-repair failure;
  transport error → `failed` card + failed run. **No inference is ever invoked** (asserted in
  `worker/src/run/external-conversation.test.ts` via a model client that throws on access).
  The channel UI is shipped too: `ChannelMessageFeed`/`ChannelMessageRow` render an
  `external_agent` channel as a first-class agent conversation (author label + "thinking"
  pending wording derived from the channel's own name, mirroring the Personal Assistant
  special-casing so a second external agent needs no code change), and the sidebar DM list
  (`useAdminShell.ts` `sidebarAgentDms`) surfaces the channel by its label since the
  system-managed `Agent` row is excluded from the general agent list. Playwright visual
  verification is still owed once a dev stack is available (not possible in the remote
  implementation environment).
- **Phase 3 — History & proactive delivery** *(backend + admin hook implemented)*:
  - **Shared MCP single-call seam** — the "connect to one instance + call one
    tool" plumbing (`buildAuthorizedTransport`, `resolveInstanceMcpTransport`) plus
    a new `callInstanceTool` now live in `@nessie/mcp-manage`
    (`mcp-instance-call.ts`), alongside `probeConnection`, reusing the probe's
    transport/credential/auth-apply internals. The chat-result → UI-card mapping
    moved there too (`external-chat.ts`). The worker imports both from the package;
    the API hydration path reuses the identical implementation.
  - **History hydration** — `POST /api/channels/:channelId/external-sync`
    (`external-agent-sync.ts`): member-gated, `external_agent`-only. Resolves the
    product slug from the channel `dmKey`, the user's user-scoped instance, and the
    thread's `metadata.<slug>.conversationId`; when the thread has no conversation
    yet it calls `conversation_list` and adopts the user's most recent conversation
    (so console/mobile chats surface even before the Nessie channel is opened),
    storing it on the thread. Then calls `conversation_history` (limit 50) and
    upserts unseen turns as Messages — idempotent on `metadata.external.turnId`,
    colleague turns rendered verbatim + activity/card `uiCards`, user turns authored
    by the channel owner, ordered by DeepSignal `createdAt`. Returns
    `{ imported, total }`. The admin fires it on channel open
    (`useSyncExternalAgentChannel` + a `ChannelsPage` effect keyed on the opened
    external-agent channel), invalidating the thread's message list only when new
    turns land.
  - **Insight webhook receiver** — `POST /api/integrations/deepsignal/events`
    (`routes/external-agent.ts` + `deepsignal-webhook.ts`): unauthenticated,
    HMAC-SHA256 over the raw body verified with a timing-safe compare against the
    per-org signing secret (`X-DeepSignal-Signature`, `sha256=` prefix accepted).
    The org is resolved by whichever stored secret reproduces the signature, so one
    receiver URL serves every org without leaking targeting. Per-org secrets are set
    by an org **admin/owner** via
    `PUT /api/integrations/products/:productSlug/webhook-secret` and stored encrypted
    (AES-256-GCM) in the new `product_webhook_secrets` table
    (`20260709123000_product_webhook_secret`). On `insight.surfaced` the receiver
    first resolves the payload `teamId` through an enabled
    `ProductTeamEnablement`, requiring its external org/team to match the
    linked Nessie `Team`. It then selects active exact-team members with a
    stable linked UOA account (narrowed by payload subjects when present), and
    delivers only where that team-specific channel already exists. Mutable
    last-seen account-link workspace metadata is not routing authority. It
    coalesces insights into one rolling digest message per recipient. Insight
    ids remain the unbounded idempotency keys; new digest
    notifications are budgeted per user/window, while over-budget events still
    update the durable digest.
  - **Manual registration step:** DeepSignal returns the webhook signing secret
    exactly once when the webhook is registered on its side. A Nessie org admin
    pastes that secret via the webhook-secret endpoint (Integrations UI equivalent
    is future work) before insights can be verified/delivered.
  - **Signals surface** — the Overview/Inbox reads `insight_digest`; its
    snooze/done/mute/reopen actions proxy through `insight_act`. Both use the
    same exact app-key/delegation/provenance call seam and reject stale generic
    credentials.
- **Phase 4 — Streaming & polish** *(pending)*: MCP progress notifications → live activity
  cards / incremental status; preserve owner-only operational telemetry at
  `/ops/usage` and UOA-only customer credits at `/tokens`; admin lock/e2e tests;
  update `CLAUDE.md`/`AGENTS.md` (MCP surface + new run mode) and `docs/functionality.md`.

## Non-Negotiable Boundaries

- **Nessie's LLM never processes a DeepSignal conversation.** `external_mcp` runs bypass
  `runInferenceGraph` entirely; there is no fallback path to local inference.
- **Per-user privacy:** the DeepSignal connector is user-scoped; its tools and its channel
  are reachable only by the linked user. No shared/org-scope install of the chat surface.
- **Independent app and user identity:** every MCP call carries the Nessie-only
  DeepSignal app key, exact UOA delegation for the linked subject/active
  workspace, and signed Nessie provenance. No service-account impersonation,
  partner-token mapping, user OAuth bearer, or credential substitution.
- **Workspace isolation:** team enablement, local-to-UOA workspace mapping, and
  the workspace-qualified channel key are checked before every outbound call.
  Legacy team-less channels fail closed.
- **DeepSignal owns the data.** Nessie mirrors turns for display/notification only, keyed by
  DeepSignal ids; edits/actions flow back over MCP, never applied locally-only.
- Shared MCP guardrails still apply: SSRF guard, stdio ban, and
  `ConnectorUsageEvent` accounting. Generic encrypted-secret/OAuth flows remain
  for ordinary connectors but are blocked for this managed instance.

## Open Questions

1. **Streaming fidelity** — are MCP progress notifications enough for perceived liveness, or
   does DeepSignal need token-level streaming (SSE side-channel) in a later phase? Start
   request/response; measure.
2. **History depth** — hydrate full history or last N turns with paging? Recommend last 50 +
   backfill-on-scroll.
3. **Per-user spend caps** — `Budget` has no user scope; DeepSignal spend is on DeepSignal's
   side anyway, so v1 relies on DeepSignal-side quotas + `ConnectorUsageEvent` visibility.
   Revisit if orgs ask for Nessie-side per-user caps.

## Definition Of Done

- A team-enabled user can activate DeepSignal in one Integrations-page flow,
  reuse their linked UOA identity, and get a private "DeepSignal" DM channel.
- Initial and follow-up chat round-trip through DeepSignal under the dedicated
  dsk app key + delegated user/workspace + signed provenance, with zero Nessie
  inference calls, rendering reply + activity cards.
- Turns made on the DeepSignal console appear in the Nessie channel after hydration;
  proactive insights arrive in-channel via webhook.
- Other users see nothing: no connector, no tools, no channel.
- Docs updated (`CLAUDE.md`, `AGENTS.md`, `docs/functionality.md`,
  `docs/external-tool-integration.md`) in the same turns as the code.
