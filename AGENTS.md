# Nessie Agent Standards

## Rule zero — a capability is not done until a person can reach it

This is the standard every other one serves. Nessie's recurring failure is not
missing features; it is finished features nobody can get to, and screens padded
with data that answers no question. A project's documents existed for months but
were not *in* the project. Run timing, scheduled triggers, the audit-chain
verifier, the whole execution-runner subsystem — all shipped, none reachable
from anywhere in the UI. That work counts as unfinished.

Four checks, applied to every change that adds or alters a capability:

1. **Name the home and the doorways.** Every capability has one owning surface
   *and* at least one in-context entry point on the screen where a person is
   standing when the question arises — a link, a badge, an inline row, a tab. If
   you cannot name both in the same turn, the feature is not finished. One page
   that nobody has a reason to open is not a surface.
2. **Scope by entitlement, never by ambient context.** Show what the caller is
   allowed to see, decided by the access rules. Do not narrow a list by whatever
   the session claim happens to say — a session's project/team is an accident of
   how the account was created, not a statement about what the person may read.
   Narrowing is an explicit filter the caller asks for, never a silent default.
   (This exact mistake hid people's own documents and made the admin seed
   duplicate spaces beside the real ones.)
3. **Every element names the decision it drives.** If you cannot say which
   decision or action a number, row, or chip enables, cut it. Prefer a short
   screen that is all signal. Owner-only operational telemetry never appears on
   a member-facing surface, and customer billing never renders beside local
   ops telemetry (see the `/tokens` vs `/ops/usage` split).
4. **Reuse the surface; never fork it.** When the same thing must appear in two
   places, it is one component parameterised by scope — as the project Docs tab
   reuses the knowledge workspace. A second implementation of the same view is a
   defect, not a feature.

A new server capability ships with its surface in the same change, or with a
deliberate, written decision that it is machine-only. "The API exists" is not a
delivery.

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
- Prisma migration folders under `api/prisma/migrations/` are immutable once committed: never rename, renumber, delete, or edit one. `pnpm lint:migrations` (part of root `pnpm lint`) enforces this against the merge-base and warns on non-`CONCURRENTLY` index creation on `messages`/`task_events`/`runs`/`audit_logs`. The `upgrade-path` CI job restores the checked-in baseline fixture (`api/prisma/upgrade-fixtures/baseline.sql.gz`, regenerable via `scripts/generate-upgrade-fixture.mjs`) and proves `prisma migrate deploy` from HEAD converges it; see `docs/deployment.md` "Supported upgrade paths".
- After every server start/restart, verify it is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.
- Run package tests through Turbo (`pnpm test`, or `pnpm exec turbo run test --filter=<pkg>`), not `pnpm --filter <pkg> test`. Tests import sibling packages through their `dist` exports, so only the Turbo path guarantees the `^build` that CI's "Build shared packages" step performs. Invoked directly, a package's tests run against whatever `packages/*/dist` happens to be on disk, and a missing build surfaces as `ERR_MODULE_NOT_FOUND` rather than a test failure.
- **Export `DATABASE_URL` for that Turbo run, or the database suites do nothing.** Turbo runs in strict env mode, so a task only sees variables it declares; the `test` task declares `DATABASE_URL` (and `NESSIE_TEST_PRISTINE_DATABASE`) in `turbo.json` for exactly this reason. Every Postgres-backed suite gates on `process.env.DATABASE_URL ? test : test.skip`, so with the variable unset they report `# SKIP` and the run is green with zero database coverage — 47 skipped in `@nessie/api` alone. The `test` task is also `"cache": false`: its result depends on a database Turbo cannot hash, so replaying a cached pass over a database that has since been reset or re-pointed would be a false green.
- **`@nessie/api#test` is ordered after `@nessie/worker#test` in `turbo.json`, deliberately.** Plain `test` depends only on `^build`, so Turbo — unlike topological `pnpm -r` — would otherwise run both packages' database suites at once against the one database. `worker/test/db` drives the global queue pollers and refuses to start on a database holding rows they would claim, while api's trigger-dispatch suites legitimately pass through exactly that state; one orphaned `(agent, thread)` pending pair held open fails all four worker DB tests. Do not remove the ordering to reclaim the few seconds of parallelism.
- `node --test` forks **one child process per test file** (~77 MB each), and Turbo runs up to 10 package tasks at once, so a whole-repo `pnpm test` over 295 test files can hold ~100 concurrent node processes — several GB, enough to push a developer machine into swap. Pure unit suites should therefore set `--experimental-test-isolation=none` (Node 22.8+, so it is safe on CI's Node 22) to run every file in a single process, as `@nessie/admin` does. Only use it where files share no process-level state — suites that touch Postgres or mutate module state need the default `process` isolation; cap those with `--test-concurrency` instead.
- A test file reported as failed with only `'test failed'` and no assertion output is node's message for a **child process that exited non-zero or was killed by a signal** — commonly the OS reclaiming memory, not a real test failure. Re-run with `--test-reporter=tap`, which prints that child's `exitCode`/`signal`.
- **Postgres-backed suites share one database and run concurrently.** `node --test` runs files within a package in parallel, so a DB-backed test is never alone — several api suites create and delete organizations at the same time. Cross-package overlap depends on how the suites are invoked: CI's `pnpm -r --if-present test` is topological and `@nessie/api` depends on `@nessie/worker`, so worker finishes before api starts (an accident of the dependency graph — do not rely on it), and `turbo run test` reproduces that order only because `turbo.json` pins `@nessie/api#test` behind `@nessie/worker#test` by hand. Running the two packages' test scripts in parallel yourself still overlaps them, and so does any *new* database suite added to a third package — `packages/runtime` and `packages/memory` already have some, and they are safe only because they create no rows the global pollers claim. Under any of them:
  - **Never write a global mutation.** `DELETE FROM queue_jobs WHERE idempotency_key LIKE 'run:batch:%'` matches every suite's jobs, not the caller's — it deletes a row another suite is about to count. Scope cleanup to the seed (every `run.execute` payload carries a top-level `threadId`: `DELETE FROM queue_jobs WHERE payload->>'threadId' = $1`).
  - **Never assert a global count.** `sweepPendingThreadMessages` drains every orphaned `(agent, thread)` pair in the database and `dispatchNextMailboxMessage` claims the globally oldest queued mailbox row; neither takes a tenant filter. Assert the seed's own outcome instead of the poller's return value.
  - **Never *depend* on a globally-scoped production lookup either.** Asserting on the global scope is only half of it: a test also breaks when the code under test reads it. `resolveUoaWorkspaceContext` resolves "the shared organization" as the globally oldest `Organization` row (right in production — one org, never deleted; unstable in a test database where a dozen suites create and delete organizations). A suite that seeds its own organization still gets a *foreign* one back, and dies on a foreign-key violation the moment that suite's cleanup deletes it. Make the lookup resolve the seed deterministically — `api/test/workspace-context-postgres-race.test.ts` anchors its organization's `createdAt` to the epoch, behind anything a concurrent suite can create — and assert that it did, so the precondition is stated rather than assumed.
  - **A suite that drives a global poller needs an exclusive database.** Unique per-suite ids are not enough — a foreign `queued` mailbox row is claimed ahead of the suite's own. Those suites live in `worker/test/db/`, run via `pnpm --filter @nessie/worker test:db` with `--test-concurrency=1` (one file at a time), and call `assertGlobalQueuesQuiet` first, which fails fast with an actionable message rather than dispatching a real database's mail. `test:unit` globs `test/*.test.ts`, so the directory itself is the split.
  - **Timestamps are `timestamp(3)` and Postgres *rounds* into them.** Back-to-back inserts tie on `created_at` (5 rapid inserts typically record ~3 distinct values), so a test that asserts an exact arrival order must set the order explicitly rather than race the clock. Rounding also puts a just-inserted `visible_at` up to ~0.5 ms in the *future* versus full-precision `now()`, so a row can be briefly invisible to a `visible_at <= now()` poller — real pollers loop, single-shot tests must seed an explicitly past `visibleAt`.
- Mock-LLM harness: deterministic scripted inference for tests lives in `@nessie/mock-llm` (`packages/mock-llm`, scenario JSON + in-process `runInference` adapter + OpenAI-compatible HTTP server). `pnpm --filter @nessie/worker test:smoke` runs the full-pipeline CI smoke (seeded Postgres → enqueue → loop → tool call → completion); `pnpm --filter @nessie/worker test:load --runs N --workers W` runs the load mode. See `docs/mock-llm-harness.md`.

## Natural-language intent is model-judged — never string-matched

- Never detect user intent, addressing, relevance, sentiment, or meaning by
  string comparison, keyword lists, regexes, or phrase heuristics against
  message content. Understanding what a message means is always the model's
  job, so behaviour is natural and works in any language, with slang,
  misspellings, and informal phrasing.
- Deterministic code may act only on **structural facts** that require no
  interpretation of content: explicit @mention entities (structured
  references), channel membership/bindings/roles, message authorship (human
  vs agent) and type, budgets/cooldowns/rate limits, and run invariants.
- No "looks like a question" checks, no trigger-word lists, no language
  detection branches. Agent-facing replies and notices follow the user's
  language because the model infers it, not because code detects it.
- Test fixtures for engagement/intent paths must include non-English, slang,
  and misspelled inputs.

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

- Every UI change must be visually verified using Playwright before considering the work complete.
- Use Playwright (`mcp__plugin_playwright`, or a local Playwright script) to load `http://localhost:5455/<path>`, screenshot the affected page, and confirm the feature renders correctly.
- Always run Playwright headless unless the user explicitly requests otherwise.
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
- **Outbound egress is IP-pinned, not just validated.** Validating a URL and
  then calling plain `fetch` leaves a DNS-rebinding window between the check and
  the socket. Use `@nessie/runtime` `safeFetch` (or `pinnedFetch` when you
  handle redirects yourself) for anything reaching a caller-, operator- or
  model-supplied address: it resolves once, pins the connection to the vetted
  IPs, re-checks each address as it dials, and re-validates every redirect hop.
  `assertSafeUrl` alone is only enough where nothing is fetched afterwards.
  Current callers: MCP OAuth exchange/refresh/discovery/registration, the MCP
  SDK HTTP+SSE transports, FCM `token_uri`, `web_fetch` and `http_fetch`.
  Inference provider `baseUrl` is validated at write time as well as use time.
  See `docs/security-audit-2026-06.md`.
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
  identity is attached. The signed session org/team must exactly match the
  selected team's external UOA mapping; the one per-user/product account link
  proves only stable subject/status/credential epoch, while its active org/team
  fields are non-authoritative last-seen UI metadata. Team enablement derives
  its external tuple from the mapped Team row and is rechecked for every call,
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
  epochs never regress, and first-workspace provisioning is exact-workspace
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
  deployment-wide inference chokepoint; runtime routing rewrites it to Ledger's
  `/v1/:serviceId/*` adapter for the actual OpenAI, Kimi, MiniMax, or custom
  provider, including designer/orchestrator calls; embeddings resolve their own
  `/v1/:serviceId` segment (see "Embeddings" below). If the
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
- Customer tariffs, statements, credits, top-ups, subscriptions, adjustments,
  and Stripe
  lifecycle remain authoritative in UOA. Ledger's raw reporting endpoint is
  UOA-only: Nessie must not hold a metering-reader key, call Ledger's legacy
  billing route, or expose a parallel raw-billing panel. Nessie's product-bound
  Ledger app key is only for its paid inference, DeepWater, Serper, and other
  metered execution calls; UOA independently reads Ledger and supplies the
  customer-facing service/team/user breakdown. The canonical UOA customer
  statement, Checkout, Portal, and
  cancellation preview/confirm use a different, Nessie-only
  `UOA_BILLING_APP_KEY_NESSIE` plus a fresh 45-second RS256 actor assertion
  signed by `UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE`. Both secrets are
  cryptographically validated on the Actions runner, then installed together by
  a dependency-free host script in the main-branch deployment workflow; neither
  may be reused by Ledger or a sibling product. The actor assertion carries the
  signed session's UOA `tv` epoch—not a value recovered from a mutable account
  link—for UOA's online credential-revocation check. Every request resolves the exact
  linked UOA user/org/team, rejects local workspace drift, and lets UOA
  independently recheck billing-manager membership. The public
  protocol is consumed from the MIT-licensed
  `@unlikeotherai/billing-statement-protocol` 1.2.0 package, vendored
  byte-for-byte from UOA commit
  `272e4d95846788f752d1e623d5f69f7c961f1dc5` and protected by a root SHA-256
  verification gate. API validation uses its exported JSON Schemas and the
  admin imports its exported view-model types; local editable copies are
  forbidden. `/schemas/billing-statement-v2.json` is display-ready: Nessie
  renders its plan, markup, line items, totals, and the complete
  connected-service team/origin/user portfolio from one exact Ledger
  `metering-portfolio-v1` `group_by=user` snapshot without rating, aggregation,
  share calculation, or cancellation reasoning. Frozen customer actions remain
  on the version-1 action contract. For actions the API re-fetches the statement,
  accepts only the
  frozen action-id/path pair, verifies its subject, and forwards UOA's
  server-produced body unchanged. Browser-supplied action bodies and return URLs
  are forbidden. Cancellation relays only UOA's opaque short-lived preview
  token, UOA idempotency key, and selected UOA choice; UOA locks and revalidates
  team-wide direct access before confirming. Nessie stores no tariff, Stripe
  customer, subscription, invoice, Price, credit balance, top-up policy,
  payment consent, recurring add-on, statement, or cancellation state. Every
  active exact-team member may read the same UOA-owned team credit account.
  The display leads with remaining credits, then pending/added/used credits,
  connected-service usage, recent activity, and automatic top-up status. UOA
  fixes 1,000 credits to US$1 and returns display-ready values; Nessie never
  converts tokens, raw Ledger units, provider cost, or money into credits.
  Billing managers receive named-user/payment detail and frozen top-up,
  automatic-top-up, and recurring-add-on actions. Ordinary members receive a
  privacy-safe read-only projection with their own usage plus anonymous
  other-member and unattributed totals. Their pending-payment amount and
  funding policy are absent; automatic top-up exposes only UOA's payment-method
  status and directs detailed settings to billing managers. Every mutation
  re-fetches the UOA view,
  validates the exact frozen action, and relays it unchanged.
  `/tokens` is the customer Credits & Billing surface and contains only these
  UOA-authored models. Nessie's owner-only local token, pricing, estimate,
  projection, connector, file, and budget telemetry is isolated at
  `/ops/usage`; it must never be rendered beside customer credits or statements.
  Integrated-product APIs do not query or return local usage summaries.
  A successful direct Nessie SSO exchange confirms `nessie` access through
  UOA's exact `/billing/v1/service-access/confirm` seam before Nessie issues its
  local session; the call is bound to the linked user/org/team and fails login
  closed unless UOA returns `204` with `no-store`. Connector, DeepWater, agent,
  and other indirect execution paths never create this direct-access evidence.
- Builtin `web_search` is a Ledger-only Serper route. Ordinary agent, delegated
  sub-agent, and workflow calls all post to
  `${LEDGER_PUBLIC_URL}/v1/serper/search` with Nessie's product-bound
  `LEDGER_PROXY_TOKEN`, a fresh signed `X-Nessie-Context`, optional linked-user
  `X-UOA-Delegation`, and a stable tool-call id. The context must contain exact
  user/org/team/agent/run provenance; workflow queue identity is checked
  against its durable actor and installation scope before signing. Direct
  `google.serper.dev` calls and `SERPER_API_KEY` fallbacks are forbidden.
  Nessie's local connector rows are operational telemetry only; Ledger is the
  raw usage/cost source and UOA is the sole commercial authority.
- deep.agent crawl web scanning is an MCP connector template: install a Nessie-reachable SSE endpoint (`/mcp/sse`) with bearer auth, then approve/grant the discovered tools. The crawl library implementation belongs behind the deep.agent service boundary; do not embed Crawl4AI's Python package in the API/worker or expose an unauthenticated crawler to the public internet.
- The Individual Communications Connector wires per-user OAuth connections
  (Slack + Gmail live, Microsoft planned) into a normalized `CommsEvent` store
  through the provider-agnostic `@nessie/comms-connect` core and one adapter
  package per provider. Adapters register into the shared registry only via
  `@nessie/comms-providers` (`registerCommsConnectorsFromEnv`), called at API
  and worker startup from `NESSIE_COMMS_*` env; unset providers stay
  unregistered and their jobs park on `ConnectorNotRegisteredError`. Token
  bundles are encrypted in a separate table (never returned to the browser),
  sync is resumable + checkpointed with webhook ingestion through the worker
  queue, and the connector layer carries **no** reasoning logic (Chief-of-Staff
  boundary). The sync worker and subscription-renewal sweep skip any connection
  whose owner is no longer an active org member (`deactivatedAt`), so user
  deactivation revokes comms import immediately — matching the API auth and
  scheduled-trigger owner-revocation gates. Spec:
  `docs/plans/2026-07-21-individual-communications-connector.md`.

## Embeddings — routed separately, one pinned width

- Embeddings are configured independently of chat via `NESSIE_EMBEDDING_*`
  (`PROVIDER`, `MODEL`, `SERVICE_ID`, `BASE_URL`, `API_KEY`); every unset field
  inherits the chat provider, so an unconfigured deployment is byte-identical to
  before. The chat provider may serve no embeddings endpoint at all — Ledger's
  DeepSeek adapter answers `403 embeddings is not allowed for deepseek` — so
  production embeds through `/v1/jina` while chat stays on `/v1/deepseek`.
  Resolution lives in `packages/runtime/src/inference/embedding-provider.ts` and
  is applied once in `createModelClient`; do not fetch embeddings through any
  other path. Signed `X-Nessie-Context` / `X-UOA-Delegation` identity travels
  with the embedding leg only while it stays on the chat host, so a third-party
  embedding endpoint an operator names never receives a delegation assertion.
- **`EMBEDDING_DIMENSIONS` (`packages/schemas/src/embedding.ts`) is the single
  source of truth for the vector width** (currently 1024, `jina-embeddings-v3`'s
  native width). Never write the number anywhere else — not in a producer, a
  validator, a test fixture, or the mock-LLM harness. The three pgvector columns
  (`thoughts.embedding`, `thought_recalls.query_embedding`,
  `knowledge_page_chunks.embedding`) are declared at that width, and every embed
  request sends `dimensions` so a provider answering differently fails loudly.
  Changing the embedding model to another width = edit the constant + one Prisma
  migration re-typing the columns + re-embedding; vectors of different widths are
  not convertible, so the migration nulls them rather than truncating (a
  truncated vector is neither model's output and poisons later comparisons).
- The model that produced a vector is `ModelClient.embeddingModel`, resolved from
  deployment config — not a constant. It is what gets written to
  `embedding_model` and what keys the query-embedding cache, so the two sides of
  a similarity comparison agree by construction rather than by two constants
  happening to match.
- Spec: `docs/deployment.md` "Embedding model and vector width".

## File storage & accounting — single chokepoint

- **All blob file operations** — store, stream, download, delete, version, attachment-linking — MUST go through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes from anywhere else (routes, worker tools, services). Build it once per process from `config.storage`.
- **Storage accounting is part of the file op, not optional.** Every store increments and every delete decrements the `StorageUsageEvent` ledger (signed-byte deltas). This is what keeps per-organization / team / space / uploader usage always known, and it is enforced by the `FileService` so it can never be skipped. Uploads are quota-gated via `Budget.storageLimitBytes`.
- Uploads can be up to `NESSIE_MAX_UPLOAD_BYTES` (default 5 GiB), so file paths must **stream** (never `toBuffer`/`readFile`). `Attachment.sizeBytes` is a `BigInt`; serialize it as a string at API boundaries.
- JPEG/PNG/WebP uploads have EXIF/GPS metadata stripped at the `FileService` store chokepoint (EXIF orientation applied to the pixels first, ICC profiles preserved, accounting records the post-strip size); orgs opt out via `Organization.stripImageMetadata`, and images over 50 MiB or undecodable pass through unchanged to keep uploads streaming.
- **A previewable upload also owns a thumbnail** (`<storageKey>.thumb.webp`), derived at the same chokepoint: inline for raster images, via the `attachment.thumbnail` worker job for PDFs (first page, `@hyzyla/pdfium` — pure WASM, no native deps; AGPL/GPL renderers are disqualified), animated/exotic images, oversized images, and strip opt-outs. It is quota-gated with the original, carries its own `store.thumbnail` / `delete.thumbnail` usage events, and is freed by `FileService.delete` — the single place attachment bytes are removed, so nothing can leak it. Generation failures are never fatal (`thumbnailStatus = unavailable`, clients fall back to the original); existing attachments are not backfilled. Attachment downloads and thumbnails are served with `private, max-age=1y, immutable` + a strong `ETag`, with `If-None-Match` answered as a 304, because attachment bytes are immutable. Spec: `docs/plans/2026-08-06-attachment-thumbnails-and-previews.md`.
- **A run's context window carries its messages' attachments.** Every turn gets an inventory line appended at render time (kept beside `Message.content`, never inside it, so the prompt builder's raw-content comparison still matches), and `user` turns carry inlined image bytes on `ProviderMessage.images`. Bytes come from the same `FileService` chokepoint — original for a PNG/JPEG/WebP/GIF ≤ 4 MiB, else the stored `.thumb.webp`, else nothing — capped at 6 images per prompt (newest first), non-fatal on failure, and estimated for the context window. Whether they reach the wire is the connector's call, gated on its own truthful `supportsVision` (`openai`/`openai-compatible` yes; `deepseek`/`kimi`/`minimax` no, keeping the inventory line). The engagement orchestrator reads the same line so an image-only post can start a run; the judgement itself stays model-made. Logic lives in `worker/src/run/message-attachments.ts` — do not fetch attachment bytes for prompts anywhere else. Spec: `docs/plans/2026-08-07-images-in-agent-context.md`.
- Production storage is S3-compatible (self-hosted MinIO); local dev defaults to `filesystem`. See `docs/deployment.md`.
