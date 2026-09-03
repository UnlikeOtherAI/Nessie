# DeepWater — default OFF, explicit per-agent grant, always via Ledger

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- DeepWater is usable as a tool by any permitted agent, but **default OFF with an
  explicit per-agent grant required** and **always routed through Ledger**:
  enabling DeepWater for a team (owner-only team-enablement toggle) provisions
  a **team-scoped** tool-projecting `McpServerInstance` from the `deep-water`
  catalog entry, resolves Ledger's adapter from `LEDGER_DEEPWATER_MCP_URL`
  (canonical hosted value
  `https://ledger.unlikeotherai.com/v1/mcp/deepwater`; enable fails loudly with
  `LEDGER_DEEPWATER_MCP_URL_UNSET` when unset or
  `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE` when the linked first-party catalog is
  missing), installs a bearer HTTP transport using `LEDGER_PROXY_TOKEN` as
  Nessie's one deployment-wide, product-bound Ledger app API key (never a
  per-user credential), and projects
  `research_start`, `research_status`, `research_report`, `research_list`, and
  `research_cancel` as active `mcp_research_*` tools. Each sibling product must
  use its own app API key; app keys are never reused as webhook signing secrets.
  Transport authentication and caller identity are separate: every call carries
  a short-lived `X-Nessie-Context` RS256 JWT with non-null
  user/org/team/agent/run attribution and, for the linked SSO user, an
  `X-UOA-Delegation` RS256 JWT minted through UOA token exchange. The stable UOA
  subject is required for DeepWater; an optional `active` UOA org/team is
  emitted only when both values exist and never replaces Nessie's local
  tenancy. Every new renewable UOA login requires a nonnegative `tv`
  authentication epoch and binds immutable `{sub, org, team, tv}` proof into
  the signed Nessie access session and its refresh family. Nessie stores UOA's
  opaque refresh token only as AES-256-GCM server-side state coupled to that
  family; the browser receives only Nessie's unrelated rotating cookie. The
  product link proves stable subject/status/credential epoch only; its mutable
  active org/team fields are last-seen metadata, never the proof source.
  Delegation assertions and caches use the immutable session epoch and require
  exact equality with the current link and selected local team. Family/user
  advisory locks serialize rotation, replay, issuance, logout, password change,
  deactivation, and credential erasure across replicas; a replay barrier makes
  reversed predecessor/current HTTP responses converge on one cookie. UOA HTTP
  renewal runs outside database transactions between short locked preflight and
  finalize phases; if an ancestor replay wins mid-flight, finalize adopts the
  accepted UOA successor in place behind the unchanged local cookie. Login
  confirms current direct Nessie access before local mutation, product-link
  epochs never regress, and first-team provisioning is exact-team
  locked. DeepWater's product auth mode remains `uoa_sso` so first login
  creates the account link even though MCP transport auth uses Nessie's app API
  key. Generic Ledger AI calls may omit UOA delegation, but never the five-field
  local attribution; user-triggered system jobs carry their durable origin and
  derive stable named system agent/run UUIDs, failing before provider dispatch
  when origin is missing. Personal DeepWater credential overrides are forbidden
  and removed by migration, so they cannot shadow the product-bound app API key.
  Generic instance test, refresh, healthcheck, and delete operations reject the
  integration-managed instance with `MCP_INSTANCE_MANAGED_BY_INTEGRATION`;
  generic secret writes are also rejected, and PA probe/uninstall tools direct
  callers to the Integrations toggle, which is its sole lifecycle path. Ledger
  owns job isolation, budget enforcement, audit, and raw usage metering for
  both PA and shared-agent calls; UOA alone rates that usage commercially.
  `NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/openai` is the
  deployment-wide inference chokepoint for every run the ORGANIZATION pays for;
  runtime routing rewrites it to Ledger's
  `/v1/:serviceId/*` adapter for the actual OpenAI, Kimi, or custom
  provider, including designer/orchestrator calls; embeddings resolve their own
  `/v1/:serviceId` segment (see "Embeddings" below). The one sanctioned
  exception is a **personal model subscription** (see "Personal model
  subscriptions" below): a run pinned to an agent owner's own linked plan
  bypasses this chokepoint entirely — no Ledger connection, no signed
  attribution, no Ledger metering — because the organization is not paying for
  it and its credentials are the person's, not the deployment's. That lane is
  structural, decided once at run admission, and never a fallback. If the
  deployment-wide URL is absent, signing is decided after the effective
  organization provider-record URL resolves, so a Ledger route an organization
  provider record introduced still receives complete attribution. **Inference
  signing is best-effort by deployment, mandatory once available.** With the
  `UOA_*` signer configured, every Ledger inference call signs and still fails
  closed when the originating user has no linked SSO identity. With no signer
  configured at all — an operator running on a personal Ledger API key — the
  call goes out on `NESSIE_MODEL_API_KEY` alone, because Ledger authenticates
  that bearer and decides per token whether signed provenance is also required;
  Nessie must not refuse on Ledger's behalf and force a UOA OAuth client on a
  deployment whose token does not need one. The condition is read once from
  process env at startup (`loadLedgerIdentitySettings` returning null) and is
  unreachable per request, per organization, or per user, so a signing
  deployment cannot be downgraded. This applies to model/embedding inference and
  its model catalogue only; DeepWater, `web_search`, and billing keep their own
  product-bound credentials and identity requirements unchanged.
  DeepWater `research_start` must reuse the provider's stable `tool_call_id` on
  logical retries. The projected tools and `deep_water_run_update` are flagged
  `requiresExplicitGrant`, so an agent sees them ONLY when its `toolPolicy`
  explicitly allows them (`=== true`) **and** the team-scoped instance reaches
  the run; grants never bypass tenancy, and absent/inherited denies. Owners use
  the targeted `/api/mcp/tools/.../policy-targets/...` mutation (one locked
  policy-key merge, never a full-policy replacement); canonical DeepWater rows
  take the team-transition lock, re-read their projection generation, then take
  the agent lock. Its minimal target list
  includes the Personal Assistant without exposing PA bindings/activity through
  `/api/agents`. The DeepWater launcher and
  `/api/integrations/products/deep-water/agent-access` manage/read the five MCP
  projections plus `deep_water_run_update` as an exact six-entry bundle. Launch
  stays disabled and the API rejects before run creation until the PA has 6/6;
  the updater counts only while its registry row is enabled and active, matching
  worker exposure, so a disabled builtin cannot authorize metered work;
  the final enablement/instance/policy reads and run insert are linearized under
  the team lock then agent-policy lock. Owners can also grant/revoke the bundle
  for shared agents. Generic agent create/PUT cannot write explicit-grant keys
  or DeepWater provenance markers; a locked PUT preserves them from the current
  row; clones and spawned subtask children strip them, PA bootstrap config
  cannot inject them, generic responses redact the server provenance markers,
  and Agent Designer omits their switches. Generic shared-agent create, list,
  parent selection, hierarchy/status/activity/realtime reads, and channel
  binding are exact-organization operations;
  system/global agents remain confined to dedicated bootstraps. Bundle
  provenance keeps the org-wide updater while any team/manual grant needs it;
  its individual OFF switch is disabled until those dependencies are revoked,
  while partial/drifted team projections and a disabled updater remain
  revocable. Registry callability and cleanup identity are separate: a disabled
  updater cannot satisfy readiness, but its protected allow is still removed by
  bundle revocation. Bundle and
  individual lifecycle revocation return 409 during queued/running/needs_setup
  work; there is no force override. Each
  org/team enable or disable is cross-process serialized by a PostgreSQL
  transaction-scoped advisory lock; connector rows and the product toggle
  mutate in the same transaction and roll back together on failure. Disable
  returns `LEDGER_DEEPWATER_ACTIVE_RUNS` while a queued, running, or
  `needs_setup` research run still references the connector; cancel or recover
  the run, or let it reach a terminal state, before retrying disable.
  The worker enables handoff enforcement only from server-authored message
  metadata `integrationLaunch.{productSlug,runId}` for `deep-water`; ordinary
  messages remain unguarded. The durable run lookup requires that exact run id,
  message, organization, team, and thread, and a missing/mismatched row fails
  closed. For that exact Product run, the worker atomically binds the first
  `research_start` provider tool-call id and exact arguments before transport.
  A still-clean Product run moves to `failed` only for a validated Ledger-local
  pre-start rejection (`invalid_request` 400/401, `budget_exceeded` 402, or
  `forbidden` 403), or for Nessie's own budget block while the row remains
  truly queued, uncorrelated, and undispatched. Conflicts, upstream rejections,
  5xx, malformed errors or malformed
  successful tickets, throws, timeouts, uncertain claims, and uncertain ticket
  persistence are fatal ambiguity: the Nessie run stays `running` while the
  queue retries, using the exact persisted id and arguments. A validated
  matching `rs_...` `id`/`job_id` plus exact Ledger status is persisted before
  success is returned; a retry then replays that ticket and status locally
  without another Ledger call. Managed DeepWater owns the canonical five
  `mcp_research_*` names even when private connectors collide or the grant is
  absent, so the server-authored prompt can never dispatch a foreign connector.
  Same-batch status/report/cancel calls are pinned
  to that persisted id; `research_list` and delegation stay blocked for the
  launch turn so result delivery cannot be hidden inside a timed-out sub-agent.
  Run-update/Knowledge calls remain blocked until exact start-result delivery
  and remain blocked for an abandoned timed-out attempt.
  The start result is acknowledged with its invocation-specific delivery token
  only after connector telemetry and tool-end recording settle and its tool
  message is incorporated; timeouts during definitive-failure persistence or
  pending result delivery therefore stay fatal and retry-safe.
  Ordinary setup, inference, and callback failures are promoted to that fatal
  path while the handoff remains unresolved. A budget block may fail only a
  truly uncorrelated queued Product row before terminalizing the Nessie run;
  correlated running work remains recovery-safe, and a terminal claim race
  quarantines a still-clean row. A late definitive rejection may move only the
  exact correlated `needs_setup` row to `failed`.
  Missing or duplicate exact handoff rows fail closed before inference;
  on retry exhaustion every clean exact candidate moves to `needs_setup`, while
  rows carrying external/dispatch/report/Knowledge evidence are preserved. A
  validated ticket that arrives after final-attempt recovery still attaches
  atomically, clears the stale recovery detail, preserves its exact Ledger
  status, and keeps the Product run `running` until mandatory terminal
  reconciliation, so accepted provider work is neither orphaned nor prematurely
  unblocked by the timeout race. Fatal
  tool calls still emit their paired sanitized end event, and every started
  same-batch tool wrapper settles before the queue attempt is released.
  Completion also fails fatally if the model omits the required start. Ordinary
  DeepWater calls are unchanged.
  PA message, run attachment, PA run/task, and direct `run.execute` enqueue
  commit atomically; product handoffs bypass chat engagement decisions while
  ordinary chat keeps its existing orchestration path. Duplicate enqueue
  conflicts roll back the duplicate unit, and realtime publication is
  post-commit/non-fatal.
  Even a
  null external id remains a conservative blocker because Ledger dispatch may
  be in flight; the error links an attached chat where PA can call
  `research_cancel`, while unattached interrupted work requires explicit
  recovery. Disable
  targets only the instance linked from the first-party public product, so
  private same-name catalogs are untouched. `deep_water_run_update` is not
  PA-only and takes tenancy strictly from the run context (same team + thread;
  Knowledge page validated against the org). It never accepts a cost, price,
  charge, tariff, or currency: Ledger's DeepWater REST/MCP status, report, and
  list contracts expose no commercial amount, and UOA is the sole commercial
  authority.
  The external report URL is persisted only from Ledger's authenticated
  `research_start` structured response after its origin and exact job path are
  validated; source count is persisted only from the authenticated
  `research_report` references array. Both carry server-only provenance markers
  before they are exposed, and agent-authored run updates cannot set, replace,
  or mark either value as trusted. Source persistence atomically repairs an
  already-created exact per-run connector usage event, making same-batch
  report/update order irrelevant. That event records operational calls and
  authenticated source units against the launch run's immutable
  `requestedByUserId`; it has no cost fields and is excluded from every local
  cost aggregate. Migration
  `20260720234500_retire_deepwater_local_cost_mirror` erases historical local
  amounts, converts only their existence into a cost-free server-only dispatch
  recovery marker, drops the obsolete Product-run cost columns, and installs a
  database trigger rejecting future DeepWater connector-event cost writes.
  Product run APIs and UI expose no DeepWater cost; customer totals
  come only from UOA's statement.
  The locked write also enforces a terminal start ticket's exact Product status
  mapping (`complete` → `completed`; negative terminal outcomes → `failed`).
  Re-enable preserves richer probed schemas only
  when tool names exactly match the current Ledger contract; legacy
  direct-provider projections are replaced and must be explicitly re-granted.
