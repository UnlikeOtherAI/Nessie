# MCP connector management and external-agent products

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- MCP connector management logic (catalog, instances, probe, projection,
  credentials, secret store, library, discovery, OAuth) lives in
  `@nessie/mcp-manage` and is shared by the API routes and the worker's
  personal-assistant `connector_*` tools — do not fork it into either side.
  Scope rules: owners manage all install scopes, admins the shared scopes,
  members their own user scope; user-scope tools auto-activate and surface only
  in the installing user's PA runs. OAuth is dynamic by default (RFC 9728/8414
  discovery, RFC 7591 client registration, PKCE, pg-backed state, auto-refresh);
  static client configs remain supported. Owners/admins can lock catalog
  entries against member self-service (install-time gate, endpoint-match
  aware). Public connector APIs never accept or return caller-chosen
  `credentialRef` values: plaintext is submitted once to the encrypted store,
  and only server-minted `secret_*` refs are persisted. Exact environment refs
  are reserved for first-party provisioning. Toolset assembly defers MCP schemas behind
  `mcp_find_tools`/`mcp_load_tools`/`mcp_drop_tools` above
  `NESSIE_MCP_INLINE_TOOL_LIMIT` (default 12) to protect agent context.
  External-agent products (e.g. DeepSignal) run as a per-user DM channel with
  `Agent.executionMode = external_mcp` — turns proxy straight to the product's
  MCP endpoint with **no Nessie inference**. Load-bearing invariants: the
  system-managed, user-scoped instance resolves `DEEPSIGNAL_MCP_APP_KEY` only
  from the canonical public catalog linked from the `deepsignal`
  integrated-product row, with signing pinned to `https://api.deepsignal.live`,
  so a same-name catalog or changed origin cannot receive the key; the app key,
  the `ai.invoke` `X-UOA-Delegation`, and the fresh RS256 `X-Nessie-Context`
  are **independent** proofs carried on every call with no per-user OAuth or
  generic credential fallback; that key is distinct from every other
  secret-bearing environment credential and per-org webhook secret, verified at
  API/worker startup; pre-existing identity headers are rejected
  case-insensitively before fresh identity is attached; the signed session
  org/team must exactly match the selected team's UOA mapping (the account link
  proves only subject/status/epoch — its active org/team are non-authoritative
  last-seen metadata), DM keys include the UOA team, and legacy team-less
  channels fail closed; managed instances and their product-linked catalog
  entries reject every generic lifecycle, secret and catalog mutation.
  Generic OAuth remains available for ordinary connectors. Everything else —
  the shared `resolveInstanceMcpTransport`/`callInstanceTool` seam, the per-org
  HMAC webhook and its coalesced, budgeted rolling digest, the Signals page —
  is in [docs/external-tool-integration.md](../external-tool-integration.md)
  §2 + §5 and
  [docs/plans/2026-07-09-deepsignal-integration.md](../plans/2026-07-09-deepsignal-integration.md).

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "MCP Integration".


The live API server (`api/`) exposes a **REST MCP connector-management surface** under `/api/mcp/*`. This is for managing third-party MCP connectors (register, list, approve, activate, delete) — it is not a JSON-RPC tool server.

The management core lives in the shared **`@nessie/mcp-manage`** package (catalog, instances, probe, tool projection, credentials, OAuth, encrypted secret store, SSRF wrapper) so the API routes and the worker's personal-assistant tools share one implementation — the sharing, scope, credential-ref, locking, and context-safe-toolset rules are in `AGENTS.md` (the MCP connector management bullet). On top of it:

- **Library + discovery**: `GET /api/mcp/library` (curated remotes + live registry search, HTTP/SSE only), `POST /api/mcp/discover`, `POST /api/mcp/library/import`; people add a custom app from `/apps`.
- **Personal-assistant connector tools** (PA-only builtins): `connector_list`, `connector_library_search`, `connector_discover`, `connector_install`, `connector_authorize`, `connector_test`, `connector_set_secret`, `connector_uninstall` — full conversational setup from just a service name or URL, with secrets stored encrypted (`POST /api/mcp/instances/:id/secret` is the UI equivalent).
- **Dynamic OAuth** (MCP authorization spec): `{ method: "oauth2" }` with no static client triggers metadata discovery (RFC 9728/8414), Dynamic Client Registration (RFC 7591, one public client per org × issuer in `mcp_oauth_clients`), authorization-code + PKCE S256 + RFC 8707 `resource`, pg-backed one-shot state (`mcp_oauth_states`), per-user token placement, and automatic refresh at probe/dispatch. Notion/Linear/Sentry/Atlassian/Asana are curated OAuth entries — users just sign in. Set `NESSIE_API_PUBLIC_URL` in prod so the worker can mint callback URLs.
- **Scoped sharing**: scope rules per above; shared-scope installs keep the `pending_review` tool gate (user-scope auto-activate). See [docs/external-tool-integration.md](../external-tool-integration.md) §2.
- **Admin locking**: `/lock`, `/unlock` on a catalog entry; 🔒 pill + disabled install in the UI, clear refusal from the PA. Install-time gate only — existing instances keep working.
- **External-agent products** (e.g. DeepSignal): a first-party product surfaced as a per-user DM channel whose bound agent has `executionMode = external_mcp` — turns proxy straight to the product's MCP endpoint with **no Nessie inference**, reply + cards rendered verbatim. The identity/key/tenancy invariants (the `DEEPSIGNAL_MCP_APP_KEY` `dsk_` bearer pinned to the canonical catalog and `https://api.deepsignal.live`, delegation + signed `X-Nessie-Context` on every call, startup key-distinctness checks, team-mapping rechecks, managed-instance protections) are in `AGENTS.md`. Surface facts: the global catalog is integration-owned, absent from the generic library, and immutable through generic catalog controls; the private DM key is `extagent:deepsignal:${orgId}:${userId}:${uoaTeamId}`, so switching teams creates a distinct thread and legacy team-less channels fail closed. History hydration: `POST /api/channels/:id/external-sync` (idempotent on `metadata.external.turnId`). Insight webhook: `POST /api/integrations/deepsignal/events` (per-org HMAC secret via `PUT /api/integrations/products/:slug/webhook-secret`, stored encrypted) — **delivery-shaped, not one-card-per-event**: insights coalesce into a single rolling "You have N new signals" digest message per user, updated in place within `NESSIE_SIGNAL_DIGEST_WINDOW_MS` (default ~1h; per-insight ids retained for idempotency + counts-by-kind), and fresh proactive digests are budgeted per user per rolling window (`NESSIE_SIGNAL_BUDGET_MAX` default 6 / `NESSIE_SIGNAL_BUDGET_WINDOW_MS` default 24h — sane heuristics, not law); over budget an insight is still recorded on the digest but the channel interruption (realtime `message.new`) is suppressed. The **Signals** page (triaged Overview/Inbox): `GET /api/integrations/products/deepsignal/signals?include=active|all` + `POST …/signals/:insightId/act` (done|snooze|mute|reopen) over the user's user-scoped instance via the shared `resolveUserScopedProductTransport`/`callInstanceTool` seam, fail-closed to `{ status: 'needs_setup' }` when not linked. See [docs/plans/2026-07-09-deepsignal-integration.md](../plans/2026-07-09-deepsignal-integration.md), [docs/plans/2026-07-10-deep-integration-surface-registry.md](../plans/2026-07-10-deep-integration-surface-registry.md) + [docs/external-tool-integration.md](../external-tool-integration.md) §2.

- **DeepWater as an agent tool** — an owner-only `team-enablement` toggle
  provisions a **team-scoped, tool-projecting** `McpServerInstance` from the
  `deep-water` catalog entry and projects Ledger's `research_start` /
  `research_status` / `research_report` / `research_list` / `research_cancel`
  as active `mcp_research_*` tools, **always routed through Ledger**:
  `LEDGER_DEEPWATER_MCP_URL` (hosted
  `https://ledger.unlikeotherai.com/v1/mcp/deepwater`) with `LEDGER_PROXY_TOKEN`
  — Nessie's one deployment-wide, product-bound app API key, never a per-user
  credential or webhook secret. Enable fails loudly
  (`LEDGER_DEEPWATER_MCP_URL_UNSET`,
  `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE`) rather than persisting a dead
  toggle. Everything else — default OFF with explicit per-agent
  `requiresExplicitGrant` grants, the exact six-entry launcher bundle and
  `/api/integrations/products/deep-water/agent-access`, the team-lock →
  policy-lock → 6/6-read → run-insert ordering, handoff enforcement via
  server-authored `integrationLaunch` metadata with the
  ambiguity-is-fatal-never-terminal recovery matrix, the
  no-cost/no-currency rule, identity headers, and the managed-instance
  lifecycle (`MCP_INSTANCE_MANAGED_BY_INTEGRATION`,
  `LEDGER_DEEPWATER_ACTIVE_RUNS`) — is stated **in full** in
  [docs/standards/deepwater.md](deepwater.md); read it before
  touching any of this.
  `deep_water_run_update` is **not** PA-only: any granted agent may write back
  the durable run record (same team + thread). Also:
  [docs/external-tool-integration.md](../external-tool-integration.md).

Customer tariffs, statements, credits, top-ups, subscriptions, adjustments,
and Stripe lifecycle stay in UOA; Nessie renders UOA-authored display models
only and stores no commercial state. `/tokens` is the customer Credits &
Billing surface; Nessie's owner-only local token/pricing/estimate/projection/
connector/file/budget telemetry is isolated at `/ops/usage`, and the two never
render together. The full contract — `UOA_BILLING_APP_KEY_NESSIE` + the
45-second actor assertion, the vendored
`@unlikeotherai/billing-statement-protocol` package with its SHA-256 lint
gate, frozen-action relaying, Statement V2, the billing-manager vs member
projections, and the login-time direct-access confirmation — is stated in
full in [docs/standards/customer-billing.md](customer-billing.md);
never restate or fork any of it locally.

Builtin `web_search` is also Ledger-only
(`${LEDGER_PUBLIC_URL}/v1/serper/search` with `LEDGER_PROXY_TOKEN` + signed
identity); direct `google.serper.dev` calls and `SERPER_API_KEY` fallbacks are
forbidden — full rule in `AGENTS.md`.

Outbound egress to any caller-, operator- or model-supplied address goes
through `@nessie/runtime` `safeFetch` (or `pinnedFetch` where the caller
handles redirects itself), never `assertSafeUrl` + plain `fetch` — full rule,
caller list, and the DNS-rebinding rationale in `AGENTS.md` → "Outbound egress
is IP-pinned"; see also
[docs/security-audit-2026-06.md](../security-audit-2026-06.md). User-authored
MCP connectors are HTTP/SSE remote endpoints only (no stdio), and deep.agent
crawl scanning stays behind the MCP connector path — both rules in `AGENTS.md`.

> **Legacy JSON-RPC MCP server removed.** The old `GET /mcp` / `POST /mcp`
> JSON-RPC server lived only in the legacy `src/` tree, which is being
> deleted. There is no JSON-RPC `/mcp` endpoint on the live `api/` server.

See [docs/functionality.md](../functionality.md) for the authoritative API surface description. Section §7 describes the removed legacy MCP server for historical reference.
