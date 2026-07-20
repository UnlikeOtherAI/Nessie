# Nessie Agent Standards

## Workflow

- Worktrees are mandatory. The main project checkout always stays on `main`; never edit it directly. Every task — and every parallel agent/CLI — works in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never reset, clean, or discard another worktree's or agent's work. When any task is done, merge the completed task branch into `main` in the same turn after review, linting, and tests pass; do not leave completed work parked in a worktree unless the user explicitly says not to or verification is blocked. After merge, remove the worktree and delete the merged branch.
- Commit and push after every turn. No exceptions. If there is nothing to commit, skip.
- Local dev runs with hot reload via `pnpm dev` (root) — API (5454, nodemon) + admin (5455, Vite HMR) in parallel. (Moved from 5554/5555 to dodge an Android emulator squatting on those ports; production internal port stays 5554.) Admin and API source edits reload automatically; **do not hand-build the admin to see changes.** The repo sits on a macOS data-volume path where fsevents is dead, so watchers must poll: Vite `server.watch.usePolling` and `nodemon --legacy-watch`. Don't remove these.
- Desktop installable builds that embed local admin changes must build admin with `VITE_API_BASE_URL=https://api.nessie.works` and Tauri with `--config '{"build":{"frontendDist":"../../admin/dist"}}'`. `https://app.nessie.works` is the admin web origin, not the API origin; using it as `VITE_API_BASE_URL` leaves login stuck at "Loading providers...". See `docs/running-the-apps.md`.
- Rebuild the worker (`pnpm --filter @nessie/worker build`) after every turn where worker code changed: in local mode the API runs the worker embedded from its built `dist`, so source edits don't take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- `pnpm --filter @nessie/admin build` is for production/CI bundles only, not the dev loop.
- Root `pnpm build`, `make build`, and production Dockerfiles are lint-gated. Do not replace them with raw build commands unless the replacement keeps an equivalent lint gate. Partial Docker build contexts must copy the root build/lint config files they invoke, including `eslint.config.js`.
- Root `pnpm build` and `pnpm typecheck` generate the Prisma client once, run
  Turbo with `@nessie/cli` excluded, then compile/typecheck the CLI through its
  prepared task. This keeps every generator outside the concurrent phase:
  concurrent generators can temporarily erase Prisma exports while sibling
  packages compile. The standalone `@nessie/cli` build/typecheck stays
  self-contained and may generate before its own compilation. CI must call the
  lint-gated root build; container flows that call Turbo directly must generate
  once in an earlier serialized step.
- After every server start/restart, verify it is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.

## Code Quality

- Strict linting. Builds must not pass without all lints passing.
- No patches on patches. No fallbacks unless required by functionality. Diagnose and fix root causes.
- Before reusing code that hasn't been reused before: pause, plan a refactor, execute it maintaining best architectural practices, then reuse.
- Code files: 500 lines max. Exceeding the cap is an architectural signal — split along cohesive responsibility seams via a real refactor, never by dumping into `-extras`/`-helpers` files.
- No over-engineering. Build the simplest thing that satisfies the current goal. No premature abstractions, no speculative generality, no backwards-compat shims unless functionality requires them.

## Documentation & Goals — update with every change

Every change must keep documentation and stated goals in sync with the code. This is part of the definition of done, not a follow-up.

- When behaviour, architecture, or a public contract changes, update the affected `docs/` document(s) in the same turn.
- When a change alters a project goal or scope, update the goal where it is stated (`docs/brief.md`, the relevant spec, and this file / `CLAUDE.md` if the standard itself changes).
- When a feature is removed or superseded, delete or move its doc to `docs/done/` — do not leave stale specs describing code that no longer exists.
- A change that touches the MCP surface, ports, build steps, or workflow must update `CLAUDE.md`/`AGENTS.md` accordingly.
- If a change has no documentation impact, that is fine — but the decision to skip must be deliberate, not forgotten.

## Verification

- Every UI change must be visually verified using kelpie before considering the work complete.
- Run `kelpie "http://localhost:5455/<path>"` to screenshot the affected page and confirm the feature renders correctly.
- Use Playwright (`mcp__plugin_playwright`) only as a fallback if kelpie cannot be launched. Always run Playwright headless unless the user explicitly requests otherwise.
- This applies to all frontend work: new components, layout changes, styling fixes, and interaction flows.

## Architecture

- All standards, specs, and design decisions live in `docs/`.
- When a document is finished, move it to `docs/done/`.
- Legacy code lives in `src/`. New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`.
- Do not import from `src/` in new code. All reusable concepts must be re-implemented in `packages/`.
- Follow the architecture guardrails and anti-pattern list in `docs/architecture.md` before creating files, reorganizing code, or reusing logic.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
- User-authored MCP connectors may use HTTP/SSE remote endpoints only. Cloud-side stdio process execution is disabled at catalog, instance, dispatch, and worker boundaries; HTTP/SSE/OAuth URLs must pass the SSRF guard. Use remote MCP runners for private networks or local machines.
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
  MCP endpoint with **no Nessie inference**. DeepSignal uses a system-managed,
  user-scoped instance pinned to the single deployment reference
  `DEEPSIGNAL_MCP_APP_KEY`; the resolved value is a DeepSignal-issued,
  Nessie-only `dsk_` bearer. Resolution is limited to the canonical public
  catalog linked from the `deepsignal` integrated-product row, and signing is
  pinned to `https://api.deepsignal.live`; a same-name catalog or changed
  origin cannot receive the key. Every chat (initial and follow-up), history,
  digest, and action request also carries an exact `ai.invoke`
  `X-UOA-Delegation` for
  the linked user/active UOA org/team plus a fresh RS256 `X-Nessie-Context`
  containing non-null user/org/team/agent/run/request/tool-call provenance.
  The app key, delegated user, and signed provenance are independent proofs:
  no per-user OAuth or generic credential fallback is accepted. Generic OAuth
  remains available for ordinary connectors. DeepSignal's app key is distinct
  from every configured secret-bearing environment credential and every
  encrypted per-org webhook signing secret; API/worker startup verifies both.
  Pre-existing identity headers are rejected case-insensitively before fresh
  identity is attached. The active link org/team must exactly match the
  selected team's external UOA mapping; enablement is rechecked for every call,
  and DM keys include the UOA team so conversations cannot cross a team switch.
  Legacy team-less channels fail closed. Managed instances reject generic
  lifecycle and secret writes, and their global product-linked catalog entries
  reject every generic catalog mutation. The worker driver + API
  history hydration share the `@nessie/mcp-manage`
  `resolveInstanceMcpTransport`/`callInstanceTool` seam, and a per-org
  HMAC-verified webhook (`/api/integrations/deepsignal/events`) delivers
  proactive insights as a **coalesced, budgeted rolling digest** (one "N new
  signals" message per user, updated in place; fresh digests capped per user per
  window — env-tunable heuristics, not law) rather than one card per event; the
  Signals page renders them as a triaged Overview/Inbox. See
  `docs/external-tool-integration.md` §2 + §5 and
  `docs/plans/2026-07-09-deepsignal-integration.md`.
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
  tenancy. DeepWater's product auth mode remains `uoa_sso` so first login
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
  owns job isolation, budget enforcement, audit, and rate-card charge booking
  for both PA and shared-agent calls.
  `NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/openai` is the
  deployment-wide inference chokepoint; runtime routing rewrites it to Ledger's
  `/v1/:serviceId/*` adapter for the actual OpenAI, Kimi, MiniMax, or custom
  provider, including embeddings and designer/orchestrator calls. If the
  deployment-wide URL is absent, signing is decided after the effective
  organization provider-record URL resolves, so Ledger routes still receive
  complete attribution and fail before fetch without signing identity.
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
  worker exposure, so a disabled builtin cannot authorize billable work;
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
  rows carrying external/accounting/report/Knowledge evidence are preserved. A
  validated ticket that arrives after final-attempt recovery still attaches
  atomically, clears the stale recovery detail, preserves its exact Ledger
  status, and keeps the Product run `running` until mandatory terminal
  reconciliation, so accepted paid work is neither orphaned nor prematurely
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
  PA-only, takes tenancy strictly from the run context (same team + thread;
  Knowledge page validated against the org), and copies Ledger's terminal
  `{ amount, currency }` exactly as the immutable booked rate-card charge
  assigned to the launch run's immutable `requestedByUserId`, never the updater.
  The external report URL is persisted only from Ledger's authenticated
  `research_start` structured response after its origin and exact job path are
  validated; source count is persisted only from the authenticated
  `research_report` references array. Both carry server-only provenance markers
  before they are exposed, and agent-authored run updates cannot set, replace,
  or mark either value as trusted. Source persistence atomically repairs an
  already-created exact per-run connector usage event, making same-batch
  report/update order irrelevant.
  The locked write also enforces a terminal start ticket's exact Product status
  mapping (`complete` → `completed`; negative terminal outcomes → `failed`).
  That mirrored charge is not a provider-invoice actual and complex runs may
  reconcile higher upstream. Re-enable preserves richer probed schemas only
  when tool names exactly match the current Ledger contract; legacy
  direct-provider projections are replaced and must be explicitly re-granted.
- deep.agent crawl web scanning is an MCP connector template: install a Nessie-reachable SSE endpoint (`/mcp/sse`) with bearer auth, then approve/grant the discovered tools. The crawl library implementation belongs behind the deep.agent service boundary; do not embed Crawl4AI's Python package in the API/worker or expose an unauthenticated crawler to the public internet.

## File storage & accounting — single chokepoint

- **All blob file operations** — store, stream, download, delete, version, attachment-linking — MUST go through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes from anywhere else (routes, worker tools, services). Build it once per process from `config.storage`.
- **Storage accounting is part of the file op, not optional.** Every store increments and every delete decrements the `StorageUsageEvent` ledger (signed-byte deltas). This is what keeps per-organization / team / space / uploader usage always known, and it is enforced by the `FileService` so it can never be skipped. Uploads are quota-gated via `Budget.storageLimitBytes`.
- Uploads can be up to `NESSIE_MAX_UPLOAD_BYTES` (default 5 GiB), so file paths must **stream** (never `toBuffer`/`readFile`). `Attachment.sizeBytes` is a `BigInt`; serialize it as a string at API boundaries.
- Production storage is S3-compatible (self-hosted MinIO); local dev defaults to `filesystem`. See `docs/deployment.md`.
