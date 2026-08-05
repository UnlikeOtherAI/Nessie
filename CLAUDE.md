# Nessie

Multi-tenant, self-hosted agentic work platform. Organisations host their own Nessie instance; users collaborate in a hierarchy of Organisation → Project → Team → Channel, with RBAC, approval gates, an audit trail, a token-cost ledger, MCP connector management, triggers/scheduling, video calling, and human work distribution.

> **Voice:** Voice is a secondary, nice-to-have control surface — used mainly from the companion mobile app to issue commands — not the primary interface. The primary interface is the admin web UI (`admin/`). A voice companion (OpenAI Realtime API, `gpt-4o-realtime-preview`) exists in `macos/` but is optional and architecturally separate from the main control plane.

@./AGENTS.md

## Architecture

- **API** (`api/`, port 5454) — multi-tenant REST control plane: auth (OIDC/session), channels, tasks, approvals, triggers, MCP connector management, token ledger, audit log
- **Worker** (`worker/`) — async execution service: agentic loop, task scheduling, trigger delivery, mailbox processing
- **Admin** (`admin/`, port 5455) — full product interface for operators and knowledge workers
- **Web** (`web/`) — public landing page only
- **Packages** (`packages/`) — shared runtime, scheduling, policy, and type libraries
- **Guardrails** ([docs/architecture.md](docs/architecture.md)) — things to avoid when creating files, organizing code, sharing logic, and preserving security/testability boundaries

## Message reply threads (#233)

`Thread` is a conversation *container* (channel → named threads); Slack-style *reply threads* live one level deep on messages: `Message.rootMessageId` (nullable self-FK; replies to replies attach to the same root), with materialized per-root `replyCount`/`lastReplyAt`/`replyParticipantIds` updated atomically via `@nessie/runtime` `applyReplyBookkeeping` in the message-create transaction, and `MessageThreadFollow` per (user, root) with auto-follow on participate (author the root, reply, or be mentioned in a reply) plus explicit unfollow. Reply visibility inherits the container; deleted roots tombstone and keep their replies; "Also send to #channel" posts an inline top-level copy carrying `metadata.replyBroadcast.rootMessageId`. Message-create accepts `rootMessageId` (validated same-container top-level root); list defaults to top-level posts and takes `?rootMessageId=` for paginated replies; realtime adds `message.reply` + `message.reply.meta`. A run triggered by a message replies **into that message's reply thread** by default (root = `triggerMessage.rootMessageId ?? triggerMessage.id`; conversation history and thread-following scope to the reply thread); DeepWater/product-handoff and external-agent paths stay top-level and byte-identical. Admin: reply-summary bar under roots, deep-linkable right-hand thread panel (`/channels/:id/threads/:threadId/replies/:rootId`, pushes ≥1280px, overlay 900–1279px, full-screen <900px, drag-resized width persisted), `T` opens the focused message's thread. Reply-unread counters (#212) and the Threads inbox (#213) build on `MessageThreadFollow`.

**Reply placement + thinking bubbles** ([docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md](docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md)): where a run's reply lands is decided **before** the run starts — engagement decisions carry a model-judged `replyPlacement` (`thread` = answer owed to the asker's exchange; `channel` = standalone message to the room; @mentions and PA DMs stamp `thread` structurally, never by content heuristics) persisted on `Run.replyPlacement`; `resolveReplyRootMessageId` (`worker/src/run/execute/reply-placement.ts`) applies it after the DeepWater-handoff/external-agent/PA-delegation carve-outs and persists the resolved anchor on `Run.replyRootMessageId`. While a run thinks, a per-run `ThinkingRecorder` coalesces visible reasoning deltas (2 KiB/250 ms) plus tool-activity lines into durable `run_thinking_chunks` rows, each also published on the thread SSE stream with its chunk id (`stream.reasoning` / `stream.thinking.tool`; `stream.start` now carries the reply anchor, and `stream.done` is always published last). The admin renders a dashed, full-width **thinking bubble** with a 1–2-line live thought ticker wherever the reply will land — bottom of the channel feed for top-level replies; compact under the root row plus full bubble in the thread panel for threaded ones (reply text streams only where the reply will land) — and clicking it opens a centered thought-process dialog that streams live and merges the durable log for mid-run joiners (`GET /api/threads/:id/thinking` bootstrap, `GET /api/threads/:id/runs/:runId/thinking` full log, both thread-visibility-gated; `stream.*` stays excluded from SSE backlog replay).

Legacy single-user server lives in `src/` and is being removed — do not rely on it for new work.

## File storage & accounting — single chokepoint

- **All blob file work** (store, stream, download, delete, version, attachment-linking) goes through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes anywhere else — route uploads, worker tools, avatars, and logos all use the `FileService`.
- **Accounting is part of every file op, not optional:** each store writes a `+bytes` and each delete a `-bytes` `StorageUsageEvent`, so org / team / space / uploader usage is always known. Uploads are quota-gated by `Budget.storageLimitBytes`.
- Uploads stream end-to-end (default cap `NESSIE_MAX_UPLOAD_BYTES` = 5 GiB; never buffer whole files). `Attachment.sizeBytes` is `BigInt`, serialized as a string at API boundaries.
- JPEG/PNG/WebP uploads have EXIF/GPS metadata stripped at the `FileService` store chokepoint (EXIF orientation applied to the pixels first, ICC profiles preserved, accounting records the post-strip size); orgs can opt out via `Organization.stripImageMetadata`, and images over 50 MiB or undecodable pass through unchanged to keep uploads streaming.
- Backend = S3-compatible MinIO in production, `filesystem` in local dev. KB file nodes (`KnowledgePage.kind = file`) and page attachments live alongside documents — see [docs/knowledge-base-requirements.md](docs/knowledge-base-requirements.md).

## Web Push (browser notifications)

- Browser Web Push is a second push transport alongside native APNs/FCM: the worker's `handlePushDispatch` also fans messages out to users' `WebPushSubscription` rows. Crypto is in-process (`packages/push`, RFC 8291 + RFC 8292 VAPID, no third-party deps).
- One VAPID key pair per instance via `NESSIE_WEBPUSH_PUBLIC_KEY`, `NESSIE_WEBPUSH_PRIVATE_KEY`, `NESSIE_WEBPUSH_SUBJECT` (all three required to enable). Generate with `node scripts/generate-vapid-keys.mjs`. Public key is safe to expose; private key is secret.
- Admin SPA service worker (`admin/public/sw.js`) + manifest + a "Browser notifications" toggle on `/settings/notifications`; API endpoints under `/api/push/web/*`. Requires HTTPS (localhost exempt); iOS needs an installed PWA (16.4+).
- **Authoritative guide: [docs/web-push.md](docs/web-push.md).**
- User alerts: direct @mentions write durable per-recipient `UserAlert` rows in the message-create transaction (self skipped, broadcast none, agent-authored identical; mute suppresses push, never the row) and surface via `GET /api/alerts` + `POST /api/alerts/read`, realtime `alert.created`/`alert.read`, the admin top-bar bell, and mention-framed push (`<author> mentioned you in <channel>`).

## Tech

- Node/TypeScript (strict mode), Fastify, Prisma + PostgreSQL
- Multi-tenancy: Organisation → Project → Team → Channel schema with `organization_id` scoping on all child tables
- RBAC policy engine with deny-overrides; OIDC SSO with PKCE
- Agentic loop: run budget is per-agent effort-scaled (`Agent.effort` =
  low/medium/high/xhigh; medium = 12 iterations / 20 tool calls / 90 s / cost
  cap, the historical default). `xhigh` is effectively unbounded — governed
  only by the scope `Budget` gate and the loop's repeated-call detection. See
  `worker/src/run/agentic-loop.ts` (`EFFORT_BUDGETS`) and
  `docs/plans/2026-07-20-agent-harness-v2.md` §3.5.1. A budget-cap stop is
  never silent: it is classified (`iteration_limit` / `tool_call_limit` /
  `time_limit` / `token_limit` / `cost_limit` / `repeated_tool_calls`,
  `worker/src/run/execute/budget-stop.ts`) and always surfaced — partial
  assistant text is delivered with a "stopped at the limit" notice (run
  `completed`), or a clear notice is posted and the run `failed` when the loop
  produced nothing; a `run.budget_exhausted` `TaskEvent` records the reason.
  All tool results (builtin, MCP, `delegate`) are truncated at the single loop
  chokepoint before entering context. Every run also records a wall-clock-only
  stage-latency breakdown at its terminal state (completion **and** failure) as
  a `run.timing` `TaskEvent` — `{ outcome, runId, queueWaitMs, totalMs,
  inferenceMs, inferenceCount, toolMs, toolCount }`, no cost data
  (`worker/src/run/execute/run-timing.ts`) — so a slow run is diagnosable;
  owners read recent summaries at `GET /api/ledger/runs/timing`.
- **Budget threshold alerts + failed-run attribution** (local ops only, never
  UOA credits). The gate no longer only observes usage passively: `evaluateBudget`
  (`packages/runtime/src/budget.ts`) returns the byte-identical verdict PLUS an
  alert snapshot, and `applyBudgetGate` fires **at most once per budget scope per
  period** when cumulative spend first crosses `Budget.warnThresholdPercent`
  ('threshold') or first blocks a run ('blocked'). Alerting runs AFTER the verdict
  is applied and swallows its own errors, so blocking behaviour is unchanged.
  Durable crash-safe dedupe = a `budget_alerts` marker row unique on
  `(scopeType, scopeId, periodStart, kind)`; each alert also emits a
  `budget.threshold_alert` `TaskEvent` (queryable) and enqueues
  `budget.alert-dispatch`, which notifies org owners + the scope's managers
  through the shared push pipeline (`worker/src/control/push-delivery-core.ts`,
  reused by message push + budget alerts), respecting push preferences,
  deep-linking `/ops/usage`. Every terminal run persists its inference spend:
  completion and the budget-stop no-text path already did; the generic
  failure/crash path now does too via a caller-owned invocation accumulator
  threaded through `runAgenticLoop`, so a failed run's tokens stay attributable
  (buzz #1659, idempotent on `inferenceInvocationId`). Owners read spend split by
  run outcome (completed/failed/cancelled/…) at `GET /api/ledger/tokens/by-outcome`.
- Active run lifecycle controls (`api/src/routes/runs.ts` +
  `api/src/services/runs.ts`; buzz #2453/#1593, epic #141): org-scoped
  `GET /api/runs/active` lists live runs (+ recently-ended restartable runs);
  `POST /api/runs/:id/cancel` cancels — a queued/approval-suspended run flips
  straight to `cancelled` (never executes; the worker's terminal guard skips
  it), a running run gets a cooperative `cancelRequestedAt` flag the agentic
  loop polls between iterations and tool-call batches, exiting via the
  classified-stop machinery (`worker/src/run/execute/cancel-stop.ts`, mirroring
  budget-stop: partial text delivered + a "cancelled" notice, run `cancelled`,
  `run.cancelled` `TaskEvent`). `POST /api/runs/:id/restart` re-runs a terminal
  `failed`/`cancelled` run, enqueuing a fresh run that replays the same trigger
  message and thread and links back via `Run.restartOfRunId`. A run whose
  trigger message carries `integrationLaunch` metadata (DeepWater handoff) is
  rejected from both with `409 RUN_HANDOFF_MANAGED` → use `research_cancel`; the
  handoff invariants are never touched. `Run.triggerMessageId` (populated by the
  chat orchestrator + integration handoffs) backs both the guard and the replay.
  Admin surfaces cancel/restart on the Agents → Activity page
  (`admin/src/components/features/runs/RunLifecyclePanel.tsx`).
- MCP connector management (REST, not JSON-RPC): `api/src/routes/mcp.ts`
- MDNS/Bonjour — backend advertises `_nessie._tcp` for local network discovery

## Git — worktrees mandatory

- The main project checkout must always stay on `main`. Never switch branches in it.
- Every task — and every parallel agent/CLI — does its work in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never edit the main checkout directly.
- Never reset, clean, or discard another worktree's or agent's work.
- When any task is done, merge the completed task branch into `main` in the same turn after review, linting, and tests pass; do not leave completed work parked in a worktree unless the user explicitly says not to or verification is blocked.
- Then in the main checkout run `git switch main && git pull --ff-only`, remove the worktree (`git worktree remove …`), and delete the merged branch.

## Dev mode (hot reload)

- `pnpm dev` (repo root) runs the **API (5454) and admin (5455) together with hot reload** — `turbo run dev --parallel`. Admin source edits hot-reload via Vite HMR; API source edits restart the server via nodemon. Use this for local work; do not hand-build the admin to see changes.
- **Polling is required.** The repo lives under `/System/Volumes/Data/.internal/…` (a macOS data-volume firmlink path) where fsevents does not deliver change events, so native watchers never fire. Vite uses `server.watch.usePolling` (`admin/vite.config.ts`) and the API uses `nodemon --legacy-watch`; do not remove these or hot reload silently breaks.
- After starting/restarting a dev server, verify it: hit `GET /health` (5454) and `GET /` (5455), and confirm `@vite/client` is present in the served admin HTML.

## Build (production / CI)

- `pnpm --filter @nessie/admin build` produces the static admin bundle (`dist/`); `pnpm --filter @nessie/admin preview` serves it. This is for prod/CI, **not** the local dev loop — use `pnpm dev` instead.
- Desktop installable builds that embed local admin changes must build admin
  with `VITE_API_BASE_URL=https://api.nessie.works`, then run Tauri
  with `--config '{"build":{"frontendDist":"../../admin/dist"}}'`. Do not use
  the admin web origin (`https://app.nessie.works`) as the API base URL;
  login will stall at "Loading providers...". See
  [docs/running-the-apps.md](docs/running-the-apps.md).
- Rebuild the worker after every turn where worker code changed: `pnpm --filter @nessie/worker build`. In local mode the API runs the worker **embedded from its built `dist`** (`import('@nessie/worker')`), so worker source edits do not take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- Root `pnpm build`, `make build`, and the production Dockerfiles are lint-gated. Keep lint in those build paths instead of replacing them with raw `turbo build` or package build calls. Partial Docker build contexts must copy the root build/lint config files they invoke, including `eslint.config.js`.
- Root `pnpm build` and `pnpm typecheck` serialize one Prisma client generation,
  exclude `@nessie/cli` from Turbo, then compile/typecheck the CLI through its
  prepared task. That keeps every generator outside the concurrent phase:
  concurrent generators can temporarily remove Prisma exports while sibling
  packages compile. The standalone CLI build/typecheck remains self-contained
  and may generate before its own compilation. CI calls the lint-gated root
  build; direct Turbo container flows generate once in an earlier step.

## Production deployment

- Production is **self-hosted on Hetzner** (`178.105.82.46`) as Docker
  containers, reusing the host's shared Caddy edge proxy and Docker networks
  (`edge`/`db`). It is **not** GCP Cloud Run — the old GCP workflow/spec are
  retired (`docs/done/phase2-gcp-deployment-spec.md` is historical).
- URLs: public web `https://nessie.works`, admin `https://app.nessie.works`,
  API `https://api.nessie.works`. TLS is automatic (Caddy + Let's Encrypt);
  DNS is Cloudflare, DNS-only.
- Stack: `nessie-api` + `nessie-worker` (one `Dockerfile.app` image, command
  override) + `nessie-admin` (static nginx) + a dedicated `nessie-postgres`
  (pgvector — the shared Postgres lacks the `vector` extension). No Redis (queue
  and realtime are Postgres-backed). Mode is `selfHosted`; first login is the
  one-time bootstrap owner URL.
- Compose: `infrastructure/compose/docker-compose.prod.yml`. Redeploy with
  `infrastructure/compose/redeploy.sh` after rsync'ing to `/srv/nessie`.
- The API trusts `X-Forwarded-For` only when `NESSIE_API_TRUSTED_PROXY_HOPS`
  is set. Production behind Caddy sets it to `1`; local/dev defaults to `0`
  and ignores forwarded client IP headers.
- **Authoritative guide: [docs/deployment.md](docs/deployment.md)** — first
  deploy, redeploy, config reference, MCP secret store, and SSO status.

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

## Theming / design system

- The admin is fully color-themed via CSS custom properties. **All color lives in
  `admin/src/styles.css`** — the base `:root` is the default "nebula" theme, and
  each `[data-theme="<id>"]` block re-declares the same tokens. Components carry
  **no** raw hex or Tailwind named-color utilities; they reference tokens via
  `var(--x)` / `bg-[var(--x)]`.
- Switcher: `ThemeProvider` (`admin/src/providers/`) + Appearance page
  (`/settings/appearance`); choice persists locally in
  `localStorage["nessie.theme"]` for logged-out screens and is also saved to
  `User.preferences.theme` for signed-in users so web, desktop, and mobile use
  the same account theme.
- Adding a theme = add a `[data-theme]` block (redeclare every token) + register
  the id in `ThemeProvider`. See [docs/plans/2026-06-10-design-system-theming.md](docs/plans/2026-06-10-design-system-theming.md).

## Ports — NON-NEGOTIABLE

- **API**: `5454` (local dev) — always. Do not kill or restart without restarting on the same port.
- **Admin**: `5455` (local dev) — always. UI verification MUST use `http://localhost:5455`.
- Never use any other port for these services in local dev.
- Moved from 5554/5555 on 2026-06-11 because an Android emulator (`gpteen_api34`) squats on 5554/5555 — see the emulator-port-conflict memory.
- **Production is unchanged:** the API container's internal port stays `5554`, pinned via `NESSIE_API_PORT` in `infrastructure/compose/docker-compose.prod.yml` (behind the shared Caddy proxy). Only local dev moved.

## Verification

- Every UI/frontend change must be verified using Playwright before the work is considered done.
- Use Playwright (`mcp__plugin_playwright`, or a local Playwright script) to load `http://localhost:5455/<path>`, screenshot the affected page, and confirm correct rendering.
- Always run Playwright headless unless the user explicitly requests otherwise.

## MCP Integration

The live API server (`api/`) exposes a **REST MCP connector-management surface** under `/api/mcp/*`. This is for managing third-party MCP connectors (register, list, approve, activate, delete) — it is not a JSON-RPC tool server.

The management core lives in the shared **`@nessie/mcp-manage`** package (catalog, instances, probe, tool projection, credentials, OAuth, encrypted secret store, SSRF wrapper) so the API routes and the worker's personal-assistant tools share one implementation. On top of it:

- **Library + discovery**: `GET /api/mcp/library` (curated well-known remote servers + live search of the official MCP registry, HTTP/SSE remotes only), `POST /api/mcp/discover` (probe a pasted link for an MCP endpoint + auth requirements), `POST /api/mcp/library/import`. Surfaced as the admin Connectors page **Library** tab with a guided one-click install.
- **Personal-assistant connector tools** (PA-only builtins): `connector_list`, `connector_library_search`, `connector_discover`, `connector_install`, `connector_authorize`, `connector_test`, `connector_set_secret`, `connector_uninstall` — full conversational setup from just a service name or URL, with secrets stored encrypted (`POST /api/mcp/instances/:id/secret` is the UI equivalent).
- **Dynamic OAuth** (MCP authorization spec): `{ method: "oauth2" }` with no static client triggers metadata discovery (RFC 9728/8414), Dynamic Client Registration (RFC 7591, one public client per org × issuer in `mcp_oauth_clients`), authorization-code + PKCE S256 + RFC 8707 `resource`, pg-backed one-shot state (`mcp_oauth_states`), per-user token placement, and automatic refresh at probe/dispatch. Notion/Linear/Sentry/Atlassian/Asana are curated OAuth entries — users just sign in. Set `NESSIE_API_PUBLIC_URL` in prod so the worker can mint callback URLs.
- **Scoped sharing**: owners manage every install scope; org **admins** manage the shared scopes (organization/project/team/channel); members self-serve at their own user scope and see shared installs they can reach. Worker toolset assembly is scope-aware (user-scope connectors surface only in the installing user's PA runs); user-scope installs auto-activate their discovered tools, shared scopes keep the `pending_review` gate. See `docs/external-tool-integration.md` §2.
- **Credential refs stay server-side**: public instance/override writes never accept a caller-chosen `credentialRef`, and list/detail responses never return one. The UI/PA submits plaintext once to the encrypted secret store; only its server-minted `secret_*` ref is attached. Environment refs are exact-allowlisted and integration-provisioning-only.
- **Admin locking**: owners/admins can lock a catalog entry (`/lock`, `/unlock`); members cannot install it or re-register its endpoint under another name (🔒 pill + disabled install in the UI, clear refusal from the PA). Install-time gate only — existing instances keep working.
- **Context-safe toolsets**: above `NESSIE_MCP_INLINE_TOOL_LIMIT` (default 12) exposed MCP tools, agent runs get three meta tools (`mcp_find_tools` → `mcp_load_tools` → call directly, `mcp_drop_tools` to free) over a live tool list instead of every schema inlined — see `docs/external-tool-integration.md` §5.
- **External-agent products** (e.g. DeepSignal): a first-party product can be surfaced as a per-user DM channel whose bound agent has `executionMode = external_mcp` — turns are proxied straight to the product's MCP endpoint with **no Nessie inference**, reply + cards rendered verbatim. DeepSignal's system-managed user instance is pinned to the deployment reference `DEEPSIGNAL_MCP_APP_KEY`; it resolves a DeepSignal-issued, Nessie-only `dsk_` bearer only through the canonical public catalog linked from the `deepsignal` product row and only for `https://api.deepsignal.live`. That global catalog is integration-owned, absent from the generic library, and immutable through generic catalog controls. Initial/follow-up chat, history, digest, and action calls independently add exact-scope `X-UOA-Delegation` user/workspace identity plus a fresh RS256 `X-Nessie-Context` carrying non-null user/org/team/agent/run/request/tool-call provenance; stale identity headers are rejected case-insensitively. Every call rechecks team enablement and requires the selected team's external UOA mapping to match the active link. The private DM key includes the active UOA team (`extagent:deepsignal:${orgId}:${userId}:${uoaTeamId}`), so switching teams creates a distinct thread/conversation and legacy team-less channels fail closed. DeepSignal has no per-user OAuth or generic credential fallback; ordinary third-party connectors retain dynamic OAuth. Startup rejects reuse of the dsk key through any configured secret-bearing environment credential (including URL userinfo/key lists) or encrypted per-org webhook HMAC secret. Generic lifecycle/secret surfaces reject this integration-managed instance. The worker driver and API share one `@nessie/mcp-manage` "connect + call one tool" seam (`resolveInstanceMcpTransport` / `callInstanceTool`, next to `probeConnection`). History hydration (`POST /api/channels/:id/external-sync`, idempotent on `metadata.external.turnId`) and a per-org HMAC-verified insight webhook (`POST /api/integrations/deepsignal/events`; secret set via `PUT /api/integrations/products/:slug/webhook-secret`, stored encrypted) keep the product as source of truth. The webhook is **delivery-shaped, not one-card-per-event**: insights coalesce into a single rolling "You have N new signals" digest message per user (updated in place within `NESSIE_SIGNAL_DIGEST_WINDOW_MS`, default ~1h; per-insight ids retained for idempotency + counts-by-kind), and fresh proactive digests are budgeted per user per rolling window (`NESSIE_SIGNAL_BUDGET_MAX`, default 6 / `NESSIE_SIGNAL_BUDGET_WINDOW_MS`, default 24h — sane heuristics, not law); over budget an insight is still recorded on the digest but the channel interruption (realtime `message.new`) is suppressed. DeepSignal also exposes a **Signals** page — a triaged Overview/Inbox: `GET /api/integrations/products/deepsignal/signals?include=active|all` (insight digest, grouped by kind with an attention tally + mission detail drawer) + `POST .../signals/:insightId/act` (done|snooze|mute|reopen) run over the user's user-scoped instance via the shared `resolveUserScopedProductTransport`/`callInstanceTool` seam, fail-closed to `{ status: 'needs_setup' }` when not linked. See `docs/plans/2026-07-09-deepsignal-integration.md`, `docs/plans/2026-07-10-deep-integration-surface-registry.md` + `docs/external-tool-integration.md` §2.

- **DeepWater as an agent tool**: enabling DeepWater for a team (owner-only
  `team-enablement` toggle) provisions a **team-scoped, tool-projecting**
  `McpServerInstance` from the `deep-water` catalog entry, resolves the
  **Ledger-only** MCP adapter from **`LEDGER_DEEPWATER_MCP_URL`** (canonical
  hosted value `https://ledger.unlikeotherai.com/v1/mcp/deepwater`; enable fails
  loudly with `LEDGER_DEEPWATER_MCP_URL_UNSET` when unset), installs a bearer
  HTTP transport, and projects Ledger's `research_start`, `research_status`,
  `research_report`, `research_list`, and `research_cancel` tools into
  `ToolRegistryEntry` as `active` (surfaced as `mcp_research_*`); disabling
  removes the instance linked from the first-party public product before
  persisting `enabled=false` (robust to renames and private same-name entries).
  Generic instance test, refresh, healthcheck, and delete operations reject
  this integration-managed instance with
  `MCP_INSTANCE_MANAGED_BY_INTEGRATION`; generic secret writes are also
  rejected, and PA probe/uninstall tools direct callers to the Integrations
  toggle, which is its sole lifecycle path.
  **Default OFF, explicit per-agent grant required:** the
  projected DeepWater tools and the `deep_water_run_update` builtin are flagged
  `requiresExplicitGrant`, so team scope alone never exposes them — an agent (PA
  or shared) sees them ONLY when its `toolPolicy` carries an explicit allow
  (`=== true`) and the instance scope reaches the run; a grant never bypasses
  tenancy, and an absent/inherited verdict is a denial. Owners write these
  verdicts through the targeted `/api/mcp/tools/.../policy-targets/...` route,
  which merges one key under a per-agent database lock and preserves unrelated
  allow/deny entries. Canonical DeepWater rows take the team-transition lock,
  re-read the projection generation, then take the agent lock. Its minimal
  owner-only target list includes the
  system-managed Personal Assistant without widening `/api/agents` or exposing
  private PA bindings/activity. The DeepWater launcher manages the five MCP
  projections plus `deep_water_run_update` as a six-entry bundle through
  `/api/integrations/products/deep-water/agent-access`; it disables launch, and
  the API rejects before run creation, until the PA has all six. The updater
  satisfies readiness only while its registry row is enabled and active,
  matching worker exposure. Owners can use
  the same bundle action for shared agents or manage individual entries at
  `/agents/tools`. Generic agent create/PUT rejects protected keys and
  provenance markers, a locked stale PUT carries existing protected state
  forward; clones and spawned subtask children strip it, PA bootstrap config
  cannot inject it, generic responses redact server provenance, and Agent
  Designer does not expose protected switches. Generic shared-agent create,
  list, parent selection, hierarchy/status/activity/realtime reads, and channel
  binding require the same organization;
  system/global exceptions stay in dedicated bootstraps. Bundle provenance keeps the
  shared updater while any team or manual
  grant depends on it; the updater's individual OFF control is disabled until
  those dependencies are revoked. A disabled updater does not satisfy
  readiness, but remains part of cleanup identity so bundle revocation clears
  its protected allow before later re-enable. Bundle and individual lifecycle revocation
  return 409 for queued/running/needs_setup work, with no force override. The
  launch transaction takes the team lock,
  then policy lock, then performs the final 6/6 read and durable run insert.
  Disable returns `LEDGER_DEEPWATER_ACTIVE_RUNS` for queued, running, or
  `needs_setup` research; cancel/recover the run or wait for a terminal state
  before retrying. Handoff enforcement is activated only by server-authored
  DeepWater message metadata `integrationLaunch.{productSlug,runId}`; ordinary
  messages remain unguarded. The lookup requires that exact durable run id plus
  message/org/team/thread, and missing or mismatched state fails closed. For
  that exact Product run, the worker binds the first `research_start` provider
  tool-call id and exact arguments before transport. A still-clean Product run
  moves to `failed` only for a validated Ledger-local pre-start rejection
  (`invalid_request` 400/401, `budget_exceeded` 402, or `forbidden` 403), or for
  Nessie's own budget block while it remains truly queued, uncorrelated, and
  undispatched. Conflicts, upstream rejections, 5xx, malformed errors or malformed
  successful tickets, throws, timeouts, and uncertain claim or
  ticket-persistence outcomes abort the Nessie run for queue retry without
  terminalizing it; recovery reuses the exact saved correlation and arguments.
  A validated matching `rs_...` ticket and exact Ledger status are persisted
  before success is returned, and a retry can replay both locally without
  transport. The managed integration reserves the canonical five
  `mcp_research_*` names against private connector collisions. Same-batch
  status/report/cancel calls are pinned to that id, while
  `research_list` and delegation remain blocked for the launch turn. Run-update and
  Knowledge calls stay blocked until exact start-result delivery and throughout an abandoned
  timeout attempt. Result delivery uses an invocation-specific token
  acknowledged only after connector telemetry, tool-end recording, and tool
  message incorporation; failure-persistence and post-ticket/pre-delivery
  timeouts therefore remain fatal. Ordinary
  setup/inference/callback failures are promoted while unresolved. Budget
  blocking settles only a truly uncorrelated queued Product row before
  terminalizing the Nessie run; correlated work remains recovery-safe, and an
  exact late definitive rejection may settle correlated `needs_setup`.
  Missing/duplicate attachment state and an
  omitted required start fail closed; exhausted clean candidates become
  `needs_setup`, while rows with external/dispatch/report/Knowledge evidence
  are preserved. A validated ticket that settles after final recovery still
  attaches, clears the stale recovery detail, preserves its exact Ledger status,
  and keeps the Product run `running` until mandatory terminal reconciliation,
  preventing accepted work from being orphaned or prematurely unblocked. Fatal tools
  retain paired sanitized end events, and the worker awaits every started
  same-batch tool wrapper before retry. Ordinary DeepWater calls remain
  unchanged. PA message creation,
  run attachment, PA run/task creation,
  and direct `run.execute` enqueue are atomic; product handoffs bypass chat
  engagement decisions while ordinary chat remains unchanged. Duplicate
  enqueue conflicts roll back the duplicate unit, and realtime publication is
  post-commit/non-fatal. Ambiguous
  null-external-id work stays blocking to avoid deleting the
  connector during an in-flight, metered `research_start`; attached-run errors
  point to the chat where PA can call `research_cancel`. This is unchanged for
  other connectors (scope still exposes them). First-party team-enable stands in
  for the manual install + admin-approve gate. The managed instance resolves
  `LEDGER_PROXY_TOKEN` as Nessie's one deployment-wide, product-bound Ledger app
  API key, never a per-user credential; personal DeepWater overrides are
  forbidden. Signed caller identity is a
  separate boundary, and webhook signing secrets must never be reused as the
  app key. Every
  dispatch also carries a fresh RS256 `X-Nessie-Context` (non-null
  user/org/team/agent/run)
  and the linked user's short-lived `X-UOA-Delegation`, obtained through UOA
  token exchange. New renewable UOA sessions require a nonnegative `tv`
  authentication epoch and bind immutable `{sub, org, team, tv}` proof into the
  Nessie access session and refresh family. UOA's opaque refresh credential is
  AES-256-GCM encrypted server-side; the browser receives only Nessie's
  unrelated rotating cookie. Delegation assertions/caches and billing
  `X-UOA-Actor` use that session proof and require exact equality with the live
  product-link mirror and selected team. PostgreSQL family/user locks serialize
  rotation, replay, issuance, security revocation, and encrypted-credential
  erasure across API replicas; first-workspace creation is exact-workspace
  locked and product-link epochs cannot regress. Ledger therefore authenticates Nessie independently from the
  human whose research and raw usage it attributes. Setting
  `NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/openai` applies the
  same signed attribution to all model and embedding calls; runtime routing
  rewrites the final path to Ledger's `/v1/:serviceId/*` adapter for the
  selected OpenAI, Kimi, MiniMax, or custom provider. When the deployment-wide
  URL is absent, signing is decided after resolving the effective organization
  provider-record URL, so a Ledger route still receives complete attribution
  and fails before fetch when signing identity is unavailable. User-triggered
  background jobs persist their user/team origin and named system agent/run, and
  fail before model dispatch if it is unavailable. DeepWater research launch
  retries reuse the provider's stable `tool_call_id`. Ledger owns job isolation,
  budget enforcement, audit, and raw usage metering; UOA alone rates that usage.
  `deep_water_run_update`
  is not PA-only — any *granted* agent can write back the durable Nessie run
  record (same team + thread; `knowledgePageId` validated against the org).
  It never accepts or persists cost, price, charge, tariff, or currency fields;
  Ledger's DeepWater REST/MCP contract exposes none, and UOA alone supplies
  customer-commercial amounts. Nessie persists the external report URL
  only from Ledger's authenticated `research_start` structured response after
  validating its origin and exact job path, and persists source count only from
  the authenticated `research_report` references array. Both require
  server-only provenance before they are exposed; agent-authored run updates
  cannot set, replace, or mark either value as trusted. Source persistence also
  repairs the exact per-run connector usage event atomically, so same-batch
  report/update order cannot lose usage units. The event is operational and
  cost-free, remains attributed to the immutable launch user, and is excluded
  from local cost totals. Historical local values are erased, reduced to a
  cost-free dispatch-recovery marker; the obsolete Product-run cost columns are
  dropped, and a database trigger rejects future DeepWater connector-event
  amounts. The same locked write
  rejects a Product status that contradicts a terminal start ticket (`complete`
  maps to `completed`; failed/cancelled/timed_out map to `failed`). Each org/team
  transition is cross-process
  serialized with a PostgreSQL transaction-scoped advisory lock; connector
  rows and the enablement toggle mutate in one transaction and roll back
  together. A missing linked first-party catalog fails enablement with
  `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE` rather than persisting a dead toggle.
  Re-enable preserves richer probed schemas only for the current Ledger
  tool-name contract; legacy direct-provider projections are replaced.

Customer tariffs, statements, credits, top-ups, subscriptions, adjustments,
and Stripe lifecycle stay in UOA. Ledger's raw reporting API is UOA-only; Nessie has no billing
reader key, legacy Ledger billing route, or parallel customer raw-metering UI.
Its Ledger product key is used only to execute and attribute Nessie's paid
inference, DeepWater, Serper, and other metered calls. UOA reads Ledger and
authors the service/team/user breakdown. The canonical UOA customer statement,
Checkout, Portal, and cancellation
preview/confirm instead use the separate Nessie-only
`UOA_BILLING_APP_KEY_NESSIE` and a fresh 45-second actor assertion signed by
`UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE`. The main-branch deploy validates those
credentials on the Actions runner and installs them atomically through a
dependency-free host script. Requests bind the exact linked UOA user/org/team.
Nessie renders UOA's public display models without tariff math: exact
plan/markup copy, service and user usage, commercial lines, totals, action
labels, disabled reasons, and cancellation choices all come from UOA. For every
hosted or cancellation-preview action, the API re-fetches the statement,
validates the frozen action id/path and subject, then proxies the UOA-produced
body unchanged; browsers cannot supply action bodies or return URLs.
Cancellation confirmation carries only UOA's opaque token, idempotency key, and
selected UOA choice. UOA alone evaluates and revalidates team-wide direct
access and indirect Ledger use. Nessie never stores commercial tariff, Stripe
customer/subscription/invoice, credit balance, top-up policy, payment consent,
add-on, statement, or cancellation state. Every active exact-team member may
read the same UOA-owned team credit account. Remaining credits are the headline,
followed by pending/added/used credits, connected-service usage, recent activity,
and automatic top-up state. UOA fixes 1,000 credits to US$1 and returns all
amounts ready to display; Nessie never derives credits from tokens, provider
cost, money, or raw Ledger units. Managers receive named-user/payment detail
and frozen funding/add-on actions; members receive a privacy-safe read-only
projection containing their usage plus anonymous other-member and unattributed
totals. Every funding/add-on action is re-fetched, exact-path/body checked, and
relayed unchanged.
`/tokens` is the customer Credits & Billing surface and contains only those
UOA-authored models. Nessie's owner-only local token, pricing, estimate,
projection, connector, file, and budget telemetry is isolated at `/ops/usage`
and must never be rendered beside customer credits or statements. Integrated-
product APIs do not query or return local usage summaries.
A successful direct Nessie SSO exchange records exact `nessie` access through
UOA before any local session is returned. The confirmation is subject-bound,
requires UOA's `204`/`no-store` response, and fails login closed; indirect
connector, DeepWater, agent, and background execution never records direct
product access.
The model and action contract come directly from the public MIT-licensed
`@unlikeotherai/billing-statement-protocol` 1.2.0 package, vendored
byte-for-byte from UOA commit
`272e4d95846788f752d1e623d5f69f7c961f1dc5`. Root lint verifies its complete
SHA-256 manifest; the API compiles its exported JSON Schemas and the admin
imports its exported types, so Nessie owns no parallel billing contract.
Statement V2 renders UOA's exact connected-service team/origin/user portfolio
from one pinned Ledger `metering-portfolio-v1` `group_by=user` snapshot;
Nessie never calculates shares or aggregates services. Hosted and cancellation
actions remain on the frozen V1 action contract.

Builtin `web_search` is also Ledger-only. Agent, delegated sub-agent, and
workflow calls use `${LEDGER_PUBLIC_URL}/v1/serper/search` with Nessie's
product-bound `LEDGER_PROXY_TOKEN`, a fresh signed `X-Nessie-Context`, optional
linked-user `X-UOA-Delegation`, and the stable provider/workflow tool-call id.
Workflow queue identity must match its durable actor and installation scope
before signing. Direct `google.serper.dev` calls and `SERPER_API_KEY` fallbacks
are forbidden. Local connector rows are operational telemetry only; Ledger is
the raw usage/cost source and UOA is the commercial authority.

User-authored MCP connectors are limited to HTTP/SSE remote endpoints. The
cloud API and worker reject stdio process execution for catalog/instance data,
and HTTP/SSE/OAuth URLs are checked by the shared SSRF guard before save or use.
Use remote MCP runners for private networks, local machines, or subprocess-based
servers.

deep.agent crawl web scanning uses the MCP connector path: install a
Nessie-reachable SSE endpoint (`/mcp/sse`) with bearer auth, approve the
discovered tools, and grant them to agents. The crawl library implementation
belongs behind the deep.agent service boundary; do not embed the Crawl4AI
Python package in the API/worker or expose an unauthenticated crawler to the
public internet.

> **Legacy JSON-RPC MCP server removed.** The old `GET /mcp` / `POST /mcp` JSON-RPC server (`src/mcp/server.ts`) that exposed `send_message`, `invoke_tool`, `tools/list`, and 37 tools existed only in the legacy `src/` tree, which is being deleted. There is no JSON-RPC `/mcp` endpoint on the live `api/` server.

See [docs/functionality.md](docs/functionality.md) for the authoritative API surface description. Section §7 describes the removed legacy MCP server for historical reference.

## Individual Communications Connector

- Per-user OAuth connections to external communications providers (Slack + Gmail
  live; Microsoft/Teams planned) normalize provider messages into a single
  `CommsEvent` store via the provider-agnostic `@nessie/comms-connect` core plus
  one adapter package per provider (`@nessie/comms-slack`, `@nessie/comms-google`).
- The registry is empty until wired: `@nessie/comms-providers`
  (`registerCommsConnectorsFromEnv`) builds + registers each adapter from
  `NESSIE_COMMS_*` env at API **and** worker startup; an unset provider simply
  does not register and its jobs park on `ConnectorNotRegisteredError`. Env names
  match the API OAuth-start source of truth (`api/src/routes/comms/oauth-config.ts`).
- OAuth token bundles are encrypted at rest (shared AES-GCM secret-crypto) in a
  **separate** `CommsConnectionCredential` table, never returned to the browser.
- Import is resumable + checkpointed `CommsSyncJob`s plus webhook/watch ingestion,
  all through the worker queue. An expired provider cursor (`SyncCursorExpiredError`)
  triggers a bounded history re-sync; a rejected credential (`needsReauthorization`)
  moves the connection to `needs_reauthorization` and fails the job without retry.
  The sync worker and the subscription-renewal sweep also skip any connection
  whose `ownerUserId` is no longer an active org member (`deactivatedAt`), so
  deactivating a user stops their comms import immediately — the same
  owner-revocation gate the API request auth and the scheduled-trigger poller
  already enforce (`worker/src/control/comms-sync.ts` `isConnectionOwnerActive`).
- Chat-first: the `comms_connect_card` PA tool drives connect; `/settings/connections`
  is the secondary UI. The connector layer holds **no** reasoning logic (the
  Chief-of-Staff boundary). Authoritative spec:
  [docs/plans/2026-07-21-individual-communications-connector.md](docs/plans/2026-07-21-individual-communications-connector.md).

## MDNS

The backend registers `_nessie._tcp` on port 4317 via Bonjour/mDNS on launch. This feature is part of the legacy `src/` runtime; the new `api/` server does not yet register mDNS. Clients on the same network can discover the legacy server automatically without hardcoded IPs.

## Docs

- [brief.md](docs/brief.md) — Historical architecture brief (see banner)
- [build-ai-coworker.md](docs/done/build-ai-coworker.md) — Historical macOS app build plan (moved to done/)
- [context-window-optimization-audit.md](docs/context-window-optimization-audit.md) — Audit + prioritized roadmap for LLM context-window usage in the agentic run pipeline
- [known-limitations.md](docs/known-limitations.md) — Code-verified register of current limitations (status taxonomy; two fixes in flight as of 2026-07-23)
- Finished documents belong in `docs/done/`.

## Documentation & Goals — update with every change

Keeping docs and goals in sync with the code is part of the definition of done, not a follow-up task. With every change:

- Update the affected `docs/` document(s) in the same turn when behaviour, architecture, or a public contract changes.
- Update the stated goal where it lives (`docs/brief.md`, the relevant spec, `CLAUDE.md`/`AGENTS.md`) when scope or a standard changes.
- Delete or move superseded docs to `docs/done/` — never leave a spec describing code that no longer exists.
- Changes to the MCP surface, ports, build steps, or workflow must update `CLAUDE.md`/`AGENTS.md`.

See `AGENTS.md` → "Documentation & Goals" for the authoritative rule.
