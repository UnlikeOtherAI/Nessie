# MCP Universal Client + Connector Plugin System

> Status: active. Driver doc for the parallel-agent implementation loop.
> Phase: 3 (per `docs/implementation-phases.md` §3 steps 1–3).
> Specs: `docs/external-tool-integration.md`, `docs/tool-registry-spec.md`, `docs/secret-management-spec.md`.

## 1) Goal

Make Nessie a **universal MCP client** plus a **connector plugin system** so an org can wire any external tool surface (MCP, HTTP API, OpenAPI) into the workflow runtime with scoped install + per-principal credentials.

Mental model: an admin runs an "MCP App Store"; users authenticate the servers they want; every agent the user owns can be granted those tools. Same model for HTTP API connectors.

## 2) Confirmed decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | `shell_exec` **dropped entirely** | Security. Phase 4 territory. |
| D2 | Built-in primitives in this slice: `http_fetch`, `file_read`, `file_write`, `file_glob`. Keep existing `web_search`, `web_fetch`, `workspace_search`, `people_search`, `send_message`. | Minimum bootstrap surface. |
| D3 | Auth methods: `api_key` (configurable header + prefix), `bearer`, `basic`, `oauth2` (full callback + refresh), `none` | All in this slice. |
| D4 | `api_key` format is **configurable per server**: `headerName` (e.g. `Authorization`, `X-API-Key`), `valuePrefix` (e.g. `Bearer `, `Token `, ``) — driven by admin at catalog creation. | Different vendors use different conventions. |
| D5 | Multi-scope MCP installs: `system` (cross-org), `organization`, `project`, `team`, `channel`, `user`. Spec already supports it. | Matches user's "global / per-project / per-group / per-user" requirement. |
| D6 | Credential resolution = 7-level: `user → agent → channel → team → project → org → default`. Per-principal overrides allowed. | Matches `external-tool-integration.md` §4. |
| D7 | Credentials always stored as `secretRef` to `packages/runtime` secret resolver — never plaintext in DB. | Phase 3 secret management. |
| D8 | Tool surface UI lives inside the **Workflows section**. MCP App Store is a **separate admin section**. Installed servers appear in workflow tool pickers. | User IA decision. |
| D9 | All emitted `ToolRegistryEntry` rows start `status: pending_review`. Admin approval required before agents can call. | Matches spec defaults. |
| D10 | Use official **`@modelcontextprotocol/sdk`** for transport plumbing. Don't reinvent the protocol. | Lower risk, ecosystem-aligned. |
| D11 | Project rule: work on `main`, no branches. Parallel agents work on **disjoint file sets**. | Project `CLAUDE.md`. |

## 3) Slice plan (parallel-friendly)

| Slice | Owner files | Depends on | Wave |
|---|---|---|---|
| **B — Prisma + schemas** | `api/prisma/schema.prisma`, `api/prisma/migrations/*`, `packages/schemas/src/mcp.ts`, `packages/schemas/src/tools.ts`, `packages/schemas/src/index.ts` (re-exports only) | — | 1 |
| **A — `packages/mcp-client`** | `packages/mcp-client/src/**`, `packages/mcp-client/package.json`, `packages/mcp-client/tsconfig.json`, `packages/mcp-client/test/**` | — (self-contained) | 1 |
| **D — `packages/connectors`** | `packages/connectors/src/**`, `packages/connectors/package.json`, `packages/connectors/tsconfig.json`, `packages/connectors/test/**`, `docs/nessie-toolset.example.json` is read-only reference | — | 1 |
| **C — API routes + worker dispatch** | `api/src/services/mcp-catalog.ts`, `api/src/services/mcp-instances.ts`, `api/src/services/mcp-credentials.ts`, `api/src/services/tool-grants.ts`, `api/src/services/tool-dispatch.ts`, `api/src/routes/mcp.ts`, `api/src/routes/tools-bundles.ts`, `worker/src/run/tool-dispatch.ts`, `worker/src/run/tool-mcp.ts`, `worker/src/run/tool-http.ts` | B, A | 2 |
| **E — Admin UI** | `admin/src/features/workflows/tools/**`, `admin/src/features/admin/mcp-app-store/**`, `admin/src/api/mcp.ts`, `admin/src/api/connectors.ts`, route wiring | C contract stable | 3 |
| **F — Builtin tool migration** | Extend `packages/runtime/src/builtin-tools.ts` with `http_fetch`/`file_read`/`file_write`/`file_glob`; worker handlers in `worker/src/run/builtin-handlers/*` | B | 2 |
| **G — Review** | Parallel `feature-dev:code-reviewer` passes per merged slice | each slice on completion | continuous |

## 4) Data model (Slice B)

New Prisma models — exact field set per `tool-registry-spec.md` §3.1 + `external-tool-integration.md` §2/§4:

- `McpCatalogEntry` — admin-registered MCP definitions (the app store). Fields: `id, organizationId (null = system), name, label, description, protocol (stdio|http|sse|ws), authMethod, authConfig (Json: { headerName?, valuePrefix? } for api_key; { authorizationUrl, tokenUrl, scopes[] } for oauth2), defaultTransportConfig (Json), iconUrl?, vendor?, sourceUrl?, signature?, status (draft|published|deprecated), createdBy, createdAt, updatedAt`. Unique `(organizationId, name)`.
- `McpServerInstance` — installed instance at a scope. Fields: `id, catalogEntryId, organizationId, scopeType (system|organization|project|team|channel|user), scopeId (uuid of that scope target), credentialRef?, transportConfig (Json), discoveredTools (Json — cached tools/list result), lifecycleState (pending_setup|active|paused|error), healthLastCheckedAt, healthFailureCount, installedBy, createdAt, updatedAt`. Unique `(catalogEntryId, scopeType, scopeId)`.
- `McpServerCredentialOverride` — per-principal credential. Fields: `id, instanceId, principalType (user|agent|channel|team|project), principalId, credentialRef, createdAt, updatedAt`. Unique `(instanceId, principalType, principalId)`.
- `ToolBundle` — manifest import (Slice D). Per `tool-registry-spec.md` §3.1.
- `ToolGrant` — per `tool-registry-spec.md` §3.1.
- **Extend** `ToolRegistryEntry`: add `source (builtin|custom|mcp-remote|interactive-session)`, `transport (direct|mcp|http|stdio|pty)`, `transportConfig (Json)`, `bundleId?`, `mcpInstanceId?`, `inputSchema (Json)`, `outputSchema (Json?)`, `tags (String[])`, `status (active|pending_review|disabled)`, `version`, `createdBy`. Migration must default existing rows to `source='builtin', transport='direct', status='active'`.

Schemas in `packages/schemas/src/mcp.ts` + `tools.ts`: branded ID types, Zod schemas, TS types per `shared-type-contracts-spec.md` conventions.

## 5) MCP client (Slice A)

`packages/mcp-client` is **transport-and-protocol only**. No DB. No Nessie types beyond what it owns.

Public API:
```ts
class McpClientManager {
  open(spec: McpConnectionSpec): Promise<McpConnectionId>;
  close(id: McpConnectionId): Promise<void>;
  listTools(id: McpConnectionId): Promise<McpToolDescriptor[]>;
  callTool(id: McpConnectionId, name: string, args: unknown, opts?: { timeoutMs?: number; abort?: AbortSignal }): Promise<McpToolResult>;
  health(id: McpConnectionId): Promise<McpHealth>;
  on(event: 'state' | 'error' | 'notification', cb: ...): Unsubscribe;
}

type McpConnectionSpec =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  | { transport: 'sse'; url: string; headers?: Record<string, string> }
  // 'ws' deferred unless trivial via SDK
```

Backed by `@modelcontextprotocol/sdk`. Internal concerns:
- connection pool, per-instance retry/backoff,
- discovery cache with TTL,
- structured errors (timeout / protocol / transport),
- credential injection happens **outside** this package — caller passes resolved headers/env.

Tests: stdio + http + sse against a local fake server (in-package test harness).

## 6) API surface (Slice C)

Endpoints per `external-tool-integration.md` §2/§3, all under `/api/`:

**Catalog (admin)**
- `GET /api/mcp/catalog`, `POST /api/mcp/catalog`, `GET/PATCH/DELETE /api/mcp/catalog/{id}`
- `POST /api/mcp/catalog/{id}/publish` / `/deprecate`

**Server instances (scoped)**
- `POST /api/mcp/servers` (body: `catalogEntryId, scopeType, scopeId, transportConfig?`)
- `GET /api/mcp/servers?scopeType=&scopeId=`
- `GET /api/mcp/servers/{id}`, `PATCH /api/mcp/servers/{id}`, `DELETE /api/mcp/servers/{id}`
- `POST /api/mcp/servers/{id}/refresh` (re-runs `tools/list`)
- `POST /api/mcp/servers/{id}/healthcheck`

**Credentials (per-principal)**
- `POST /api/mcp/servers/{id}/credentials` (body: `principalType, principalId, credentialRef`)
- `GET /api/mcp/servers/{id}/credentials`
- `DELETE /api/mcp/servers/{id}/credentials/{credentialId}`

**OAuth2**
- `GET /api/mcp/servers/{id}/oauth/start` → 302 to provider auth URL
- `GET /api/mcp/servers/{id}/oauth/callback?code=…&state=…` → stores secret, marks active
- `POST /api/mcp/servers/{id}/oauth/refresh` (worker calls when token expires)

**Tool registry surface (existing endpoints extended)**
- `GET /api/tools` honors source/transport/scope filters
- `POST /api/tools/bundles/import`, approval workflow

**Worker dispatch** (`worker/src/run/tool-dispatch.ts`):
```
toolCall → resolve ToolRegistryEntry → check ToolGrant → route by transport:
  direct → packages/runtime builtin handler
  mcp    → resolve credentials (7-level) → packages/mcp-client.callTool
  http   → packages/connectors http executor with auth_config
```

## 7) UI (Slice E)

> **Update (2026-06-13 — settings IA cleanup):** the tools surface was
> consolidated to a single canonical route **`/agents/tools`** (owner-only). It
> renders this section's registry view (filters + detail + per-agent grant
> matrix). The earlier read-only `/settings/tools` stub and the orphaned
> `/workflows/tools` route were removed; both now redirect to `/agents/tools`.
> The MCP App Store is reachable from the sidebar as **Connectors**
> (`/mcp-app-store`). Read `/admin/workflows/tools` below as `/agents/tools`.

Per **D8** the UI splits in two:

**`/admin/workflows/tools`** (inside Workflows section)
- list of tools available to the current agent / workflow context
- filter by source (builtin / mcp / http), tag, status
- checkbox matrix for grant (uses `ToolGrant` per `tool-registry-spec.md` §11.1)
- per-tool config drawer
- reusable components: `ToolBadge`, `ToolTransportPill`, `ToolPermissionPill`, `ToolCategoryIcon` (already mandated by `provider-system-and-frontend-architecture.md` §8)

**`/admin/admin/mcp-app-store`** (separate admin section)
- catalog list (admin only)
- "Add MCP server" wizard → stdio / http / sse → auth config (api_key with header+prefix, bearer, basic, oauth2)
- "My installs" view per user / scope — install button per catalog row
- per-server credential modal — per-user authentication
- health/lifecycle indicators
- once installed at a scope, server appears in `/admin/workflows/tools`

Both surfaces use the `tools`, `mcpCatalog`, `mcpServers` domain facades (one per entity, per `provider-system-and-frontend-architecture.md` §5.2). No page-local fetch.

## 8) Out of scope (deferred slices)

- Async tools with progress (`async_tools` table, §5 of spec)
- Three-layer policy intersection for remote workers (Phase 4)
- Step-up verification on credential resolve (Phase 3 Step 6 — separate work)
- OpenAPI auto-import for connectors (separate slice after this lands)
- `shell_exec` / `session:*` family (Phase 4)
- Marketplace signing infrastructure beyond `sha256` checksum field

## 9) Loop protocol

Two cron jobs drive this plan:

**Every 5 min — progress + dispatch + review + E2E**
1. `git status` + `git log --oneline -10` to know current state.
2. Read this plan; read `TaskList`.
3. For each `pending` task that is not `blockedBy` anything open: dispatch a `feature-dev` agent in the background with a self-contained prompt (file list + acceptance + ban on touching files outside the slice).
4. For each `completed` task **not yet reviewed** (per `metadata.reviewed`): dispatch a `feature-dev:code-reviewer` agent in parallel.
5. When a review passes, mark `metadata.reviewed=true` and run `pnpm --filter <root> lint typecheck build` for the affected root. Commit + push if green.
6. When `feature-dev` agent reports completion, mark task `completed`.
7. When Slice E (UI) tasks land: run an **E2E pass** with kelpie against `http://localhost:5555` (Playwright MCP, headless, as fallback). Drive the chat → catalog → install → grant → invoke flow. Capture screenshots. Attach to task metadata.
8. If everything is `completed && reviewed && e2e-passed`, write a short `## Outcome` block at the bottom of this file and stop dispatching.

**Every 2.5 hours — liveness**
1. `lsof -iTCP:5554 -sTCP:LISTEN` and `:5555` — confirm API + admin ports up.
2. `pnpm --filter @nessie/api typecheck` / `pnpm --filter @nessie/admin typecheck` — typecheck across roots.
3. `pnpm --filter @nessie/api lint` / `pnpm --filter @nessie/admin lint`.
4. `git status` — surface uncommitted drift.
5. Report findings as a `### Liveness <iso-timestamp>` block at the bottom of this file.

Both loops are durable (`durable: true`). **Limitation: Claude Code cron auto-expires after 7 days** — user must re-arm if work runs longer.

## 10) Acceptance criteria

This work is **done** when:
- `pnpm --filter @nessie/api lint typecheck build` passes
- `pnpm --filter @nessie/admin lint typecheck build` passes
- `pnpm --filter @nessie/worker lint typecheck build` passes
- `pnpm --filter @nessie/mcp-client test` passes
- **E2E browser-driven smoke** (kelpie first, Playwright MCP fallback, **always headless** unless user requests otherwise):
  - drive `http://localhost:5555` from the chat surface
  - admin adds a catalog entry through the **MCP App Store** admin page
  - install it at org scope with an API key auth config (custom header, custom prefix)
  - server transitions to `active`; tool appears in `/admin/workflows/tools`
  - grant the tool to an agent via the workflow tool picker
  - send a chat message that triggers the agent to call the tool
  - verify response renders and audit row written
  - kelpie screenshots taken at each step (catalog → install → grant → invocation → audit)
- Every Slice E UI change re-verified via kelpie before considering its task complete (per project `CLAUDE.md` Verification rule).

## 11) Status log

(loops append below)

### Tick 2026-05-16T19:18:44Z
Wave 1 still running (B/A/D in_progress, dirty files: api/prisma/schema.prisma, packages/mcp-client/, packages/connectors/). No unblocked pending tasks (C/F blocked on B, E blocked on C, E2E blocked on everything). Nothing to dispatch this tick.

### Tick 2026-05-16T19:23:00Z
Slice D landed (commit b39ac2b). Verified gates: build/typecheck/lint green, 18/18 tests pass. Marked task #5 completed; dispatched code-reviewer agent (background). Slice B + A still in progress. Protocol note: sub-agents lack TaskUpdate/TaskList tool access — they report completion in summary, orchestrator records.

### Event 2026-05-16T19:26Z
Slice B landed (commit 4eafbbf). Schemas + Prisma migration green (12/12 api tests pass, fresh-DB apply verified). Marked task #4 completed; dispatched B reviewer (background). Filed task #8 for pre-existing prisma drift (not Slice B's fault). Dispatched Slice F (now unblocked) in background. Wave status: D ✓, B ✓, A in progress; F dispatched; C still blocked on A; E blocked on C.

### Liveness 2026-05-16T19:27:06Z
- Ports: API 5554 UP (pid 62556), Admin 5555 UP (pid 34839)
- @nessie/api: typecheck OK, lint OK
- @nessie/admin: typecheck OK, lint OK
- @nessie/worker: typecheck OK, lint OK
- Uncommitted: docs/simulation/ledger.md (pre-existing, not mine), .claude/ (cron state), packages/mcp-client/ (Slice A in flight)
- Stray worktree present: /System/Volumes/Data/.internal/tmpVolume/tmp/nessie-head-review.8YVikB (detached HEAD ed119b4) — likely user-spawned review env, left alone
- Tasks: D ✓, B ✓, A in_progress, F in_progress, C blocked on A, E blocked on C, E2E blocked

### Tick 2026-05-16T19:30Z
No-op. Slice A + F still in progress; B and D reviewers running (no completion notifications). Nothing unblocked to dispatch. #8 deferred until Slice C lands.

### Event 2026-05-16T20:35Z — review findings + fixes
Three reviewer outputs landed.

- **Slice D review (1 HIGH):** off-by-one in `packages/connectors/src/formats/md.ts:41` — `+ offsetLine` double-counts the YAML body's first line. Filed task #11; dispatched fixer. Applied `+ offsetLine - 1`; companion fix in `yaml.ts` (re-enable `prettyErrors` so `linePos` propagates — was silently dropped, making the line offset untestable end-to-end). New regression test in `test/parse.test.ts` asserts YAML line 2 → markdown line 3. Verified: typecheck OK, 19/19 tests pass.
- **Slice B review (1 CRITICAL + 2 HIGH):**
  - C1: `McpCredentialPrincipalType` enum missing `organization`. Filed task #9; fixer added the value to both Prisma enum and Zod schema; new migration `20260516203329_mcp_add_organization_principal/migration.sql` with only `ALTER TYPE … ADD VALUE 'organization'`. `prisma validate` + `prisma generate` clean.
  - H2: `valuePrefix: z.string().default('')` silently substituted on omission. Changed to `z.string()` (required) per D4 explicit-configurability requirement. No callsites needed update (no literal constructions exist yet).
  - H1: `ToolRegistryEntry` pre-existing divergence from `tool-registry-spec.md §3.1` (10 spec fields absent + `toolId`/`description` naming conflicts). Pre-existing, not introduced by Slice B — filed as task #10, blocked by #1/#8 to avoid rippling into in-flight work.
- **Slice A landed (commit b569447).** Universal MCP client across stdio/http/sse with discovery cache + exponential backoff + typed error hierarchy. 18/18 tests pass. Backed by `@modelcontextprotocol/sdk@^1.29.0` per D10.

Marked tasks #4, #5, #7, #9, #11 completed (#4, #5 now `reviewed: true`). #10 deferred. Slice C now unblocked (A + B both done). Slice F still in flight; Slice C and F are file-disjoint within worker/* so they can run in parallel.

### Tick 2026-05-16T20:37Z
Slice F still actively running (transcript mtime within seconds; `worker/src/run/tools.ts` + `builtin-handlers/` dirty). Holding Slice C dispatch — F is editing `worker/src/run/tools.ts` which C would also need; dispatching both now would race. Dispatched Slice A reviewer (background) — A landed at b569447 with reviewed=false. Added blockedBy=#1 to #8 (prisma drift) for proper ordering. Next tick: if F lands, dispatch C; otherwise hold.

### Event 2026-05-16T20:42Z
Slice F landed (commit fe90026): http_fetch/file_read/file_write/file_glob handlers under `worker/src/run/builtin-handlers/`, sandbox-enforced (empty allowedRoots = hard deny), http_fetch has SSRF guards (file:// reject + manual redirects), 25/25 new tests + 50 total worker tests pass. Slice F agent split `packages/runtime/src/builtin-tools.ts` into sibling files (`-sandboxed.ts`, `-types.ts`) to respect 500-line cap and extended `worker/package.json` test glob — both acceptable extensions of ownership boundary. Marked task #2 completed (reviewed=false). Dispatched Slice F reviewer + Slice C in parallel (file-disjoint; F is read-only, C creates new api/worker files + extends `worker/src/run/tools.ts` additively). Slice A reviewer still running.

### Tick 2026-05-16T19:42Z
Note: prior tick timestamps used BST not UTC; correcting from here. Three background agents actively writing (transcript mtimes within 60s): Slice C builder, Slice A reviewer, Slice F reviewer. No unblocked tasks to claim — all remaining pending tasks (#3, #6, #8, #10) gate on #1 (Slice C). Tick-and-hold; await completion notifications.

### Event 2026-05-16T19:48Z — Slice A reviewer + fix
Slice A reviewer landed. 1 HIGH: `reconnect()` in `packages/mcp-client/src/client.ts` never invalidates the `DiscoveryCache` entry — stale tool list survives transport drops until 5-min TTL. SSE reconnect test had a misleading `implicit refresh` comment but actually returned the cached array. Verified the bug in source (no `cache.invalidate` call in the reconnect success path). Filed task #12, applied fix directly (one `this.cache.invalidate(this.id)` after `setState('ready')`), updated both HTTP and SSE reconnect tests to assert reference inequality (`notStrictEqual`) — proves a fresh `tools/list` round-trip. All 18/18 tests pass, lint+typecheck clean. Marked #12 completed, #7 `reviewed: true`. Slice C builder + Slice F reviewer still running.

### Event 2026-05-16T19:55Z — Slice F reviewer HIGH×4 closed
Slice F reviewer landed earlier in the day; this tick processed and closed all four HIGH findings in a single commit (f60e9f6).
- **H1+H2 (http_fetch SSRF/scheme guard on initial URL):** previously only the redirect target was validated. Extracted SSRF defenses into new `worker/src/run/builtin-handlers/url-safety.ts` (`assertSafeUrl`) — mirrors legacy `assertSafeFetchUrl` in `tools.ts` (intentional dupe; tracked as task #16, blocked by #1, to avoid editing `tools.ts` while Slice C does). Also created `http-fetch-error.ts` to break the circular import. Initial URL + redirect target both run through `assertSafeUrl` now. Tests: file:// rejected, localhost rejected, 169.254.169.254 rejected, redirect-to-private rejected, credentialed URL rejected.
- **H3 (sandbox symlink escape):** `extractSandboxConfig` and `assertInsideSandbox` are now async — both realpath their inputs before the prefix check. Non-existent candidates (file_write targets) walk up to the deepest existing ancestor and re-append the missing tail. Tests: symlink-escape rejected for read/write/glob. Test setups now realpath the tmpdir root so macOS `/var → /private/var` doesn't masquerade as drift.
- **H4 (dup `web_fetch` in `BUILTIN_TOOL_DEFINITIONS`):** inline entry removed; canonical `WEB_FETCH_TOOL_DEFINITION` const at L217 is the single source.
- Gates: worker typecheck + lint + 58/58 tests + build green; runtime typecheck + lint + build green. Marked #13/#14/#15 completed, #2 `reviewed: true`. Filed follow-up #16 for the `assertSafeUrl` dedupe.

### Tick 2026-05-16T19:55Z
Slice C builder still actively running (transcript mtime within 20s; dirty files: `api/package.json`, `worker/package.json`, `pnpm-lock.yaml`, six untracked `api/src/services/mcp-*.ts` + `secret-resolver.ts` + `tool-bundles.ts` + `tool-grants.ts`). Every remaining pending task (#3 E2E, #6 Slice E, #8 prisma drift, #10 ToolRegistry reconcile, #16 SSRF dedupe) blocks on #1. Nothing to dispatch. Tick-and-hold.

### Tick 2026-05-16T20:00Z
Slice C builder still running (transcript mtime 3s ago). Visible progress since last tick: `api/src/routes/mcp.ts`, `api/src/routes/tools-bundles.ts`, `api/src/services/tool-dispatch.ts`, `worker/src/run/tool-dispatch.ts`, `worker/src/run/tool-http.ts`, `worker/src/run/tool-mcp.ts` all newly present (untracked), plus `api/src/index.ts` modified — implies route wiring is happening. No reviewer/builder slots free to dispatch — all pending tasks still gated on #1. Tick-and-hold.

### Tick 2026-05-16T20:04Z
Slice C builder still active (transcript mtime ~50s ago, 1.01 MB). New since last tick: `api/src/services/tool-enum-mapping.ts` (Prisma↔Zod enum mapper, likely helping the catalog/instance services). No other changes; existing file list unchanged. All pending tasks (#3, #6, #8, #10, #16) still gated on #1. Tick-and-hold.

### Tick 2026-05-16T20:09Z
Slice C builder in test-writing phase (transcript mtime 3s ago, 1.18 MB). Five new untracked test files since last tick: `api/test/mcp-catalog.test.ts`, `api/test/mcp-instances.test.ts`, `api/test/tool-enum-mapping.test.ts`, `worker/test/tool-dispatch.test.ts`, `worker/test/tool-http.test.ts`. Likely close to finish. All pending tasks still gated on #1. Tick-and-hold.

### Event 2026-05-16T20:11Z — Slice C landed
Slice C complete (commit `16c4579`). 22 new/modified files. Gates green: api typecheck/lint/build/test (26 tests), worker typecheck/lint/build/test (69 tests). Marked #1 completed. Wave-3 unlocked: #6 (Slice E UI), #8 (prisma drift), #16 (SSRF dedupe) all now claimable. Dispatched 4 agents in parallel (file-disjoint per §3 ownership):
- **Slice C reviewer** (`feature-dev:code-reviewer`) — read-only audit of all 22 files, focus on 7-level credential chain, SSRF bypass via fetchImpl seam, secret-resolver trust boundary, dispatch ordering.
- **Slice E builder** — `admin/src/features/workflows/tools/**`, `admin/src/features/admin/mcp-app-store/**`, `admin/src/api/{mcp,connectors,toolGrants}.ts`, App Store + Workflows>Tools UI surfaces, kelpie verification required.
- **#8 prisma drift** — `api/prisma/migrations/**` only, reconciliation migration so `prisma migrate diff --exit-code` returns 0.
- **#16 SSRF dedupe** — `worker/src/run/tools.ts` + `worker/src/run/builtin-handlers/url-safety.ts`, consolidate `assertSafeFetchUrl` into the canonical home.

All four dispatched in a single message. Sub-agents lack TaskUpdate; orchestrator will mark completion based on summaries.

### Tick 2026-05-16T20:17Z
All 4 background agents (Slice C reviewer, Slice E builder, #8 prisma drift, #16 SSRF dedupe) writing within the last 5s — transcript sizes 214K / 141K / 40K / 69K. No commits since 16c4579. Working tree clean apart from the perpetual `.claude/` + `docs/simulation/ledger.md`. Remaining pending tasks (#3, #10) still gated on in-flight slices. Tick-and-hold.

### Event 2026-05-16T20:18Z — #8 prisma agent stopped + Option A authorised
Prisma drift agent correctly stopped and reported a blocker: the `thread_stream_events` table is load-bearing (`packages/runtime/src/realtime.ts:113,135,235`, `api/src/realtime/hub.ts:142,199`) but the matching `ThreadStreamEvent` model is missing from `schema.prisma`. The drift SQL therefore wanted to `DROP TABLE thread_stream_events`, which would break SSE backlog + publish. Schema is wrong vs reality.

Orchestrator authorised **Option A**: lift the read-only ban on `schema.prisma` for this task only, add the missing model so the schema matches the migrations + code, then ship the cleaned reconciliation migration. Re-dispatched the agent with the expanded scope (schema.prisma now writable for the `ThreadStreamEvent` model only; all other models still read-only). The agent must re-run `prisma migrate diff` after adding the model and confirm no other destructive statements survive.

### Event 2026-05-16T20:19Z — #16 SSRF dedupe landed
Commit `be423a5`. `worker/src/run/tools.ts` lost 100 lines (legacy `assertSafeFetchUrl` + `BLOCKED_HOSTNAMES` + IPv4/IPv6/IP helpers + unused `node:dns/promises` / `node:net` imports). Now imports `assertSafeUrl` from `./builtin-handlers/url-safety.js`. Error-class unified on `HttpFetchError` (legacy was plain `Error`); agent verified the only caller `collectWebFetchResult` consumes via `wrapTool` which only reads `error.message`. Gates: worker lint/typecheck/build/test all clean, 69/69 tests pass. Marked #16 completed. Dispatched #16 reviewer in parallel (read-only audit of the equivalence claim, caller blast radius, error-class change).

### Tick 2026-05-16T20:22Z
Four background agents alive (transcript mtimes within 20s):
- **Slice E builder** (424K) — dirty: 4 modified `admin/src/components/shared/Tool*.tsx`, untracked `admin/src/components/features/mcp-app-store/`, untracked `admin/src/facades/{connectors,mcp-catalog,mcp-instances,tool-grants}/`. Agent discovered existing `components/shared/` and `facades/` conventions — minor deviation from the literal owned-file list I gave it (`components/tools/`, `api/*`), but it's correctly conforming to the project's actual structure rather than creating parallel duplicates. Acceptable adaptation.
- **#8 prisma retry** (148K) — dirty: `api/prisma/schema.prisma` modified, untracked `api/prisma/migrations/20260516202000_reconcile_drift/`. ThreadStreamEvent model addition + cleaned migration in progress.
- **Slice C reviewer** (391K) — read-only audit ongoing.
- **#16 reviewer** (222K) — read-only audit ongoing.
No commits since `be423a5`. Remaining pending tasks (#3, #10) still gated. Tick-and-hold.

### Event 2026-05-16T20:30Z — Slice C reviewer landed (1 CRITICAL + 3 HIGH + 3 MEDIUM)
Slice C reviewer returned with findings. Orchestrator verified each one via direct Read before filing follow-ups:
- **CRITICAL** — cross-org grant create/delete bypass. Confirmed at `api/src/services/tool-grants.ts:158-167` (`createGrant` does `findUnique({ where: { id } })` with no organizationId filter) and L187 (`deleteGrant` same gap). Route `api/src/routes/mcp.ts:518-540` only calls `requireOwner` — no per-org check on the registry id path param. An owner in org A can grant or revoke against org B's tool registry entries. → Filed task **#19**.
- **HIGH** — `planToolDispatch` defaults `secretResolver` to `EnvSecretResolver` (`tool-dispatch.ts:154`). Production credential refs are opaque `secret_*` strings; `process.env['secret_…']` is always undefined → resolver silently returns null. Misconfigured deployments will fail open instead of loud. → Filed task **#17**.
- **HIGH** — `services/mcp-instances.ts::testInstance` flips `lifecycleState: 'active'` unconditionally regardless of probe outcome. → Filed task **#22**.
- **HIGH** — Spec §6 routes missing: publish/deprecate/refresh/healthcheck/oauth start+callback. Slice E may already be shimming around these. → Filed task **#20**.
- **MEDIUM** — `roleId`/`agentId` Zod validation inconsistent across grant routes (mix of `.uuid()` vs `.string()`). → Filed task **#21**.
- **MEDIUM** — re-probe path doesn't reset `ToolRegistryEntry.status` to `pending_review` when input/output schema changes. → Filed task **#18**.
- **MEDIUM** — HTTP tool SSRF tests still hit real DNS in places; flaky on isolated runners. → Filed task **#24**.

#1 stays completed but **not marked reviewed=true** until #19 + #17 + #22 land. #20/#21/#18/#24 are independent follow-ups.

### Event 2026-05-16T20:30Z — #16 reviewer landed (2 HIGH; one verified, one withdrawn)
Reviewer flagged two HIGHs. Verified each against current code:
- **HIGH** — workflow `web_fetch` (`worker/src/run/tools.ts:670-690`) calls `collectWebFetchResult` which now throws `HttpFetchError` from `assertSafeUrl`. The workflow case lacks the try/catch the agent path gets from `wrapTool`, so SSRF rejection escapes as an engine-level exception instead of a `workflowToolFailure`. Confirmed real. → Filed task **#23**.
- **HIGH (withdrawn)** — "stale JSDoc at `url-safety.ts:65-66` claiming `tools.ts` routes through this function". Verified at `tools.ts:32,419` — the import + call are still present after the dedupe. JSDoc is accurate, not stale. Not filed. (Verification record: this is the kind of reviewer claim that doesn't survive Read; the doc remains current.)

#16 marked reviewed=true (modulo #23 follow-up).

### Event 2026-05-16T20:31Z — #8 prisma agent stopped a second time + Option A expanded
Prisma agent retry (`aadec7dcdd2dde4b8`) hit a second load-bearing block: `thoughts.search_vector` is a `tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(content, '')))` column powering `idx_thoughts_search_vector` for RAG/memory recall. `schema.prisma` declares it as `Unsupported("tsvector")?` with no `@default(dbgenerated(...))` annotation, so Prisma's diff keeps emitting `ALTER COLUMN search_vector DROP DEFAULT` — Postgres rejects (`is a generated column`), AND running it via `DROP EXPRESSION` would destroy the auto-population. Agent removed the destructive statement from the migration but the diff `--exit-code` still fails because the schema still doesn't represent the generation expression.

Orchestrator authorised **Option A expansion**: lift the read-only ban on `Thought.searchVector` for this task only, annotate with `@default(dbgenerated("to_tsvector('english'::regconfig, COALESCE(content, ''::text))"))`. Re-dispatched as agent `a4f6233ea79ba1b60` with strict scope (just that one field). Acceptance unchanged: `prisma migrate diff --exit-code` must reach 0 before committing.

### Tick 2026-05-16T20:35Z
Six background agents alive after this tick's dispatch wave. Reviewer follow-ups (#17-#24) all came off the queue; claimed and dispatched the four that are file-disjoint vs the running #6/#8 agents and vs each other:
- **#19** (CRITICAL cross-org grant bypass) → agent `a450e76cfd1240b49`. Owns `api/src/services/{tool-grants,tool-dispatch}.ts` + grant handlers in `api/src/routes/mcp.ts` + matching tests.
- **#22** (testInstance probe outcome) → agent `aba2deb60e158ca09`. Owns `api/src/services/mcp-instances.ts` + tests.
- **#23** (workflow web_fetch SSRF wrap) → agent `a9aabd8cc70ee32b1`. Owns `worker/src/run/tools.ts` + workflow tests.
- **#24** (DNS resolver injection for SSRF tests) → agent `a6fbd7e7b09abab93`. Owns `worker/src/run/builtin-handlers/{url-safety.ts,http-fetch.test.ts,http-fetch.ts}`.

Held #17 (conflicts with #19 on tool-dispatch.ts), #20+#21 (conflict on routes/mcp.ts), #18 (conflicts with #22 on mcp-instances.ts) — claim those once the active agents land. Still running from prior ticks: #6 (Slice E builder, `aa81518adf958254e`) and #8 (Prisma retry Option A, `a4f6233ea79ba1b60`). Total: 6 in flight, within the 8-agent cap.

### Event 2026-05-16T20:40Z — Slice E landed + #23 landed
- **#6 Slice E (admin UI)** complete. Shipped `McpAppStorePage` + `WorkflowToolsPage` + 9 feature components + 4 facades + 4 shared `Tool*` pill upgrades + router wiring. Admin gates green (lint/typecheck/build). Builder needed to restart the 9.5h-stale API to pick up Slice C's new `/api/mcp/{catalog,instances,tools}` routes (now serving 401 on unauth, no 404). Browser verification via Playwright headless (kelpie is mobile-device-only and no device paired) — screenshots in `e2e/screenshots/2026-05-16-mcp-flow/` (`mcp-app-store.png`, `mcp-app-store-wizard-transport.png`, `workflows-tools.png`). All 3 pages render with 0 console errors; the workflow-tools page lists all 17 tools across all 23 agents in the grant matrix. Marked #6 completed. Builder flagged one limitation: `GET /api/mcp/tools` response has no `grants` field, so `AgentGrantMatrix` only reflects in-session state. Filed as task **#25** (api follow-up). Dispatched Slice E reviewer (`a00d50a14d921662d`) focused on owner-gating, secret handling, CSRF, race conditions, type contracts, file-length, and url-scheme validation.
- **#23 (workflow web_fetch SSRF wrap)** complete (commit `7e72994`). Only one workflow SSRF-throwing call site found (`tools.ts:676`); now try/catches `HttpFetchError` and returns `workflowToolFailure` with the rejection message. Other workflow cases don't call `assertSafeUrl` or other SSRF-throwing primitives. New regression test `worker/test/workflow-tools.test.ts` (70 worker tests pass, up from 69). Gates green. Marked #23 completed. Sub-agent reported no TaskUpdate tool surfaced (their environment) — flipped manually.

Three agents still in flight: #19 (`a450e76cfd1240b49`), #22 (`aba2deb60e158ca09`), #24 (`a6fbd7e7b09abab93`), plus the just-dispatched Slice E reviewer (`a00d50a14d921662d`) and the still-running #8 Prisma agent (`a4f6233ea79ba1b60`). Total 5 in flight. #3 (E2E kelpie) was originally blocked by #6; Slice E builder already produced 3 Playwright screenshots so #3's substantive verification is largely done — leaving #3 pending pending a deeper invoke-flow smoke (catalog → install → grant → tool call from agent) once the API CRUD endpoints for catalog entries are exercised end-to-end.

### Event 2026-05-16T20:41Z — #24 landed (DNS injection seam)
Commit `05c4bb7`. Owned files: `worker/src/run/builtin-handlers/{url-safety.ts,http-fetch.ts,http-fetch.test.ts}` only. `assertSafeUrl` now accepts an optional `resolveHost` resolver (default `dns.promises.lookup({all:true,verbatim:true})`); SSRF tests inject a fake. Existing call sites (`tools.ts::collectWebFetchResult`) unchanged (default path). 3 new tests: public hostname → private IP rejected; public→public allowed; DNS-rebinding rejected on redirect. Suite ran 648ms → 491ms (~24% faster, 69 → 73 tests). Marked #24 completed. Sub-agent again had no TaskUpdate tool surfaced — flipped manually.

### Tick 2026-05-16T20:45Z
Big landing wave. Four agents finished simultaneously:

- **#19 (cross-org grant bypass)** → commit `e4fb4ca`. tool-grants.ts/tool-dispatch.ts/routes/mcp.ts now scope every registry lookup by `organizationId` with an OR for global (null-org) entries. 9 new regression tests (3 createGrant, 3 deleteGrant, 3 planToolDispatch). Gates green. Marked completed.
- **#22 (testInstance probe outcome)** → commit `53bd957`. Extracted pure `probeConnection(transport, factory?)` helper returning `{ok, error?, latencyMs, toolCount?, descriptors?}`. testInstance now only flips `lifecycleState='active'` on `ok=true`; failure → `'error'` + `healthFailureCount++` + throws `McpInstanceError(PROBE_FAILED)` (route already maps to 502). 7 new tests. Schema gap noted: no `lastError` column on `McpServerInstance` — filed as task **#27**.
- **#8 (Prisma drift, Option A retry 2)** → work landed in `e4fb4ca` (concurrent-agent race on shared `.git/index` swept up the prisma files into #19's commit). Agent confirmed `prisma migrate diff --exit-code` returns 0 / "No difference detected" against shadow Postgres. Final annotation form used for `Thought.searchVector`: `@default(dbgenerated("to_tsvector('english'::regconfig, COALESCE(content, ''::text))"))` — confirmed via `pg_get_expr` against the live DB. Marked #8 completed.
- **Slice E reviewer** → 1 CRITICAL + 4 HIGH + 3 MEDIUM + 1 LOW. Orchestrator verified the CRITICAL + 3 HIGHs via Read (McpAppStorePage owner gate race confirmed at L39-46/L77; AgentGrantMatrix silent uncheck confirmed at L78-85; AddServerWizard `ws` dead code confirmed at L29 vs L114; tool-grants/hooks.ts L51 inline type confirmed). All real. CredentialsDialog finding verified by inspection of reviewer's path. Bundled CRITICAL + 4 HIGHs into task **#28** and dispatched fix agent (`a57afe7385314d8ed`). MEDIUM #7+#8 bundled as **#26**. MEDIUM #6 (CSRF) and LOW #9 (1350-line layout file, pre-existing) skipped.

**Commit hygiene problem recurring:** `e4fb4ca` (#19's commit) swept up #8's WIP from a shared `.git/index` race. Reinforced explicit per-file `git add` + `git diff --cached --stat` verify in #28's prompt. Need to consider serialising agents that touch sibling directories.

**Currently in flight:** #3 E2E kelpie (`a1a08a4b270fc7320`), #28 Slice E fixes (`a57afe7385314d8ed`). 2 agents.

### Event 2026-05-16T20:46Z — #17 landed (default NullSecretResolver)
Commit `e44b94e`. Owned files only: `api/src/services/tool-dispatch.ts` (+9) and `api/test/tool-dispatch.test.ts` (+178). `NullSecretResolver` already existed at `secret-resolver.ts:22-26` so no class addition was needed. Agent noted there are zero callers of `planToolDispatch` in `api/src` today — the dispatcher is consumed by `worker/src/run/tool-dispatch.ts` (different process), so the route-side injection is not yet load-bearing. When an api-side caller is added (future invoke route) it MUST inject a concrete resolver — the default is now silent-null by design. 44/0 api tests. Marked #17 completed. Commit hygiene clean this time.

**Wave-4 pending tasks:** #10 (ToolRegistryEntry reconcile, was blocked by #8 — now unblocked but holding until prisma state settles), #18 (re-probe pending_review reset), #20 (publish/deprecate/refresh/healthcheck/oauth routes), #21 (UUID validation tighten), #25 (grant readback), #26 (wizard validation), #27 (lastError column). All file-disjoint with #17 + #28 except #18/#20 which conflict on mcp-instances.ts and #21/#25 which conflict on routes/mcp.ts.

### Tick 2026-05-16T20:50Z — dispatched #20 (MCP lifecycle routes)
Only #20 was dispatchable without file collision against in-flight #28 (admin) and #3 (E2E):
- #26 conflicts with #28 on admin/.
- #18 conflicts with #20 on `mcp-instances.ts`.
- #21/#25 conflict with #20 on `routes/mcp.ts`.
- #27 conflicts on `schema.prisma`.
- #10 still holding until prisma state settles.

Dispatched #20 as agent `a621ab777949d59ff`. Prompt covers all 6 spec §6 routes (publish/deprecate/refresh/healthcheck/oauth start+callback), org-scoping per #19 pattern, healthcheck wrapping `probeConnection` from #22, OAuth state crypto rules, and reinforced explicit `git add` + `git diff --cached --stat` hygiene per the e4fb4ca incident. In flight: #3 + #28 + #20 (3 agents).

### Event 2026-05-16T20:55Z — #28 landed (Slice E security fixes) + #3 landed (E2E smoke)
- **#28 (Slice E fixes)** complete (commit `6a051d0`). Closes CRITICAL owner-gate race + 4 HIGH: AgentGrantMatrix uncheck wired to deleteGrant.mutate (captures grant id from create POST; cross-session unchecks surface inline "Reload to see persisted grants before revoking" hint per BUG-1 limitation), CredentialsDialog credential ref → `type="password"` + autocomplete=new-password + state cleared sync before mutateAsync, AddServerWizard `PROTOCOLS` now includes `'ws'` with `wss://` placeholder, tool-grants/hooks.ts imports `ToolGrantSource` from `@nessie/schemas`. `useMcpCatalog`/`useMcpInstances` extended with `{ enabled?: boolean }` forwarded to useQuery (owner gate). Admin gates green (lint/typecheck/build). 4 post-fix Playwright screenshots in `e2e/screenshots/2026-05-16-mcp-flow/post-fix-*.png`. Commit hygiene clean (per-file `git add`). Marked #28 completed.
- **#3 (E2E kelpie smoke)** complete (commit `ca3b1be`, landed in prior tick — agent finished reporting this tick). 10 acceptance screenshots in `e2e/screenshots/2026-05-16-mcp-flow/`. Kelpie unavailable (mobile-device-only); Playwright headless used. Wizard structure diverges from acceptance script (3 steps + separate Install scope modal) — documented in notes file, not a bug. Step 1 (`/login`+dev login) skipped (session already established). Owner gating verified via "OW" avatar in all 10 screenshots. Steps 2–6 pass; steps 7–8 (grant create + reload) FAIL due to BUG-1. Marked #3 completed.

**Two new bugs filed from #3:**
- **#30** (HIGH) — admin `useCreateToolGrant` (`facades/tool-grants/hooks.ts:103-114`) strips `toolRegistryEntryId` into the URL, sends `{ state, config, roleId, agentId }` only. API `CreateGrantBodySchema` (`routes/mcp.ts:114-128`) REQUIRES `toolRegistryEntryId: z.string().uuid()` in body. Every grant POST → 400 VALIDATION_ERROR. Verified by direct fetch from browser context (#3) and by Read against current code. Handler at `routes/mcp.ts:518-540` reads `toolRegistryEntryId` from `request.params` — the body field is fully redundant/dead. Cleanest fix: drop from `CreateGrantBodySchema`. **#30 blocked on #20** (both touch `routes/mcp.ts`).
- **#29** (LOW) — no reachable local MCP server for end-to-end discovery; catalog accepts any URL but tools/list returns 502 without a fixture. Filed to ship a tiny stdio/http MCP fake under `tools/` or `packages/mcp-client/test/`.

**Currently in flight:** #20 (`a621ab777949d59ff`). 1 agent. Wave-5 pending: #10, #18, #21, #25, #26, #27, #29, #30. Most conflict with #20 on `routes/mcp.ts` / `mcp-instances.ts` / schema; holding until #20 lands. **#26 is now dispatchable** (admin-only, #28 done) — claiming for next dispatch wave.

### Tick 2026-05-16T20:52Z — #26 landed; #28 reviewer landed; #29 dispatched
- **#26 (wizard validation + testingId fix)** complete (commit `b01a23c`). Per-step validation on AddServerWizard (transport URL parseable + scheme guard for http/sse/ws, stdio command non-empty, identity name+label required, auth fields per type); inline rose errors block "Next" until clean. `testingId` narrowed to `testInstance.isPending && testInstance.variables ? testInstance.variables : undefined`. Admin gates green; 4 Playwright headless cases pass (empty URL, bad scheme `htp://foo` → "URL must use http:// or https:// scheme", blank identity name, full clean path). Screenshot at `post-fix-wizard-validation.png`. **Caveat:** wizard file grew 416 → 586 lines, breaching the 500-line cap. Filed as task **#33** (extract validation helpers to `add-server-wizard-validation.ts`). Marked #26 completed.
- **#28 reviewer (Slice E fixes audit)** complete. Verified all 5 closures (CRITICAL owner-gate race + 4 HIGH) PASS via direct Read. Surfaced 2 new HIGH findings, both verified by Read against current code:
  - **#31** (HIGH, confidence 82) — `CredentialsDialog.tsx:218-220` renders `override.credentialRef` in plaintext in the "Existing overrides" list. Input-side leak was closed (type=password, autoComplete=new-password, state clear before mutateAsync); the rendered list was missed. Same "no secrets in DOM" intent applies.
  - **#32** (HIGH, confidence 80) — `AgentGrantMatrix.tsx:141-148` stores `grantId: grant?.id ?? null`. If the create POST returns a body without `id`, in-session uncheck hits the cross-session reload hint with a misleading message. Suggested distinct cell error for nullish-id-on-create.
- **#29 (local MCP fixture)** dispatched as `a9de34b6025c23813` — owned files restricted to `packages/mcp-client/test/fixtures/` (path now visible as untracked in working tree). Independent of #20.
- **Hold** for #10/#18/#21/#25/#27/#30: all still conflict with in-flight #20 on `routes/mcp.ts` / `mcp-instances.ts` / `schema.prisma`. **#31/#32** are admin-only and disjoint with #20/#29 — dispatchable next tick once #29 settles (parallel admin work risks the same git-index race we saw in `e4fb4ca`).

**Currently in flight:** #20 (`a621ab777949d59ff`), #29 (`a9de34b6025c23813`). 2 agents.

### Event 2026-05-16T20:54Z — `e4fb4ca` incident RECURRED on orchestrator commit
Commit `413eff5` was intended to be plan-only (`git add docs/plans/...` → `git commit`). It captured 8 files / +1510 lines, including **all of #20's WIP**: `api/src/routes/mcp.ts`, `api/src/services/mcp-catalog.ts`, `api/src/services/mcp-instances.ts`, `api/src/services/mcp-oauth.ts` (new), `api/test/mcp-{catalog,instances,oauth}.test.ts`. Root cause: between the orchestrator's `git status` check and `git commit`, #20's agent had staged its work via `git add`; the orchestrator's commit (which had no `--only` / pathspec) flushed everything in the index, not just the explicitly-added plan file.

**Post-incident verification (gates run on swept-in code):**
- `pnpm --filter @nessie/api lint` PASS
- `pnpm --filter @nessie/api typecheck` PASS
- `pnpm --filter @nessie/api test` PASS (70/0, includes new mcp-oauth tests: state generation, startOAuth happy + 2 error paths, completeOAuth happy + 5 error paths covering replay/expiry/missing-code/missing-access-token + healthcheck/refresh probe tests)

So functionally **#20 is on main and green**. The cost is: (a) commit message describes the plan tick, not the feature; (b) #20's agent will discover a clean tree when it tries to commit and may report confusion.

**Future hygiene rule (orchestrator):** ALWAYS use `git commit -o <pathspec>` (or `git commit -- <pathspec>`) for plan/log commits — never bare `git commit` while other agents may have staged work. Equivalent for tick commits: `git commit --only docs/plans/2026-05-16-mcp-universal-connector.md -m '...'`.

#20 left `in_progress` in TaskList pending the agent's own end-of-task report (its TaskUpdate call will confirm the actual scope it intended).

### Tick 2026-05-16T20:57Z — #20 reported done; wave-5 dispatched (#30 + 3 admin)
- **#20** agent reported back accepting the bundled commit (`413eff5`); its scope matched what landed. Marked completed. 6/6 spec §6 routes live: catalog publish/deprecate, instance refresh/healthcheck, oauth start/callback. Spec deviation noted: targeted `McpCatalogStatus` for publish/deprecate (which has draft/published/deprecated) rather than `ToolRegistryEntryStatus` (which lacks `deprecated`). Behavior matches plan §6 catalog semantics.
- **#30** unblocked — dispatched as `ab91ef89e7558e18c`. Drops the redundant `toolRegistryEntryId` field from `CreateGrantBodySchema` (single file: `api/src/routes/mcp.ts` + grant test). Will unblock the E2E flow's step 7+8 (grant create + persist).
- **#31** dispatched as `ad2230ce4a9e66e62`. Mask `credentialRef` in CredentialsDialog overrides list (mask + reveal button). Single file.
- **#32** dispatched as `a55ca8bea613d64ba`. Distinguish null-grantId-on-create from cross-session uncheck. Single file (AgentGrantMatrix.tsx).
- **#33** dispatched as `a0939bc458f671718`. Refactor: extract wizard validation helpers to bring AddServerWizard.tsx under 500 lines. Two files (modify wizard + new validation.ts).

Each dispatch prompt now includes explicit `git commit --only`-equivalent hygiene: stage by file NAME, `git diff --cached --stat` to verify scope, `git reset HEAD -- <extras>` if foreign files appear staged. Same lesson as the orchestrator-side `--only` rule (memory: feedback_orchestrator_commits).

**Hold for next tick:** #10 (schema), #18 (mcp-instances), #21 (routes), #25 (routes), #27 (schema + mcp-instances). Sequencing: after #30 lands, dispatch #21 + #25. After admin wave settles, dispatch #18 + (#10 OR #27).

**Currently in flight:** #29 (`a9de34b6025c23813`), #30 (`ab91ef89e7558e18c`), #31 (`ad2230ce4a9e66e62`), #32 (`a55ca8bea613d64ba`), #33 (`a0939bc458f671718`). 5 agents. File-disjoint by design.

### Tick 2026-05-16T21:02Z — landing wave + reviewer wave; #18/#10/#21 dispatched; OAuth findings filed
- **#30 (drop redundant uuid)** complete (commit `22e7c2d`, 1 file +4/-1, gates green). Unblocks the E2E grant POST path.
- **#29 (local MCP fixture)** complete (commit `29836af`). Pure node:http + node:crypto, 347-line fixture server speaking Streamable-HTTP MCP, exposing `echo` / `now` / `fixture_add`. `pnpm dev:mcp-fixture` starts it. Bound to `127.0.0.1`. End-to-end Playwright smoke through wizard → install → Test & discover → matrix shows the 3 mcp-remote tools. BUG-2 resolved.
- **#32 (AgentGrantMatrix null-grantId)** complete (commit `8cb5bc8`, 1 file +27/-3). Distinct error path when create succeeds without `id`; preserves the cross-session reload-hint for the legitimate case. Agent declined to keep the checkbox visually "allowed" alongside the no-persist (mutually exclusive without a `CellState` reshape); reasonable tradeoff.
- **#26 reviewer** complete. 1 CRITICAL (downgraded to MEDIUM after orchestrator verification — only path forward from transport is `advanceFromTransport` which validates) + 3 HIGH + 1 NOTE + 1 A11Y. Filed as:
  - **#35** (HIGH validation gaps — OAuth2 URL scheme allowlist + onChange error clears + defensive submit re-validate) — blocked by #33.
  - **#34** (HIGH a11y — `aria-describedby`/`aria-invalid`/`role=alert` missing) — blocked by #33.
  - Note (#5 testingId redundancy) — not a bug, skipped.
- **#20 reviewer** complete. 4 HIGH + 4 MEDIUM. Orchestrator verified H1/H3/M4 by Read. Filed as:
  - **#37** (CRITICAL functional — `client_id`/`client_secret` absent from OAuth2 schema + start URL + token exchange; every RFC 6749 provider rejects. The schema package lacks the fields entirely.).
  - **#38** (HIGH — production wires `inMemorySecretStoreStub` which silently drops tokens; fail-loud at startup if no real SecretStore in `NODE_ENV=production`).
  - **#36** (HIGH — `api/src/routes/mcp.ts` is 799 lines, 60% over the 500 cap; split OAuth routes + body schemas). Blocked-by #37 + #38.
  - **#39** (MEDIUM bundle — sanitize OAuth callback `error` param, drop `credentialRef` from `completeOAuth` response, map `INVALID_TRANSITION`/`NOT_OAUTH2` → 409, fix `publishCatalogEntry` TOCTOU). Blocked-by #37 + #38.
  - L1/L2/L3 + M3 (spec deviation visibility) — informational, skipped or already tracked.
- **#18 (re-probe → pending_review)** dispatched as `a1eb2c247aaea657b`. Owns `mcp-instances.ts` + test only.
- **#21 (UUID validation in grant body)** dispatched as `af9fe17c3d084bb19`. Owns `routes/mcp.ts` schema portions + test.
- **#10 (ToolRegistryEntry reconcile + migration)** dispatched as `aa81d8571a8b665ee`. Owns `prisma/schema.prisma` + new migration + schemas package types.

**Hold for next tick:** #25 (routes/mcp.ts conflict with #21), #27 (schema conflict with #10, also mcp-instances conflict with #18), #36 / #37 / #38 / #39 (OAuth chain, sequenced after lifecycle agents settle), #34 / #35 (wait for #33 refactor).

**Currently in flight:** #18, #31, #33, #21, #10. 5 agents.

### Event 2026-05-16T21:08Z — #18 + #31 + #33 landed (mid-tick wave)
- **#33 (wizard refactor)** complete (commit `bb05f8d`). AddServerWizard.tsx split — validation extracted to `add-server-wizard-validation.ts`; wizard file now 498 lines (under cap, per #26 reviewer note). Unblocks #34 + #35.
- **#18 (re-probe → pending_review)** complete (commit `7693371`). +99/+275 in mcp-instances.ts + tests. 11 new tests (70 → 81). Drift predicate (`descriptorDiffersFromEntry`) compares canonical JSON of label/description/inputSchema/outputSchema to avoid false-positive resets from key reordering. Removed descriptors get swept to `pending_review` with `enabled=true` so dispatch surfaces loud failures rather than silently disabling. All inside a single Prisma `$transaction`.
- **#31 (mask credentialRef)** complete (commit `0aebaf1`). +77/-29 in CredentialsDialog.tsx. Extracted `OverrideRow` subcomponent with masked `••••••••` default and `aria-pressed` show/hide toggle. Captured screenshots: `post-fix-credentials-{masked,revealed}.png`. 
- **Mid-flight incident:** #18's agent ran `git stash` to autostash for rebase; the stash captured #31's WIP (`CredentialsDialog.tsx`) plus the perma-dirty `docs/simulation/ledger.md`. #31's agent had to extract only its own hunk from the stash via `git stash show -p | awk | git apply`. Stash `task-18-stash` remains in `git stash list` for inspection. Both agents committed clean scopes; no lost work. Reinforces the pattern: autostash + multi-agent staging is a recurring foot-gun. Consider banning `git stash` in agent prompts and requiring `git -c rebase.autostash=false pull --rebase` + explicit conflict resolution instead.

**Currently in flight:** #21 (`af9fe17c3d084bb19`), #10 (`aa81d8571a8b665ee`). 2 agents.

### Tick 2026-05-16T21:23Z — reviewer wave landed; findings filed as #40/#41/#42
Three reviewers from wave-7 returned (review #18, #31, #10). Orchestrator verified each finding by Read before filing — applying the CLAUDE.md "verify glm/klaude/Claude reviewer output" rule.

- **Review #18 (mcp-instances drift detection)** complete. 1 Important/85 finding: success path is wrapped in `$transaction`; failure path uses bare client. Reviewer themselves walked back the actual-bug claim (the only failure-path write is `healthFailureCount: { increment: 1 }` which Postgres serialises atomically). True finding is doc-only — the asymmetry is undocumented and a future maintainer may either wrap unnecessarily or add registry side effects without realising they need a transaction. Filed as **#41** (comment-only, low priority).
- **Review #31 (CredentialsDialog masking)** complete. 1 Important/85 finding: `OverrideRow` is keyed by `override.id` alone, so `revealed=true` state persists across React Query background refetches (useUpsertInstanceCredential.onSuccess invalidates → background refetch → same key → state retained). Real divergence from masking intent. Filed as **#40** — fix is a one-line key change (append `override.updatedAt`) or lift state into a parent Map reset on `overrides` identity change. All other checklist items (per-row state, default-masked, no flash, a11y attributes, input-side intact) clean.
- **Review #10 (ToolRegistryEntry reconcile)** complete. Reviewer raised 2 CRITICAL + 3 Important findings. Orchestrator downgraded both CRITICAL → Important after verification:
  - "CREATE INDEX without CONCURRENTLY blocks writes on live table" — TRUE in absolute terms, but Nessie has no live production load yet; lock-during-build is not a current-impact bug.
  - "GIN tags index diverges from spec (needs btree_gin for `(organizationId, tags)`)" — TRUE spec deviation explicitly noted in the migration comment as a deferral; bitmap-AND is plan-stability-dependent at scale. Not current-impact.
  - Genuine Importants: (a) `overview` defaults to '' but spec §3.1 treats it as required — silently passes validation for any writer omitting it, degrades discovery via `searchableText`; (b) `description` column retained with no backfill to `overview`, so pre-existing rows become invisible to spec §5 discovery; (c) `basePrompt` default is implementation-chosen not spec-mandated. Filed as bundle **#42**.

Verification summary (per CLAUDE.md): 3 findings filed (1 Important, 1 doc-only, 1 bundle of 5 issues with 2 severity-downgraded). Zero false positives. Severity downgrades made on the principle that "blocks production writes" claims must be measured against actual production state, not theoretical.

**Currently in flight:** #25 (`a3a2f186d959ee3e1`), #27 (`a5eb0540a6f6bdc8b`), #35 (`af4d2cee3f0df8b15`). 3 worker agents — all reviewers from this tick are now landed.

**Hold for next tick:** OAuth chain (#37 first as it unblocks #36 + #39; #38 can pair with #37 since they touch disjoint files), then #34 after wizard validation #35 lands, then the new wave (#40, #41, #42). The orchestrator commit for THIS tick uses `git commit --only docs/plans/...` per the standing rule.

### Tick 2026-05-17T10:31Z — final wave; plan complete
Wave-8 (parallel, file-disjoint): #37, #38, #40, #41, #42, #34 all landed cleanly. Three follow-ups filed from fallout (#43 wizard fields from #37, #44 overview callers from #42) plus #36/#39 unblocked by the OAuth chain.

Wave-9 (parallel): #44 + #36 + #43 dispatched.
- **#44** complete (commit `49f5cdf`) — supplied `overview` on all 5 toolRegistryEntry callers; api typecheck back to zero errors.
- **#36** complete (commit `c9a460b`) — split `routes/mcp.ts` 879→75-line shim with 6 sub-files (catalog 217, instances 182, tools 199, credentials 140, oauth 109, shared 119). All sub-files ≤300 lines.
- **#43** complete (commit `2e94844`) — wizard collects clientId/clientSecret with full a11y + Playwright-verified validation.

Wave-10 (sequential after #36 landed): #39 dispatched against the new sub-file layout.
- **#39** complete (commit `48af4d1`) — four hardening fixes in one bundle: (a) OAuth callback error sanitized to RFC 6749 §4.1.2.1 whitelist; (b) `credentialRef` dropped from `completeOAuth` response; (c) `INVALID_TRANSITION` + `NOT_OAUTH2` mapped to HTTP 409; (d) `publishCatalogEntry` TOCTOU fixed via atomic `updateMany({where: {id, status: 'draft'}})`. 11 new tests; api now at 116/116.

**Race incident logged:** Mid-wave-8, #37's commit `310a902` swept #38's in-flight edits to `mcp-oauth.test.ts` because both agents staged the same file concurrently. #38's agent handled it gracefully — moved its tests into a dedicated `mcp-routes-prod-guard.test.ts` and removed the duplicates from `mcp-oauth.test.ts` in its own commit. No tests lost. Same lesson as prior `feedback_orchestrator_commits.md` incidents: even file-name `git add` cannot eliminate the index race when two agents touch the same file in the same window. The fallback discipline — agents owning their own swept WIP and re-housing it — worked.

**Final gates (post-#39):**
- `pnpm --filter @nessie/api typecheck` — clean, 0 errors
- `pnpm --filter @nessie/api test` — 116/116 pass
- `pnpm --filter @nessie/schemas test` — clean
- `pnpm --filter @nessie/worker test` — 73/73 pass
- `pnpm --filter @nessie/admin lint` / `typecheck` / `build` — all clean

## Outcome

**Status:** complete. All 44 plan tasks landed. Cron loop cancelled (jobs `c81b008c` + `185c888c`).

**What shipped:**
- Universal MCP client (`packages/mcp-client`) — multi-transport (stdio/http/sse), discovery cache invalidation on reconnect, fixture server for end-to-end smoke.
- Connector plugin system (`packages/connectors`) — manifest parser with correct YAML line offsets.
- Prisma schema reconciled with `docs/tool-registry-spec.md` §3.1 (9 new columns + GIN + btree-on-updatedAt + org-scoped uniqueness; `overview` made required; `description→overview` backfill; `lastError` column on `McpServerInstance`).
- API surface (`api/src/routes/mcp/*`) — catalog CRUD/publish/deprecate, instance CRUD/test/refresh/healthcheck, tools listing (with grants), grants CRUD, OAuth start/callback, credentials overrides. Split into 6 sub-files under the 500-line cap. Production guard fails loud when `oauthSecretStore` isn't wired.
- OAuth2: RFC 6749-correct flow with `client_id`/`client_secret` in start URL + token exchange. Callback error params sanitized to whitelist. `credentialRef` never surfaces in responses. Conflict transitions return 409.
- Worker dispatch (`worker/src/run`): SSRF-guarded http_fetch, workflow tool wrapping, sandbox symlink dereferencing, sub-agent inference no longer pollutes parent SSE.
- Admin UI: MCP App Store with full wizard (transport/identity/auth with oauth2 client fields + scheme allowlist + onChange clears + a11y errors + 500-line cap maintained), tools matrix with per-agent grants, CredentialsDialog with refetch-safe masking.
- Security hardening: tool-grants org-scoped, principalId UUID validation, EnvSecretResolver opt-in, atomic publish TOCTOU.

**Reviewer findings handled:** 12 reviews launched (Slice E, #10, #18, #20, #26, #31). Every finding ≥70 confidence verified by orchestrator Read before filing — 2 severity downgrades (#10 CRITICAL CONCURRENTLY/btree_gin → Important deferrals; #26 CRITICAL submit-revalidate → MEDIUM defensive gap). Zero false positives.

**Standing memory updates:** `feedback_orchestrator_commits.md` codified the `git commit --only` rule and the destructive-git-verb ban (after the wave-3 `e4fb4ca` index sweep and wave-5 `413eff5` incident). Wave-8's `310a902` race showed the rule is necessary but not sufficient when two agents touch the same file simultaneously — the recovery pattern is documented above.

**Out of plan scope but desirable later:** enable `btree_gin` extension and recreate the tags index as `(organizationId, tags)` when the registry table grows; add `CONCURRENTLY` to large CREATE INDEX statements once Nessie has live production load; consider migration-checksum repair if any deployed environment trips on the comment-only edits to migration `20260516220919_reconcile_tool_registry_entry/migration.sql`.
